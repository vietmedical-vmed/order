// Edge Function: api
//  POST { action, token, args:[...] }  -> kết quả JSON (giống google.script.run cũ)
//  Xác thực token HMAC (giải mã payload bằng TextDecoder UTF-8 — tránh mojibake tiếng Việt).
//  Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SECRET

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8"); // <- fix UTF-8 (không dùng atob trực tiếp cho payload)

// Map role CHUẨN CHUNG (chữ thường) -> mã nội bộ app Đặt hàng.
// Chấp nhận cả role đã map cũ (am/pm/admin...) để tương thích token cũ.
const ROLE_MAP: Record<string, string> = {
  admin: "ADMIN", manager: "MANAGER",
  area_manager: "AM", sale_manager: "AM", am: "AM",
  product_manager: "PM", pm: "PM",
  purchasing: "PURCHASING",
};
// Chỉ các role này được dùng app Đặt hàng (fail-closed cho token dùng chung).
const ORDER_ROLES = new Set(["ADMIN", "MANAGER", "AM", "PM", "PURCHASING"]);
const DEFAULT_CFG = { k1: 0.4, k2: 0.4, k3: 0.2, so_thang_dat_default: 3 };

// ---------- token ----------
function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function verifyToken(token: string, secret: string): Promise<any> {
  if (!token || token.indexOf(".") < 0) throw new Error("AUTH_REQUIRED");
  const [payloadB64, sig] = token.split(".");
  const expect = await hmacSign(payloadB64, secret);
  if (expect !== sig) throw new Error("AUTH_REQUIRED");
  const payload = JSON.parse(dec.decode(b64urlToBytes(payloadB64))); // UTF-8 decode
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("AUTH_REQUIRED");
  const mapped = ROLE_MAP[String(payload.role || "").toLowerCase()] || "";
  if (!ORDER_ROLES.has(mapped)) throw new Error("Tài khoản không có quyền dùng app Đặt hàng CTCH");
  payload.role = mapped;
  return payload;
}

// ---------- role helpers ----------
const canActAs = (u: any, role: string) => u.role === "ADMIN" || u.role === role;
const canApprove = (u: any) => ["PM", "MANAGER", "ADMIN"].includes(u.role);
const initials = (name: string) =>
  String(name || "").split(" ").filter(Boolean).map((s) => s[0]).slice(-2).join("").toUpperCase();

// ---------- config ----------
// Chuẩn hoá 1 object cấu hình thô (từ app_config hoặc order_config_log) về dạng dùng được.
function normalizeCfg(raw: any) {
  const c = raw || {};
  // Override theo nhóm sản phẩm: { "<nhom_san_pham>": { k1,k2,k3,so_thang_dat } }
  const groups: Record<string, any> = {};
  const gin = (c.groups && typeof c.groups === "object") ? c.groups : {};
  for (const [g, r0] of Object.entries(gin)) {
    if (!g || !r0 || typeof r0 !== "object") continue;
    const e: any = {};
    const r = r0 as any;
    for (const k of ["k1", "k2", "k3"]) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== "") e[k] = Number(r[k]);
    }
    if (r.so_thang_dat !== undefined && r.so_thang_dat !== null && r.so_thang_dat !== "") {
      e.so_thang_dat = Number(r.so_thang_dat);
    }
    if (Object.keys(e).length) groups[g] = e;
  }
  return {
    k1: Number(c.k1 ?? DEFAULT_CFG.k1),
    k2: Number(c.k2 ?? DEFAULT_CFG.k2),
    k3: Number(c.k3 ?? DEFAULT_CFG.k3),
    so_thang_dat_default: Number(c.so_thang_dat_default ?? DEFAULT_CFG.so_thang_dat_default),
    groups,
  };
}

async function getKConfig(supa: SupabaseClient) {
  const { data } = await supa.from("app_config").select("value").eq("key", "goi_y").maybeSingle();
  return normalizeCfg(data?.value);
}

// Cấu hình công thức CÓ HIỆU LỰC tại thời điểm `atTime` (ISO string):
// bản log mới nhất có created_at <= atTime. Nếu chưa có log nào trước thời điểm đó
// (vd đợt cũ tạo trước khi bật tính năng log) -> fallback về cấu hình hiện hành.
async function getConfigAt(supa: SupabaseClient, atTime?: string | null) {
  if (atTime) {
    const { data, error } = await supa
      .from("order_config_log")
      .select("value")
      .eq("cfg_key", "goi_y")
      .lte("created_at", atTime)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data && data.value) return normalizeCfg(data.value);
  }
  return await getKConfig(supa);
}

// Danh sách nhóm sản phẩm (nhom_san_pham) của các vật tư đang được đặt hàng.
async function listOrderGroups(supa: SupabaseClient) {
  const PAGE = 1000;
  const set = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("dm_vat_tu")
      .select("nhom_san_pham")
      .eq("dat_hang", true)
      .order("ma_bravo", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    batch.forEach((v: any) => { if (v.nhom_san_pham) set.add(v.nhom_san_pham); });
    if (batch.length < PAGE) break;
  }
  return Array.from(set).sort();
}

async function audit(supa: SupabaseClient, username: string, action: string, sid = "", detail = "") {
  try {
    await supa.from("audit_log").insert({ username, action, session_id: sid || "", detail: detail || "" });
  } catch (_) { /* ignore */ }
}

// ---------- goi_y + row builder ----------
function buildGoiY(cfg: any, tb_cknt: number, tb_ytd: number, tb_kh_3_thang: number, safety_stock: number, so_thang_dat: number, tong_ton: number) {
  // Gợi ý = (k1·TB CKNT + k2·TB YTD + k3·TB KH 3 tháng) × Số tháng đặt + Safety stock − Tổng tồn
  // 3 số TB đều là SL trung bình/THÁNG ⇒ ×số tháng đặt = nhu cầu kỳ đặt; Safety stock cộng
  // thẳng (không nhân số tháng), rồi trừ tồn hiện có.
  const raw = (cfg.k1 * tb_cknt + cfg.k2 * tb_ytd + cfg.k3 * tb_kh_3_thang) * so_thang_dat + safety_stock;
  return Math.max(0, Math.round(raw - tong_ton));
}

// Cấu hình hiệu lực cho 1 nhóm sản phẩm: override của nhóm (nếu có) đè lên mặc định.
function cfgForGroup(cfg: any, group: string) {
  const g = (cfg.groups && group && cfg.groups[group]) || {};
  return {
    k1: g.k1 ?? cfg.k1,
    k2: g.k2 ?? cfg.k2,
    k3: g.k3 ?? cfg.k3,
    so_thang_dat_default: g.so_thang_dat ?? cfg.so_thang_dat_default,
  };
}

function mergeStock(a: any, b: any) {
  const out: Record<string, any> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || {}, y = b[k] || {};
    const ton_kho = num(x.ton_kho) + num(y.ton_kho);
    const hang_ktv_bv = num(x.hang_ktv_bv) + num(y.hang_ktv_bv);
    const hang_vet_thau = num(x.hang_vet_thau) + num(y.hang_vet_thau);
    const hang_di_duong = num(x.hang_di_duong) + num(y.hang_di_duong);
    out[k] = { ton_kho, hang_ktv_bv, hang_vet_thau, hang_di_duong,
      tong_ton: ton_kho + hang_ktv_bv + hang_di_duong - hang_vet_thau };
  }
  return out;
}
function mergeUsage(a: any, b: any) {
  const out: Record<string, any> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k] || {}, y = b[k] || {};
    const iy = num(x._iy) + num(y._iy);       // tổng SL vật tư cả năm (2 miền)
    const py = num(x._py) + num(y._py);       // tổng SL sản phẩm cả năm (2 miền)
    out[k] = {
      tb_ytd: num(x.tb_ytd) + num(y.tb_ytd),   // SL TB/tháng -> cộng 2 miền
      tb_cknt: num(x.tb_cknt) + num(y.tb_cknt),
      ty_le_sd_pct: py > 0 ? Math.round((iy / py) * 100) : 0,  // %SD -> tính lại từ raw
      _iy: iy, _py: py,
    };
  }
  return out;
}
const num = (v: any) => Number(v || 0);

// Chuẩn hoá scope: "Cột sống Ulrich, Khớp UOC" -> Set{"cột sống ulrich","khớp uoc"}
function parseScope(scope: string): Set<string> {
  return new Set(
    String(scope || "").split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}
const normGroup = (s: string) => String(s || "").trim().toLowerCase();

// Quyền xem/đặt/duyệt hàng theo vai trò:
//  - AM : theo BU  (users.bu  ⋈ dm_vat_tu.bu)            -> toàn bộ nhóm SP của BU đó
//  - PM : theo nhóm SP (users.scope ⋈ dm_vat_tu.nhom_san_pham) -> cả 2 miền
//  - MANAGER / ADMIN: xem tất cả
// Đọc bu/scope trực tiếp từ users để không phụ thuộc token cũ & cập nhật tức thì.
async function getGrants(supa: SupabaseClient, u: any): Promise<{ bu: string; scope: string }> {
  if (u.role === "ADMIN" || u.role === "MANAGER" || u.role === "PURCHASING") return { bu: "", scope: "" };
  const { data } = await supa.from("users").select("bu, scope").eq("username", u.username).maybeSingle();
  return { bu: (data && data.bu) || u.bu || "", scope: (data && data.scope) || u.scope || "" };
}

// Trả predicate lọc theo dòng dm_vat_tu ({ bu, nhom_san_pham }); null = xem tất cả.
function makeVisibleFilter(role: string, grants: { bu: string; scope: string }) {
  if (role === "AM") {
    const set = grants.bu ? parseScope(grants.bu) : null;        // BU (có thể nhiều, phân tách phẩy)
    return set ? (r: any) => set.has(normGroup(r.bu || "")) : null;
  }
  if (role === "PM") {
    const set = grants.scope ? parseScope(grants.scope) : null;  // nhóm sản phẩm
    return set ? (r: any) => set.has(normGroup(r.nhom_san_pham || "")) : null;
  }
  return null;
}

// Danh mục đặt hàng = các dòng dm_vat_tu được ADMIN tích chọn (dat_hang = true).
// Không còn bảng order_catalog — cấu hình trực tiếp trên dm_vat_tu.
async function fetchProducts(supa: SupabaseClient) {
  // Phân trang để không bị chặn ở Max rows (mặc định 1000) nếu >1000 vật tư dat_hang=true
  const PAGE = 1000;
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("dm_vat_tu")
      .select("*")
      .eq("dat_hang", true)
      .order("ma_bravo", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc danh mục: " + error.message);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows.map((v: any) => ({
    ma_bravo: v.ma_bravo,
    code_ncc: v.ma_ncc || "",
    ten_hang_hoa: v.ten_vat_tu || "",
    nhom_hang: v.nhom_san_pham || v.phan_loai_1 || "",   // "nhóm hàng" = nhóm sản phẩm
    phan_loai: v.san_pham || v.phan_loai_2 || "",   // group bảng chi tiết theo sản phẩm
    nhom_san_pham: v.nhom_san_pham || "",   // PM lọc theo nhóm sản phẩm
    bu: v.bu || "",                          // AM lọc theo BU
    muc_do_sd: v.muc_do_sd || "",
    safety_stock: num(v.safety_stock),      // tồn kho an toàn (cấu hình danh mục)
    don_vi: v.don_vi || "",
    gia: num(v.don_gia_thau_moi),
    leadtime_ngay: num(v.leadtime_ngay),    // 0 nếu cột chưa có
    san_pham: v.san_pham || "",             // khoá tra mapping/sale_target
    so_thang_dat: v.so_thang_dat ?? null,   // fallback config default ở loadOrderScreen
  }));
}

// stock.mien / sv.area lưu 'Miền Bắc'/'Miền Nam', app dùng 'MB'/'MN'.
// Khớp cả 2 dạng để đổi convention lúc nào cũng chạy.
function mienVariants(mien: string): string[] {
  if (mien === "MB") return ["MB", "Miền Bắc"];
  if (mien === "MN") return ["MN", "Miền Nam"];
  return [mien];
}

// Chốt cycledate của tồn kho: cycledate mới nhất < ngày mở đợt (ngayMo).
// Không truyền ngayMo -> lấy cycledate mới nhất tuyệt đối của miền (view danh mục / không có đợt).
// Nhờ vậy bảng stock giữ nhiều log mà vẫn tra đúng tồn kho tại thời điểm mở đợt (không bị mất log).
async function resolveStockCycledate(
  supa: SupabaseClient, mien: string, ngayMo?: string | null,
): Promise<string> {
  let q = supa.from("stock").select("cycledate").in("mien", mienVariants(mien))
    .order("cycledate", { ascending: false }).limit(1);
  if (ngayMo) q = q.lt("cycledate", ngayMo);
  const { data } = await q.maybeSingle();
  return data && data.cycledate ? String(data.cycledate) : "";
}

// Tồn kho (DA) + Vét thầu (GU): bảng stock — phân biệt bằng cột warehousetype, SL ở cột quantity.
// Hàng đi đường + Hàng ký gửi: bảng logistics_input (nhập tay từ Excel, tạm thời).
// ngayMo = ngày mở đợt: chốt tồn kho theo cycledate mới nhất < ngày này để không lấy nhầm log mở sau.
async function stockMapFor(supa: SupabaseClient, mien: string, ngayMo?: string | null) {
  // Aggregate DA/GU + logistics ngay trong DB (stock_agg) -> 1 RPC thay cho hàng chục
  // request phân trang. Cycledate hiệu lực được chốt bên trong hàm SQL.
  const { data, error } = await supa.rpc("stock_agg", { p_mien: mien, p_ngaymo: ngayMo ?? null });
  if (error) throw new Error("Đọc stock (stock_agg): " + error.message);

  const buildOne = (rows: any[]) => {
    const map: Record<string, any> = {};
    for (const r of rows) {
      const ton_kho = num(r.ton_kho), hang_vet_thau = num(r.hang_vet_thau);
      const hang_ktv_bv = num(r.hang_ktv_bv), hang_di_duong = num(r.hang_di_duong);
      map[r.ma_bravo] = {
        ton_kho, hang_vet_thau, hang_ktv_bv, hang_di_duong,
        tong_ton: ton_kho + hang_ktv_bv + hang_di_duong - hang_vet_thau,
      };
    }
    return map;
  };

  if (mien === "ALL") {
    const mb: any[] = [], mn: any[] = [];
    for (const r of (data || [])) (r.mien === "MN" ? mn : mb).push(r);
    return mergeStock(buildOne(mb), buildOne(mn));   // ghép 2 miền + tính lại tong_ton
  }
  return buildOne(data || []);
}

// Ngày cycledate mới nhất trong bảng stock (dùng cho chú thích "tồn kho cập nhật đến…").
async function latestCycledate(supa: SupabaseClient): Promise<string> {
  const { data } = await supa
    .from("stock").select("cycledate").order("cycledate", { ascending: false }).limit(1).maybeSingle();
  return data && data.cycledate ? String(data.cycledate).slice(0, 10) : "";
}

// ---------- usage đọc từ bảng sv qua RPC usage_agg ----------
// sv: { month, item_code, quantity, area }  — area = miền ('MB' | 'MN')
// YTD / CKNT (cửa sổ 3 tháng vắt năm) / tổng năm được tính trong SQL (xem usage_agg).
//
// usage_agg trả per (mien, item_code) các tổng THÔ + san_pham; phần chia trung bình /
// %SD / làm tròn giữ nguyên ở JS như logic cũ nên số hiển thị không đổi.
async function usageMapFor(supa: SupabaseClient, mien: string) {
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth() + 1;
  const { data, error } = await supa.rpc("usage_agg", { p_mien: mien, p_y: Y, p_m: M });
  if (error) throw new Error("Đọc sv (usage_agg): " + error.message);
  const ytdMonths = Math.max(0, M - 1);        // 2026-07 -> 6 (T01..T06)

  const buildOne = (rows: any[]) => {
    const perProdYear: Record<string, number> = {};   // %SD: tổng dùng cả năm theo sản phẩm
    for (const r of rows) {
      const sp = r.san_pham || ("__" + r.item_code);
      perProdYear[sp] = (perProdYear[sp] || 0) + num(r.yr);
    }
    const map: Record<string, any> = {};
    for (const r of rows) {
      const sp = r.san_pham || ("__" + r.item_code);
      const py = perProdYear[sp] || 0;
      const year = num(r.yr);
      map[r.item_code] = {
        tb_ytd: ytdMonths > 0 ? Math.round(num(r.ytd) / ytdMonths) : 0,
        tb_cknt: Math.round(num(r.cknt) / 3),
        ty_le_sd_pct: py > 0 ? Math.round((year / py) * 100) : 0,
        _iy: year, _py: py,
      };
    }
    return map;
  };

  if (mien === "ALL") {
    const mb: any[] = [], mn: any[] = [];
    for (const r of (data || [])) (r.mien === "MN" ? mn : mb).push(r);
    return mergeUsage(buildOne(mb), buildOne(mn));   // làm tròn từng miền rồi cộng (như cũ)
  }
  return buildOne(data || []);
}

// ---------- TB KH 3 tháng tiếp theo (từ sale_target + mapping) ----------
// dm_vat_tu KHÔNG có bo_vat_tu; quan hệ vật tư↔bộ nằm ở dm_bo_vat_tu_mapping (khoá = san_pham),
// 1 san_pham có thể thuộc NHIỀU bộ.
//   sumByBo:  { normKey(sale_target.san_pham = tên bộ hoặc tên vật tư lẻ): Σ 3 tháng } theo miền.
//   spBoMap:  { normKey(dm_vat_tu.san_pham): { le, bos:[normKey(bo_vat_tu)] } } (không theo miền).
// TB(san_pham) = ( Σ các bộ chứa nó  Σ 3 tháng coalesce(update,dau_nam) ) / 3.
//   - vật tư lẻ (mapping.bo_vat_tu bắt đầu "Vật tư riêng lẻ"): tra thẳng sale_target theo san_pham.
//   - tính ở mức san_pham; mọi mã bravo cùng san_pham hiển thị cùng số (không xuống mã bravo).
const LE_PREFIX = "vật tư riêng lẻ";

// Chuẩn hoá tên: hoa/thường, gộp khoảng trắng, ép "A - B"/"A -B" -> "a-b".
const normKey = (s: string) =>
  String(s || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, "-");
const isVatTuLe = (bo: string) => normKey(bo).startsWith(LE_PREFIX);

// 3 tháng 'yyyy-mm' tính từ tháng hiện tại theo giờ VN (UTC+7) để không lệch ở biên tháng.
function planMonths3(): string[] {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  let y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0-based
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(y + "-" + String(m + 1).padStart(2, "0"));
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

// { normKey(san_pham): { le, bos } } — 1 san_pham -> nhiều bo_vat_tu. Không theo miền.
type SpBo = { le: boolean; bos: string[] };
async function loadSpBoMap(supa: SupabaseClient): Promise<Record<string, SpBo>> {
  const acc: Record<string, { le: boolean; bos: Set<string> }> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("dm_bo_vat_tu_mapping").select("san_pham, bo_vat_tu")
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc dm_bo_vat_tu_mapping: " + error.message);
    const batch = data || [];
    for (const r of batch) {
      const sp = normKey(r.san_pham);
      if (!sp) continue;
      const e = acc[sp] || (acc[sp] = { le: false, bos: new Set<string>() });
      if (isVatTuLe(r.bo_vat_tu)) e.le = true;      // vật tư lẻ -> tra thẳng theo san_pham
      else e.bos.add(normKey(r.bo_vat_tu));         // bộ thực -> gom để cộng dồn
    }
    if (batch.length < PAGE) break;
  }
  const out: Record<string, SpBo> = {};
  for (const k of Object.keys(acc)) out[k] = { le: acc[k].le, bos: [...acc[k].bos] };
  return out;
}

// { normKey(sale_target.san_pham): Σ 3 tháng } theo miền (CHƯA chia 3).
// sale_target_agg group sẵn theo san_pham THÔ trong DB; JS chuẩn hoá normKey rồi cộng dồn.
// ALL là phép cộng thuần nên gộp thẳng mọi dòng (cả 2 miền) không cần tách.
async function saleTargetSumByBo(supa: SupabaseClient, mien: string): Promise<Record<string, number>> {
  const months = planMonths3();
  const { data, error } = await supa.rpc("sale_target_agg", { p_mien: mien, p_months: months });
  if (error) throw new Error("Đọc sale_target (sale_target_agg): " + error.message);
  const sum: Record<string, number> = {};
  for (const r of (data || [])) {
    const key = normKey(r.san_pham);   // = tên bộ (bộ thực) hoặc tên vật tư lẻ
    if (!key) continue;
    sum[key] = (sum[key] || 0) + num(r.tong);   // gom qua ps/khách hàng, cả 3 tháng & 2 miền
  }
  return sum;
}

// TB KH 3 tháng cho 1 dòng dm_vat_tu (theo san_pham).
function tbKh3Thang(p: any, sumByBo: Record<string, number>, spBoMap: Record<string, SpBo>): number {
  const spKey = normKey(p.san_pham);
  const m = spBoMap[spKey];
  let total = 0;
  if (!m || m.le || m.bos.length === 0) {
    total = sumByBo[spKey] || 0;                       // vật tư lẻ / không có mapping
  } else {
    for (const bo of m.bos) total += (sumByBo[bo] || 0); // cộng dồn các bộ chứa san_pham
  }
  return total / 3;                                    // chia số tháng
}

// ============================ HANDLERS ============================
const H: Record<string, (supa: SupabaseClient, u: any, args: any[]) => Promise<any>> = {

  async getCurrentUser(_supa, u) {
    return { username: u.username, ho_ten: u.ho_ten, role: u.role, mien: u.mien, scope: u.scope || "", initials: initials(u.ho_ten) };
  },

  async logout(supa, u) { await audit(supa, u.username, "LOGOUT"); return { ok: true }; },

  async auditPing() {
    return [{ test: "ok", timestamp: new Date().toISOString(), msg: "Deploy hoạt động" }];
  },

  // Soi TB KH cho 1 vật tư: nhánh lẻ/bộ, danh sách bộ, Σ từng bộ, và TB cuối.
  async debugTbKh(supa, _u, [maBravo, mien]) {
    const mm = mien || "MB";
    const { data: p } = await supa.from("dm_vat_tu")
      .select("ma_bravo, san_pham").eq("ma_bravo", maBravo).maybeSingle();
    if (!p) return { error: "Không thấy ma_bravo=" + maBravo };
    const spBoMap = await loadSpBoMap(supa);
    const sumByBo = await saleTargetSumByBo(supa, mm);
    const spKey = normKey(p.san_pham);
    const m = spBoMap[spKey];
    const detail: Record<string, number> = {};
    if (!m || m.le || m.bos.length === 0) {
      detail[spKey] = sumByBo[spKey] || 0;
    } else {
      for (const bo of m.bos) detail[bo] = sumByBo[bo] || 0;
    }
    return {
      ma_bravo: p.ma_bravo, san_pham: p.san_pham, mien: mm, months: planMonths3(),
      co_trong_mapping: !!m,
      nhanh: (!m || m.le) ? "vật tư lẻ / không mapping" : "bộ",
      cac_bo: m ? m.bos : [],
      tong_theo_bo_3thang: detail,       // Σ 3 tháng của từng khoá đã tra
      tb_kh_3_thang: Math.round(tbKh3Thang(p, sumByBo, spBoMap)),
      so_key_sumByBo: Object.keys(sumByBo).length,
      vai_key_mau: Object.keys(sumByBo).slice(0, 8),
    };
  },

  async getConfig(supa) {
    const cfg = await getKConfig(supa);
    const groups_list = await listOrderGroups(supa);
    return { ...cfg, groups_list };
  },

  async saveConfig(supa, u, [config]) {
    if (u.role !== "ADMIN") throw new Error("Chỉ Admin được sửa cấu hình");
    const c: any = {
      k1: Number(config.k1), k2: Number(config.k2), k3: Number(config.k3),
      so_thang_dat_default: Number(config.so_thang_dat_default || 3),
      groups: {},
    };
    if ([c.k1, c.k2, c.k3].some((x) => isNaN(x))) throw new Error("k1/k2/k3 phải là số");
    if ([c.k1, c.k2, c.k3].some((x) => x < 0)) throw new Error("Hệ số k phải >= 0");
    // Override theo nhóm sản phẩm — chỉ lưu các ô được nhập; validate số & dấu.
    const gin = (config.groups && typeof config.groups === "object") ? config.groups : {};
    for (const [g, raw] of Object.entries(gin) as [string, any][]) {
      if (!g || !raw || typeof raw !== "object") continue;
      const e: any = {};
      for (const k of ["k1", "k2", "k3"]) {
        if (raw[k] === undefined || raw[k] === null || raw[k] === "") continue;
        const n = Number(raw[k]);
        if (isNaN(n) || n < 0) throw new Error(`Hệ số ${k} của nhóm "${g}" không hợp lệ`);
        e[k] = n;
      }
      if (raw.so_thang_dat !== undefined && raw.so_thang_dat !== null && raw.so_thang_dat !== "") {
        const n = Number(raw.so_thang_dat);
        if (isNaN(n) || n < 1) throw new Error(`Số tháng đặt của nhóm "${g}" phải >= 1`);
        e.so_thang_dat = n;
      }
      if (Object.keys(e).length) c.groups[g] = e;
    }
    await supa.from("app_config").upsert({ key: "goi_y", value: c });
    // Ghi log phiên bản cấu hình — áp dụng từ thời điểm này đến khi có bản mới thay thế.
    // Nhờ vậy khi xem lại 1 đợt đặt hàng cũ, Gợi ý dùng đúng công thức tại thời điểm đợt đó.
    // Best-effort: nếu bảng log chưa được tạo (chưa chạy 05_config_log.sql) thì vẫn lưu được cấu hình.
    try {
      await supa.from("order_config_log").insert({ cfg_key: "goi_y", value: c, created_by: u.username });
    } catch (_) { /* ignore — log là phụ, không chặn lưu cấu hình */ }
    await audit(supa, u.username, "SAVE_CONFIG", "", JSON.stringify(c));
    return c;
  },

  // Lịch sử các phiên bản cấu hình công thức (mới nhất trước).
  async listConfigLog(supa, u, [limit]) {
    if (u.role !== "ADMIN") throw new Error("Chỉ Admin được xem lịch sử cấu hình");
    const { data } = await supa
      .from("order_config_log")
      .select("id, value, created_at, created_by")
      .eq("cfg_key", "goi_y")
      .order("created_at", { ascending: false })
      .limit(Math.min(Number(limit) || 50, 200));
    return (data || []).map((r: any) => ({
      id: String(r.id),
      created_at: r.created_at ? new Date(r.created_at).toISOString() : "",
      created_by: r.created_by || "",
      value: normalizeCfg(r.value),
    }));
  },

  async listCatalog(supa, u) {
    if (u.role !== "ADMIN" && u.role !== "PM") throw new Error("Chỉ Admin/PM được xem cấu hình danh mục");
    const cols = "ma_bravo, ma_ncc, ten_vat_tu, nhom_san_pham, phan_loai_1, phan_loai_2, san_pham, don_gia_thau_moi, muc_do_sd, safety_stock, dat_hang";
    // PostgREST giới hạn mỗi request tối đa = Max rows (mặc định 1000) → phải phân trang
    // để lấy đủ toàn bộ dm_vat_tu (>2300 dòng). Order 2 cấp cho phân trang ổn định.
    const PAGE = 1000;
    const all: any[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supa
        .from("dm_vat_tu")
        .select(cols)
        .order("nhom_san_pham", { ascending: true })
        .order("ma_bravo", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      const batch = data || [];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    let out = all.map((v: any) => ({
      ma_bravo: v.ma_bravo,
      code_ncc: v.ma_ncc || "",
      ten_hang: v.ten_vat_tu || "",
      san_pham: v.san_pham || "",
      phan_loai_1: v.phan_loai_1 || "",
      phan_loai_2: v.phan_loai_2 || "",
      nhom_san_pham: v.nhom_san_pham || "",
      gia: num(v.don_gia_thau_moi),
      muc_do_sd: v.muc_do_sd || "",
      safety_stock: num(v.safety_stock),
      dat_hang: v.dat_hang === true,
    }));
    // PM chỉ thấy vật tư thuộc nhóm sản phẩm mình phụ trách (scope).
    if (u.role === "PM") {
      const grants = await getGrants(supa, u);
      const scope = grants.scope ? parseScope(grants.scope) : null;
      out = scope ? out.filter((r) => scope.has(normGroup(r.nhom_san_pham))) : [];
    }
    return out;
  },

  async saveCatalog(supa, u, [changes]) {
    if (u.role !== "ADMIN" && u.role !== "PM") throw new Error("Chỉ Admin/PM được cấu hình danh mục");
    let list = Array.isArray(changes) ? changes : [];
    if (!list.length) return { ok: true, updated: 0 };

    // PM chỉ được thao tác với vật tư thuộc nhóm sản phẩm mình phụ trách.
    if (u.role === "PM") {
      const grants = await getGrants(supa, u);
      const scope = grants.scope ? parseScope(grants.scope) : null;
      if (!scope) throw new Error("Tài khoản PM chưa được gán nhóm sản phẩm (scope)");
      const mas = list.map((c: any) => c && c.ma_bravo).filter(Boolean);
      const grpOf: Record<string, string> = {};
      for (let i = 0; i < mas.length; i += 200) {
        const { data } = await supa.from("dm_vat_tu")
          .select("ma_bravo, nhom_san_pham").in("ma_bravo", mas.slice(i, i + 200));
        (data || []).forEach((v: any) => { grpOf[v.ma_bravo] = normGroup(v.nhom_san_pham); });
      }
      list = list.filter((c: any) => c && scope.has(grpOf[c.ma_bravo] || ""));
      if (!list.length) throw new Error("Không có vật tư nào thuộc nhóm của bạn để lưu");
    }

    // Gom các thay đổi có cùng patch để UPDATE hàng loạt (1 query cho mỗi nhóm patch),
    // thay vì update từng dòng — tránh timeout khi chọn hàng trăm vật tư.
    // muc_do_sd chỉ có ~4 giá trị + dat_hang true/false => tối đa vài nhóm.
    const groups = new Map<string, { patch: any; mas: string[] }>();
    for (const c of list) {
      if (!c || !c.ma_bravo) continue;
      const patch: any = {};
      if (typeof c.dat_hang === "boolean") patch.dat_hang = c.dat_hang;
      if (c.muc_do_sd !== undefined) patch.muc_do_sd = c.muc_do_sd || null;
      if (c.safety_stock !== undefined) {
        let sv = Math.floor(Number(c.safety_stock));
        if (!Number.isFinite(sv) || sv < 0) sv = 0;
        patch.safety_stock = sv;
      }
      if (Object.keys(patch).length === 0) continue;
      const key = JSON.stringify(patch);
      const g = groups.get(key) || { patch, mas: [] };
      g.mas.push(c.ma_bravo);
      groups.set(key, g);
    }

    let updated = 0;
    const CHUNK = 200; // giới hạn độ dài danh sách .in() (tránh URL quá dài)
    for (const { patch, mas } of groups.values()) {
      for (let i = 0; i < mas.length; i += CHUNK) {
        const slice = mas.slice(i, i + CHUNK);
        const { error } = await supa.from("dm_vat_tu").update(patch).in("ma_bravo", slice);
        if (error) throw new Error("Lưu danh mục: " + error.message);
        updated += slice.length;
      }
    }
    await audit(supa, u.username, "CONFIG_CATALOG", "", updated + " vật tư");
    return { ok: true, updated };
  },

  async listSessions(supa, u, [filter]) {
    filter = filter || {};
    let q = supa.from("order_sessions").select("*");
    if (u.role === "AM") q = q.eq("mien", u.mien);
    else if (filter.mien && filter.mien !== "ALL") q = q.eq("mien", filter.mien);
    // Mua hàng chỉ thấy đợt đã được duyệt (APPROVED) hoặc đã chốt (CLOSED).
    if (u.role === "PURCHASING") q = q.in("trang_thai", ["APPROVED", "CLOSED"]);
    if (filter.status && filter.status !== "ALL") q = q.eq("trang_thai", filter.status);
    const { data: sessions } = await q;
    const list = sessions || [];

    const { data: items } = await supa.from("order_items").select("session_id, sl_dat, sl_duyet, sl_dat_hang");
    const stat: Record<string, any> = {};
    (items || []).forEach((it) => {
      const k = it.session_id;
      if (!stat[k]) stat[k] = { sku: 0, sl_dat: 0, sl_duyet: 0, sl_dat_hang: 0, approved_sku: 0, ordered_sku: 0 };
      stat[k].sku++;
      stat[k].sl_dat += num(it.sl_dat);
      if (it.sl_duyet != null) { stat[k].sl_duyet += num(it.sl_duyet); stat[k].approved_sku++; }
      if (it.sl_dat_hang != null) { stat[k].sl_dat_hang += num(it.sl_dat_hang); stat[k].ordered_sku++; }
    });

    const out = list.map((s) => ({
      session_id: String(s.session_id),
      ten_dot: String(s.ten_dot || ""),
      mien: String(s.mien || ""),
      ngay_mo: s.ngay_mo ? new Date(s.ngay_mo).toISOString() : "",
      ngay_dong: s.ngay_dong ? new Date(s.ngay_dong).toISOString() : "",
      trang_thai: String(s.trang_thai || ""),
      tao_boi: String(s.tao_boi || ""),
      ly_do_tu_choi: s.ly_do_tu_choi || "",
      nguoi_tu_choi: s.nguoi_tu_choi || "",
      tu_choi_o_buoc: s.tu_choi_o_buoc || "",
      ngay_yeu_cau: s.ngay_yeu_cau ? new Date(s.ngay_yeu_cau).toISOString() : "",
      ngay_pm_duyet: s.ngay_pm_duyet ? new Date(s.ngay_pm_duyet).toISOString() : "",
      ngay_manager_duyet: s.ngay_manager_duyet ? new Date(s.ngay_manager_duyet).toISOString() : "",
      de_nghi_mua_hang: s.de_nghi_mua_hang || "",
      po: s.po || "",
      stats: stat[s.session_id] || { sku: 0, sl_dat: 0, sl_duyet: 0, sl_dat_hang: 0, approved_sku: 0, ordered_sku: 0 },
    }));
    out.sort((a, b) => +new Date(b.ngay_mo) - +new Date(a.ngay_mo));
    return out;
  },

  async loadOrderScreen(supa, u, [sessionId, mien]) {
    // Phase 1: fetch session-independent data in parallel
    // (san_pham cho %SD nay lay trong usage_agg -> khong con loadSanPhamMap)
    const [sessionRaw, products0, grants, spBoMap] = await Promise.all([
      // Chỉ mở đúng đợt được chỉ định (từ "Quản lý đặt hàng" hoặc sau khi tạo đợt).
      // Khi không truyền sessionId -> KHÔNG auto-chọn đợt: hiển thị "bảng thông tin"
      // (màn chi tiết ở chế độ danh mục, không thuộc đợt nào).
      sessionId
        ? supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle().then(r => r.data || null)
        : Promise.resolve(null),
      fetchProducts(supa),
      getGrants(supa, u),
      loadSpBoMap(supa),
    ]);

    let session: any = sessionRaw;
    if (session && u.role === "AM" && u.mien !== session.mien) session = null;

    // Cấu hình công thức: nếu đang xem 1 đợt -> dùng cấu hình CÓ HIỆU LỰC tại thời điểm mở đợt
    // (theo log), để xem lại đợt cũ đúng công thức. Bảng thông tin (không đợt) -> cấu hình hiện hành.
    const cfg = session ? await getConfigAt(supa, session.ngay_mo) : await getKConfig(supa);

    const visFilter = makeVisibleFilter(u.role, grants);
    let products = visFilter ? products0.filter(visFilter) : products0;
    // AM: nếu cấu hình BU không khớp sản phẩm nào (BU trống/sai lệch dữ liệu) thì hiển thị
    // toàn bộ danh mục thay vì màn trắng "không có SKU". AM vẫn bị giới hạn theo miền
    // qua tồn kho & phạm vi đợt đặt hàng.
    if (u.role === "AM" && visFilter && products.length === 0 && products0.length > 0) {
      products = products0;
    }

    const effMien: string = session ? session.mien : (mien || "");
    const ngayMo: string | null = session ? session.ngay_mo : null;

    // Phase 2: stock/usage/items — parallel (depend on effMien known after Phase 1)
    const itemMap: Record<string, any> = {};
    let stockMap: any = {}, usageMap: any = {}, sumByBo: Record<string, number> = {}, stockAsof = "";

    if (effMien === "MB" || effMien === "MN") {
      const [sm, um, sb, sa, its] = await Promise.all([
        stockMapFor(supa, effMien, ngayMo),
        usageMapFor(supa, effMien),
        saleTargetSumByBo(supa, effMien),
        resolveStockCycledate(supa, effMien, ngayMo),
        session ? supa.from("order_items").select("*").eq("session_id", session.session_id).then(r => r.data || []) : Promise.resolve([]),
      ]);
      stockMap = sm; usageMap = um; sumByBo = sb; stockAsof = sa;
      (its as any[]).forEach((r) => { itemMap[r.ma_bravo] = r; });
    } else if (effMien === "ALL") {
      const [sm, um, sb, sa, its] = await Promise.all([
        stockMapFor(supa, "ALL"),
        usageMapFor(supa, "ALL"),
        saleTargetSumByBo(supa, "ALL"),
        latestCycledate(supa),
        session ? supa.from("order_items").select("*").eq("session_id", session.session_id).then(r => r.data || []) : Promise.resolve([]),
      ]);
      stockMap = sm; usageMap = um; sumByBo = sb; stockAsof = sa;
      (its as any[]).forEach((r) => { itemMap[r.ma_bravo] = r; });
    }

    // 5. build rows

    // 5a. Gợi ý tính ở mức SẢN PHẨM (công thức hệ số k), sau đó phân bổ cho từng mã bravo theo %SD YTD.
    //     Gom theo san_pham: Σ tb_cknt, Σ tb_ytd, Σ tong_ton; tb_kh là số của sản phẩm (chung).
    const spGy: Record<string, { cknt: number; ytd: number; ton: number; kh: number; safety: number; sothang: number; grp: string }> = {};
    for (const p of products) {
      const spk = normKey(p.san_pham);
      if (!spk) continue;
      const us = usageMap[p.ma_bravo] || {};
      const s = stockMap[p.ma_bravo] || {};
      const gcfg = cfgForGroup(cfg, p.nhom_san_pham);   // hệ số/số tháng đặt theo nhóm SP
      const a = spGy[spk] || (spGy[spk] = { cknt: 0, ytd: 0, ton: 0, kh: 0, safety: 0, sothang: 0, grp: p.nhom_san_pham });
      a.cknt += num(us.tb_cknt);
      a.ytd += num(us.tb_ytd);
      a.ton += num(s.tong_ton);
      a.safety += num(p.safety_stock);          // safety stock cộng dồn theo sản phẩm
      a.kh = tbKh3Thang(p, sumByBo, spBoMap);   // mức sản phẩm, mọi mã bravo như nhau
      a.sothang = Math.max(a.sothang, Number(p.so_thang_dat || gcfg.so_thang_dat_default));
    }
    const spGoiY: Record<string, number> = {};
    for (const spk of Object.keys(spGy)) {
      const a = spGy[spk];
      const gcfg = cfgForGroup(cfg, a.grp);
      spGoiY[spk] = buildGoiY(gcfg, a.cknt, a.ytd, a.kh, a.safety, a.sothang, a.ton);
    }

    const rows = products.map((p) => {
      const s = stockMap[p.ma_bravo] || {};
      const us = usageMap[p.ma_bravo] || {};
      const i = itemMap[p.ma_bravo] || {};
      const tb_cknt = num(us.tb_cknt), tb_ytd = num(us.tb_ytd);
      const tb_kh_3_thang = Math.round(tbKh3Thang(p, sumByBo, spBoMap));
      const so_thang_dat = Number(p.so_thang_dat || cfgForGroup(cfg, p.nhom_san_pham).so_thang_dat_default);
      const tong_ton = num(s.tong_ton);
      const ty_le_sd_pct = num(us.ty_le_sd_pct);
      // Gợi ý mã bravo = Gợi ý sản phẩm × %SD YTD của mã bravo đó.
      const goi_y_dat = Math.max(0, Math.round((spGoiY[normKey(p.san_pham)] || 0) * ty_le_sd_pct / 100));
      return {
        ma_bravo: p.ma_bravo, code_ncc: p.code_ncc, ten_hang: p.ten_hang_hoa,
        nhom_hang: p.nhom_hang, phan_loai: p.phan_loai, nhom_san_pham: p.nhom_san_pham,
        muc_do_sd: p.muc_do_sd,
        safety_stock: num(p.safety_stock),
        don_vi: p.don_vi || "", gia: num(p.gia), leadtime_ngay: num(p.leadtime_ngay),
        tb_kh_3_thang, so_thang_dat,
        ton_kho: num(s.ton_kho), hang_ktv_bv: num(s.hang_ktv_bv),
        hang_vet_thau: num(s.hang_vet_thau), hang_di_duong: num(s.hang_di_duong),
        tong_ton,
        tb_cknt, tb_ytd,
        ty_le_sd_pct,
        goi_y_dat,
        sl_dat: i.sl_dat == null ? null : num(i.sl_dat),
        sl_duyet: i.sl_duyet == null ? null : num(i.sl_duyet),
        sl_dat_hang: i.sl_dat_hang == null ? null : num(i.sl_dat_hang),
        ghi_chu_dat: i.ghi_chu_dat || "", ghi_chu_duyet: i.ghi_chu_duyet || "",
        ghi_chu_dat_hang: i.ghi_chu_dat_hang || "", item_id: i.item_id || "",
      };
    });

    let sessionOut: any = null;
    if (session) {
      sessionOut = {
        session_id: session.session_id, ten_dot: session.ten_dot, mien: session.mien,
        ngay_mo: session.ngay_mo ? new Date(session.ngay_mo).toISOString() : "",
        ngay_dong: session.ngay_dong ? new Date(session.ngay_dong).toISOString() : "",
        trang_thai: session.trang_thai, tao_boi: session.tao_boi,
        ly_do_tu_choi: session.ly_do_tu_choi || "",
        nguoi_tu_choi: session.nguoi_tu_choi || "",
        tu_choi_o_buoc: session.tu_choi_o_buoc || "",
        de_nghi_mua_hang: session.de_nghi_mua_hang || "",
        po: session.po || "",
      };
    }
    const action = session ? actionForSession(u, session) : null;

    // Rows đã được lọc theo quyền (AM: BU, PM: nhóm SP) nên đều thuộc phạm vi user.
    rows.forEach((r: any) => { r.editable = true; });

    return {
      user: { username: u.username, ho_ten: u.ho_ten, role: u.role, mien: u.mien, scope: u.scope || "" },
      session: sessionOut, rows, action: action || null, readOnly: !action,
      isCatalogOnly: !session, isAllView: mien === "ALL" && !session,
      stock_asof: (stockAsof || await latestCycledate(supa)).slice(0, 10),
    };
  },

  async createSession(supa, u, [name, mien, ngayDong]) {
    if (u.role === "ADMIN" || u.role === "PM") { /* ok */ }
    else if (u.role === "AM") { if (u.mien !== mien) throw new Error("AM chỉ tạo được đợt cho miền " + u.mien); }
    else throw new Error("Không có quyền tạo đợt");
    const { data, error } = await supa.from("order_sessions").insert({
      ten_dot: name, mien, ngay_dong: ngayDong || null, trang_thai: "DRAFT", tao_boi: u.username,
    }).select().single();
    if (error) throw new Error(error.message);
    await audit(supa, u.username, "CREATE_SESSION", data.session_id, name + " · " + mien);
    return data;
  },

  async createSessionBoth(supa, u, [name, ngayDong]) {
    if (u.role !== "ADMIN" && u.role !== "PM") throw new Error("Chỉ Admin/PM được tạo đợt cho cả 2 miền");
    const mb = await H.createSession(supa, u, [name, "MB", ngayDong]);
    const mn = await H.createSession(supa, u, [name, "MN", ngayDong]);
    return { mb, mn };
  },

  async amConfirm(supa, u, [sessionId, items]) {
    if (!canActAs(u, "AM")) throw new Error("Không có quyền xác nhận (AM)");
    if (u.role === "AM") {
      const { data: s } = await supa.from("order_sessions").select("mien").eq("session_id", sessionId).maybeSingle();
      if (!s) throw new Error("Không tìm thấy đợt");
      if (s.mien !== u.mien) throw new Error("Bạn không phụ trách miền " + s.mien);
    }
    return await saveAndAdvance(supa, u, sessionId, items, ["sl_dat", "ghi_chu_dat"], "DRAFT", "SUBMITTED", "AM_CONFIRM");
  },
  async pmConfirm(supa, u, [sessionId, items]) {
    if (!canActAs(u, "PM")) throw new Error("Không có quyền xác nhận (PM)");
    // PM: chỉ nhận SKU thuộc nhóm sản phẩm trong scope (chặn server-side, đọc scope tươi từ DB)
    let filtered = items;
    if (u.role === "PM") {
      const grants = await getGrants(supa, u);
      if (grants.scope) {
        const scopeSet = parseScope(grants.scope);
        const mas = (items || []).map((it: any) => it.ma_bravo);
        const { data: vt } = await supa.from("dm_vat_tu").select("ma_bravo, nhom_san_pham").in("ma_bravo", mas);
        const grpOf: Record<string, string> = {};
        (vt || []).forEach((v) => { grpOf[v.ma_bravo] = normGroup(v.nhom_san_pham); });
        filtered = (items || []).filter((it: any) => scopeSet.has(grpOf[it.ma_bravo] || ""));
        if (filtered.length === 0) throw new Error("Không có SKU nào thuộc nhóm sản phẩm của bạn để duyệt");
      }
    }
    return await saveAndAdvance(supa, u, sessionId, filtered, ["sl_duyet", "ghi_chu_duyet"], "SUBMITTED", "PM_APPROVED", "PM_CONFIRM");
  },
  async managerApprove(supa, u, [sessionId, items]) {
    if (!canActAs(u, "MANAGER")) throw new Error("Không có quyền phê duyệt (Manager)");
    return await saveAndAdvance(supa, u, sessionId, items, ["sl_dat_hang", "ghi_chu_dat_hang"], "PM_APPROVED", "APPROVED", "MANAGER_APPROVE");
  },

  // Phê duyệt NHANH từ màn Quản lý (không sửa số lượng): tự sao chép cột bước trước rồi đẩy trạng thái.
  //  SUBMITTED   (PM):      sl_duyet    ← sl_dat   → PM_APPROVED
  //  PM_APPROVED (MANAGER): sl_dat_hang ← sl_duyet → APPROVED
  async approveSession(supa, u, [sessionId]) {
    const { data: s } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    const { data: rows } = await supa.from("order_items").select("*").eq("session_id", sessionId);
    const its = rows || [];
    if (s.trang_thai === "SUBMITTED") {
      if (!canActAs(u, "PM")) throw new Error("Không có quyền phê duyệt (PM)");
      const items = its.map((r) => ({ ma_bravo: r.ma_bravo, sl_duyet: num(r.sl_dat), ghi_chu_duyet: r.ghi_chu_duyet || "" }));
      return await saveAndAdvance(supa, u, sessionId, items, ["sl_duyet", "ghi_chu_duyet"], "SUBMITTED", "PM_APPROVED", "PM_APPROVE");
    }
    if (s.trang_thai === "PM_APPROVED") {
      if (!canActAs(u, "MANAGER")) throw new Error("Không có quyền phê duyệt (Manager)");
      const items = its.map((r) => ({ ma_bravo: r.ma_bravo, sl_dat_hang: num(r.sl_duyet), ghi_chu_dat_hang: r.ghi_chu_dat_hang || "" }));
      return await saveAndAdvance(supa, u, sessionId, items, ["sl_dat_hang", "ghi_chu_dat_hang"], "PM_APPROVED", "APPROVED", "MANAGER_APPROVE");
    }
    throw new Error("Đợt đang ở trạng thái " + s.trang_thai + " — không thể phê duyệt");
  },

  // Từ chối: trả đợt về DRAFT cho AM sửa lại; bắt buộc có lý do.
  // Chỉ Manager (bước PM_APPROVED) được từ chối. Đã bỏ luồng PM từ chối AM (SUBMITTED).
  async rejectSession(supa, u, [sessionId, reason]) {
    const { data: s } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    let buoc = "";
    if (s.trang_thai === "PM_APPROVED") { if (!canActAs(u, "MANAGER")) throw new Error("Không có quyền từ chối (Manager)"); buoc = "Manager"; }
    else if (s.trang_thai === "SUBMITTED") throw new Error("Bước PM không còn chức năng từ chối — PM chỉ phê duyệt");
    else throw new Error("Đợt đang ở trạng thái " + s.trang_thai + " — không thể từ chối");
    const lyDo = String(reason || "").trim();
    if (!lyDo) throw new Error("Vui lòng nhập lý do từ chối");
    await supa.from("order_sessions").update({
      trang_thai: "DRAFT", ly_do_tu_choi: lyDo, nguoi_tu_choi: u.username,
      tu_choi_o_buoc: buoc, tu_choi_luc: new Date().toISOString(),
      ngay_pm_duyet: null, ngay_manager_duyet: null,
    }).eq("session_id", sessionId);
    await audit(supa, u.username, "REJECT", sessionId, buoc + ": " + lyDo);
    return { ok: true, newStatus: "DRAFT" };
  },

  // Mua hàng "Đặt hàng": lưu thông tin tracking (Đề nghị mua hàng + PO) cho đợt đã duyệt.
  async recordPurchase(supa, u, [sessionId, dm, po]) {
    if (u.role !== "PURCHASING" && u.role !== "ADMIN") throw new Error("Chỉ Mua hàng/Admin được đặt hàng");
    const { data: s } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    if (s.trang_thai !== "APPROVED" && s.trang_thai !== "CLOSED")
      throw new Error("Chỉ đặt hàng khi đợt đã được duyệt (APPROVED)");
    const deNghi = String(dm || "").trim();
    const poStr = String(po || "").trim();
    if (!deNghi && !poStr) throw new Error("Nhập ít nhất Đề nghị mua hàng hoặc số PO");
    await supa.from("order_sessions").update({
      de_nghi_mua_hang: deNghi, po: poStr,
      nguoi_mua_hang: u.username, ngay_mua_hang: new Date().toISOString(),
    }).eq("session_id", sessionId);
    await audit(supa, u.username, "PURCHASE", sessionId, "DM: " + deNghi + " · PO: " + poStr);
    return { ok: true, de_nghi_mua_hang: deNghi, po: poStr };
  },

  async approveItems(supa, u, [sessionId, approvals]) {
    if (!canApprove(u)) throw new Error("Không có quyền duyệt");
    for (const a of approvals) {
      const patch: any = { updated_by: u.username };
      if (a.sl_duyet != null) patch.sl_duyet = Number(a.sl_duyet);
      if (a.sl_dat_hang != null) patch.sl_dat_hang = Number(a.sl_dat_hang);
      if (a.ghi_chu_duyet != null) patch.ghi_chu_duyet = a.ghi_chu_duyet;
      await supa.from("order_items").update(patch).eq("item_id", a.item_id);
    }
    await audit(supa, u.username, "APPROVE", sessionId, approvals.length + " SKU");
    return { ok: true, count: approvals.length };
  },

  async closeSession(supa, u, [sessionId]) {
    if (!canApprove(u)) throw new Error("Không có quyền chốt đợt");
    await supa.from("order_sessions").update({ trang_thai: "CLOSED" }).eq("session_id", sessionId);
    await audit(supa, u.username, "CLOSE_SESSION", sessionId, "");
    return { ok: true };
  },

  async exportOrderData(supa, u, [sessionId]) {
    const { data: session } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!session) throw new Error("Không tìm thấy đợt");
    if (u.role !== "MANAGER" && u.role !== "ADMIN" && u.role !== "PURCHASING")
      throw new Error("Chỉ Manager/Admin/Mua hàng được xuất file Excel");
    if (session.trang_thai !== "APPROVED" && session.trang_thai !== "CLOSED")
      throw new Error("Chỉ xuất được khi đợt đã được Manager phê duyệt (APPROVED)");

    // Xuất đủ cột như màn Chi tiết → cần tính lại stock/usage/Gợi ý theo đúng logic loadOrderScreen.
    const mienExp = session.mien;
    const ngayMoExp = session.ngay_mo || null;
    const [items, prods, cfg, spBoMap, stockMap, usageMap, sumByBo] = await Promise.all([
      supa.from("order_items").select("*").eq("session_id", sessionId).then((r) => r.data || []),
      fetchProducts(supa),
      getConfigAt(supa, ngayMoExp),   // dùng đúng công thức có hiệu lực khi mở đợt
      loadSpBoMap(supa),
      stockMapFor(supa, mienExp, ngayMoExp),
      usageMapFor(supa, mienExp),
      saleTargetSumByBo(supa, mienExp),
    ]);
    const pMap: Record<string, any> = {}; prods.forEach((p) => pMap[p.ma_bravo] = p);

    // Gợi ý tính ở mức sản phẩm rồi phân bổ theo %SD (giống loadOrderScreen).
    const spGyE: Record<string, any> = {};
    for (const p of prods) {
      const spk = normKey(p.san_pham);
      if (!spk) continue;
      const us = usageMap[p.ma_bravo] || {};
      const s = stockMap[p.ma_bravo] || {};
      const gcfg = cfgForGroup(cfg, p.nhom_san_pham);
      const a = spGyE[spk] || (spGyE[spk] = { cknt: 0, ytd: 0, ton: 0, kh: 0, safety: 0, sothang: 0, grp: p.nhom_san_pham });
      a.cknt += num(us.tb_cknt);
      a.ytd += num(us.tb_ytd);
      a.ton += num(s.tong_ton);
      a.safety += num(p.safety_stock);
      a.kh = tbKh3Thang(p, sumByBo, spBoMap);
      a.sothang = Math.max(a.sothang, Number(p.so_thang_dat || gcfg.so_thang_dat_default));
    }
    const spGoiYE: Record<string, number> = {};
    for (const spk of Object.keys(spGyE)) {
      const a = spGyE[spk];
      spGoiYE[spk] = buildGoiY(cfgForGroup(cfg, a.grp), a.cknt, a.ytd, a.kh, a.safety, a.sothang, a.ton);
    }

    const dmVal = session.de_nghi_mua_hang || "", poVal = session.po || "";
    const rows = (items || []).map((it) => {
      const p = pMap[it.ma_bravo] || {};
      const s = stockMap[it.ma_bravo] || {};
      const us = usageMap[it.ma_bravo] || {};
      const gia = num(p.gia), slDatHang = num(it.sl_dat_hang);
      const ty_le_sd_pct = num(us.ty_le_sd_pct);
      const so_thang_dat = Number(p.so_thang_dat || cfgForGroup(cfg, p.nhom_san_pham).so_thang_dat_default);
      const goi_y_dat = Math.max(0, Math.round((spGoiYE[normKey(p.san_pham)] || 0) * ty_le_sd_pct / 100));
      return {
        ma_bravo: it.ma_bravo, code_ncc: p.code_ncc || "", ten_hang: p.ten_hang_hoa || "",
        nhom_hang: p.nhom_hang || "", phan_loai: p.phan_loai || "", muc_do_sd: p.muc_do_sd || "",
        don_vi: p.don_vi || "", gia,
        ton_kho: num(s.ton_kho), hang_ktv_bv: num(s.hang_ktv_bv), hang_vet_thau: num(s.hang_vet_thau),
        hang_di_duong: num(s.hang_di_duong), tong_ton: num(s.tong_ton),
        ty_le_sd_pct, tb_cknt: num(us.tb_cknt), tb_ytd: num(us.tb_ytd),
        tb_kh_3_thang: Math.round(tbKh3Thang(p, sumByBo, spBoMap)),
        safety_stock: num(p.safety_stock), so_thang_dat, leadtime_ngay: num(p.leadtime_ngay),
        goi_y_dat,
        sl_yeu_cau: num(it.sl_dat), sl_pm_duyet: num(it.sl_duyet), sl_dat_hang: slDatHang,
        de_nghi_mua_hang: dmVal, po: poVal,
        thanh_tien: slDatHang * gia, ghi_chu_dat: it.ghi_chu_dat || "", ghi_chu_duyet: it.ghi_chu_duyet || "",
      };
    });
    await audit(supa, u.username, "EXPORT", sessionId, rows.length + " SKU");
    return { session, rows };
  },

  async loadAuditLog(supa, u, [filter]) {
    filter = filter || {};
    let q = supa.from("audit_log").select("*").order("timestamp", { ascending: false })
      .limit(Math.min(Number(filter.limit) || 200, 200));
    if (u.role === "AM") q = q.eq("username", u.username);
    if (filter.action && filter.action !== "ALL") q = q.eq("action", filter.action);
    if (filter.username) q = q.ilike("username", "%" + filter.username + "%");
    const { data } = await q;
    return (data || []).map((l) => ({
      log_id: String(l.log_id || ""),
      timestamp: l.timestamp ? new Date(l.timestamp).toISOString() : "",
      username: String(l.username || ""), action: String(l.action || ""),
      session_id: String(l.session_id || ""), detail: String(l.detail || ""),
    }));
  },

  async resolveAuditMeta(supa) {
    const { data: users } = await supa.from("users").select("username, ho_va_ten");
    const { data: sessions } = await supa.from("order_sessions").select("session_id, ten_dot, mien");
    const userMap: Record<string, string> = {}, sessMap: Record<string, any> = {};
    (users || []).forEach((u) => { userMap[String(u.username).toLowerCase()] = String(u.ho_va_ten || ""); });
    (sessions || []).forEach((s) => { sessMap[String(s.session_id)] = { ten_dot: s.ten_dot, mien: s.mien }; });
    return { userMap, sessMap };
  },
};

// ---------- workflow helpers ----------
function actionForSession(u: any, session: any) {
  const st = session.trang_thai;
  if (st === "APPROVED" || st === "CLOSED") return null;
  if (st === "DRAFT" && canActAs(u, "AM")) {
    if (u.role === "AM" && u.mien !== session.mien) return null;
    return { code: "AM_CONFIRM", label: u.role === "ADMIN" ? "Xác nhận (thay AM)" : "Xác nhận",
      editField: "sl_dat", editNoteField: "ghi_chu_dat", endpoint: "amConfirm" };
  }
  if (st === "SUBMITTED" && canActAs(u, "PM")) {
    return { code: "PM_CONFIRM", label: u.role === "ADMIN" ? "Xác nhận (thay PM)" : "Xác nhận",
      editField: "sl_duyet", editNoteField: "ghi_chu_duyet", endpoint: "pmConfirm" };
  }
  if (st === "PM_APPROVED" && canActAs(u, "MANAGER")) {
    return { code: "MANAGER_APPROVE", label: u.role === "ADMIN" ? "Phê duyệt (thay Manager)" : "Phê duyệt",
      editField: "sl_dat_hang", editNoteField: "ghi_chu_dat_hang", endpoint: "managerApprove" };
  }
  return null;
}

async function findCurrentSession(supa: SupabaseClient, u: any, mienHint: string) {
  let q = supa.from("order_sessions").select("*");
  if (u.role === "AM") q = q.eq("mien", u.mien);
  else if (mienHint && mienHint !== "ALL") q = q.eq("mien", mienHint);
  const { data } = await q;
  const cands = data || [];
  if (!cands.length) return null;
  const priority: Record<string, string[]> = {
    AM: ["DRAFT", "SUBMITTED", "PM_APPROVED", "APPROVED"],
    PM: ["SUBMITTED", "PM_APPROVED", "DRAFT", "APPROVED"],
    MANAGER: ["PM_APPROVED", "APPROVED", "SUBMITTED", "DRAFT"],
    PURCHASING: ["APPROVED", "CLOSED", "PM_APPROVED", "SUBMITTED", "DRAFT"],
    ADMIN: ["DRAFT", "SUBMITTED", "PM_APPROVED", "APPROVED"],
  };
  const order = priority[u.role] || priority.ADMIN;
  for (const st of order) {
    const m = cands.filter((s) => s.trang_thai === st)
      .sort((a, b) => +new Date(b.ngay_mo) - +new Date(a.ngay_mo))[0];
    if (m) return m;
  }
  return cands.sort((a, b) => +new Date(b.ngay_mo) - +new Date(a.ngay_mo))[0];
}

async function saveAndAdvance(
  supa: SupabaseClient, u: any, sessionId: string, items: any[],
  fields: string[], fromStatus: string, toStatus: string, actionName: string,
) {
  const { data: session } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
  if (!session) throw new Error("Không tìm thấy đợt");
  if (session.trang_thai !== fromStatus)
    throw new Error("Đợt đang ở trạng thái " + session.trang_thai + ", không thể thực hiện " + actionName);

  const { data: existingRows } = await supa.from("order_items").select("*").eq("session_id", sessionId);
  const byMa: Record<string, any> = {}; (existingRows || []).forEach((r) => byMa[r.ma_bravo] = r);

  let created = 0, updated = 0, deleted = 0;
  const slField = fields[0], noteField = fields[1];

  // Chặn phía ghi: chỉ ghi những SKU thuộc phạm vi của user (AM: BU, PM: nhóm SP).
  let workItems = items || [];
  const grants = await getGrants(supa, u);
  const visFilter = makeVisibleFilter(u.role, grants);
  if (visFilter) {
    const mas = [...new Set(workItems.map((it: any) => it.ma_bravo))];
    const info: Record<string, any> = {};
    for (let i = 0; i < mas.length; i += 500) {
      const { data } = await supa.from("dm_vat_tu")
        .select("ma_bravo, bu, nhom_san_pham").in("ma_bravo", mas.slice(i, i + 500));
      (data || []).forEach((r: any) => { info[r.ma_bravo] = r; });
    }
    workItems = workItems.filter((it: any) => info[it.ma_bravo] && visFilter(info[it.ma_bravo]));
  }

  for (const it of workItems) {
    const cur = byMa[it.ma_bravo];
    const sl = num(it[slField]);
    const note = it[noteField] || "";
    if (cur) {
      if (fromStatus === "DRAFT" && sl === 0 && !note) {
        await supa.from("order_items").delete().eq("item_id", cur.item_id); deleted++;
      } else {
        const patch: any = { updated_by: u.username };
        fields.forEach((f) => { if (it[f] !== undefined) patch[f] = it[f]; });
        await supa.from("order_items").update(patch).eq("item_id", cur.item_id); updated++;
      }
    } else if (fromStatus === "DRAFT" && sl > 0) {
      await supa.from("order_items").insert({
        session_id: sessionId, ma_bravo: it.ma_bravo, sl_dat: sl, ghi_chu_dat: note, updated_by: u.username,
      }); created++;
    }
  }

  const sessPatch: any = { trang_thai: toStatus };
  // Ghi mốc thời gian cho từng bước duyệt (để hiển thị ở màn Quản lý).
  const nowIso = new Date().toISOString();
  if (toStatus === "SUBMITTED") sessPatch.ngay_yeu_cau = nowIso;        // AM xác nhận
  else if (toStatus === "PM_APPROVED") sessPatch.ngay_pm_duyet = nowIso; // PM duyệt
  else if (toStatus === "APPROVED") sessPatch.ngay_manager_duyet = nowIso; // Manager duyệt
  // Rời DRAFT (AM xác nhận / xác nhận lại sau khi bị từ chối) -> xoá lý do từ chối cũ.
  if (fromStatus === "DRAFT") {
    sessPatch.ly_do_tu_choi = null; sessPatch.nguoi_tu_choi = null;
    sessPatch.tu_choi_o_buoc = null; sessPatch.tu_choi_luc = null;
  }
  await supa.from("order_sessions").update(sessPatch).eq("session_id", sessionId);
  await audit(supa, u.username, actionName, sessionId, `+${created} ~${updated} -${deleted} → ${toStatus}`);
  return { ok: true, created, updated, deleted, newStatus: toStatus };
}

// ============================ ENTRY ============================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { action, token, args } = await req.json();
    if (!action || !H[action]) throw new Error("Hành động không hợp lệ: " + action);
    const secret = Deno.env.get("TOKEN_SECRET")!;
    const user = await verifyToken(token, secret);
    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const result = await H[action](supa, user, Array.isArray(args) ? args : []);
    return json({ ok: true, data: result });
  } catch (e) {
    const msg = String(e?.message || e);
    const status = msg === "AUTH_REQUIRED" ? 401 : 400;
    return json({ error: msg }, status);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}