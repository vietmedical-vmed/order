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

const ROLE_ALIASES: Record<string, string> = {
  SALE_MANAGER: "AM", PRODUCT_MANAGER: "PM",
  area_manager: "AM", product_manager: "PM", manager: "MANAGER", admin: "ADMIN",
  purchasing: "PURCHASING", PURCHASING: "PURCHASING",
};
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
  if (ROLE_ALIASES[payload.role]) payload.role = ROLE_ALIASES[payload.role];
  return payload;
}

// ---------- role helpers ----------
const canActAs = (u: any, role: string) => u.role === "ADMIN" || u.role === role;
const canApprove = (u: any) => ["PM", "MANAGER", "ADMIN"].includes(u.role);
const initials = (name: string) =>
  String(name || "").split(" ").filter(Boolean).map((s) => s[0]).slice(-2).join("").toUpperCase();

// ---------- config ----------
async function getKConfig(supa: SupabaseClient) {
  const { data } = await supa.from("app_config").select("value").eq("key", "goi_y").maybeSingle();
  const c = (data?.value as any) || {};
  return {
    k1: Number(c.k1 ?? DEFAULT_CFG.k1),
    k2: Number(c.k2 ?? DEFAULT_CFG.k2),
    k3: Number(c.k3 ?? DEFAULT_CFG.k3),
    so_thang_dat_default: Number(c.so_thang_dat_default ?? DEFAULT_CFG.so_thang_dat_default),
  };
}

async function audit(supa: SupabaseClient, username: string, action: string, sid = "", detail = "") {
  try {
    await supa.from("audit_log").insert({ username, action, session_id: sid || "", detail: detail || "" });
  } catch (_) { /* ignore */ }
}

// ---------- goi_y + row builder ----------
function buildGoiY(cfg: any, tb_cknt: number, tb_ytd: number, tb_kh_3_thang: number, so_thang_dat: number, tong_ton: number) {
  // Gợi ý = (k1·TB CKNT + k2·TB YTD + k3·TB KH 3 tháng) × Số tháng đặt − Tổng tồn
  // 3 số TB đều là SL trung bình/THÁNG ⇒ ×số tháng đặt = nhu cầu kỳ đặt, trừ tồn hiện có.
  const raw = (cfg.k1 * tb_cknt + cfg.k2 * tb_ytd + cfg.k3 * tb_kh_3_thang) * so_thang_dat;
  return Math.max(0, Math.round(raw - tong_ton));
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

// Tồn kho (DA) + Vét thầu (GU): bảng stock — phân biệt bằng cột warehousetype, SL ở cột quantity.
// Hàng đi đường + Hàng ký gửi: bảng logistics_input (nhập tay từ Excel, tạm thời).
async function stockMapFor(supa: SupabaseClient, mien: string) {
  const map: Record<string, any> = {};
  if (mien === "ALL") {
    const mb = await stockMapFor(supa, "MB");
    const mn = await stockMapFor(supa, "MN");
    return mergeStock(mb, mn);
  }

  // stock: mỗi dòng = (ma_bravo, mien, warehousetype, quantity). Gom quantity theo warehousetype.
  // Phân trang vì stock có thể >1000 dòng (PostgREST mặc định cắt ở 1000).
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("stock").select("ma_bravo, warehousetype, quantity").in("mien", mienVariants(mien))
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc stock: " + error.message);
    const batch = data || [];
    for (const r of batch) {
      const ma = r.ma_bravo;
      if (!ma) continue;
      const row = map[ma] ||
        (map[ma] = { ton_kho: 0, hang_vet_thau: 0, hang_ktv_bv: 0, hang_di_duong: 0 });
      // warehousetype có thể là 'DA'/'GU' gọn hoặc 'SG.05.06.DA' có tiền tố kho -> lấy đuôi.
      const wtRaw = String(r.warehousetype || "").trim().toUpperCase();
      const wt = wtRaw.includes(".") ? wtRaw.split(".").pop()! : wtRaw;
      const q = num(r.quantity);
      if (wt === "DA") row.ton_kho += q;            // tồn kho đạt chất lượng
      else if (wt === "GU") row.hang_vet_thau += q; // hàng gửi = vét thầu
      // warehousetype khác (nếu có) không tính vào tồn kho / vét thầu
    }
    if (batch.length < PAGE) break;
  }

  const { data: lg, error: e2 } = await supa
    .from("logistics_input").select("ma_bravo, hang_di_duong, hang_ktv_bv").in("mien", mienVariants(mien));
  if (e2) throw new Error("Đọc logistics_input: " + e2.message);
  (lg || []).forEach((r) => {
    const row = map[r.ma_bravo] ||
      (map[r.ma_bravo] = { ton_kho: 0, hang_vet_thau: 0, hang_ktv_bv: 0, hang_di_duong: 0 });
    row.hang_di_duong = num(r.hang_di_duong);
    row.hang_ktv_bv = num(r.hang_ktv_bv);
  });

  for (const k of Object.keys(map)) {
    const s = map[k];
    s.tong_ton = s.ton_kho + s.hang_ktv_bv + s.hang_di_duong - s.hang_vet_thau;
  }
  return map;
}

// Ngày cycledate mới nhất trong bảng stock (dùng cho chú thích "tồn kho cập nhật đến…").
async function latestCycledate(supa: SupabaseClient): Promise<string> {
  const { data } = await supa
    .from("stock").select("cycledate").order("cycledate", { ascending: false }).limit(1).maybeSingle();
  return data && data.cycledate ? String(data.cycledate).slice(0, 10) : "";
}

// ---------- usage đọc trực tiếp từ bảng sv ----------
// sv: { month, item_code, quantity, area }  — area = miền ('MB' | 'MN')
type YM = { y: number; mo: number };

function ymOf(v: any): YM | null {
  if (v == null) return null;
  const m = String(v).match(/^(\d{4})-(\d{1,2})/);   // 'YYYY-MM' / 'YYYY-MM-DD' / ISO
  if (m) return { y: +m[1], mo: +m[2] };
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1 };
}

// CKNT: 3 tháng tiến tới tính từ tháng hiện tại, của NĂM NGOÁI (có xử lý vắt năm).
function caKyWindow(Y: number, M: number): Set<string> {
  const set = new Set<string>();
  let yr = Y - 1, mo = M;
  for (let k = 0; k < 3; k++) {
    if (mo > 12) { mo -= 12; yr += 1; }
    set.add(yr + "-" + mo);
    mo += 1;
  }
  return set;
}

// Map ma_bravo -> san_pham (cho %SD), lấy toàn bộ dm_vat_tu (không chỉ dat_hang).
async function loadSanPhamMap(supa: SupabaseClient): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("dm_vat_tu").select("ma_bravo, san_pham").range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc dm_vat_tu(san_pham): " + error.message);
    const batch = data || [];
    for (const r of batch) map[r.ma_bravo] = r.san_pham || "";
    if (batch.length < PAGE) break;
  }
  return map;
}

async function usageMapFor(supa: SupabaseClient, mien: string, spMap?: Record<string, string>) {
  const sanPham = spMap || await loadSanPhamMap(supa);
  if (mien === "ALL") {
    return mergeUsage(
      await usageMapFor(supa, "MB", sanPham),
      await usageMapFor(supa, "MN", sanPham),
    );
  }

  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth() + 1;
  const ytdMonths = Math.max(0, M - 1);        // 2026-07 -> 6 (T01..T06)
  const cknt = caKyWindow(Y, M);

  // Đọc sv theo miền (chỉ 3 cột cần), phân trang
  const rows: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("sv").select("item_code, quantity, month").in("area", mienVariants(mien))
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc sv: " + error.message);
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const perItem: Record<string, { ytd: number; cknt: number; year: number }> = {};
  const perProdYear: Record<string, number> = {};   // %SD: tổng dùng cả năm theo sản phẩm

  for (const r of rows) {
    const code = r.item_code;
    if (!code) continue;
    const ym = ymOf(r.month);
    if (!ym) continue;
    const q = num(r.quantity);
    const it = perItem[code] || (perItem[code] = { ytd: 0, cknt: 0, year: 0 });

    if (ym.y === Y && ym.mo <= M - 1) it.ytd += q;              // YTD
    if (cknt.has(ym.y + "-" + ym.mo)) it.cknt += q;             // CKNT
    if (ym.y === Y) {                                           // cả năm dương lịch
      it.year += q;
      const sp = sanPham[code] || ("__" + code);
      perProdYear[sp] = (perProdYear[sp] || 0) + q;
    }
  }

  const map: Record<string, any> = {};
  for (const code of Object.keys(perItem)) {
    const it = perItem[code];
    const sp = sanPham[code] || ("__" + code);
    const py = perProdYear[sp] || 0;
    map[code] = {
      tb_ytd: ytdMonths > 0 ? Math.round(it.ytd / ytdMonths) : 0,
      tb_cknt: Math.round(it.cknt / 3),
      ty_le_sd_pct: py > 0 ? Math.round((it.year / py) * 100) : 0,
      _iy: it.year, _py: py,
    };
  }
  return map;
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
async function saleTargetSumByBo(supa: SupabaseClient, mien: string): Promise<Record<string, number>> {
  if (mien === "ALL") {
    const mb = await saleTargetSumByBo(supa, "MB");
    const mn = await saleTargetSumByBo(supa, "MN");
    const out: Record<string, number> = { ...mb };
    for (const k of Object.keys(mn)) out[k] = (out[k] || 0) + mn[k];
    return out;
  }
  const months = planMonths3();
  const sum: Record<string, number> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .from("sale_target")
      .select("san_pham, thang_ke_hoach, mien, sl_ke_hoach_update, sl_ke_hoach_dau_nam")
      .in("mien", mienVariants(mien))
      .in("thang_ke_hoach", months)
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Đọc sale_target: " + error.message);
    const batch = data || [];
    for (const r of batch) {
      const key = normKey(r.san_pham);   // = tên bộ (bộ thực) hoặc tên vật tư lẻ
      if (!key) continue;
      const v = r.sl_ke_hoach_update != null ? num(r.sl_ke_hoach_update) : num(r.sl_ke_hoach_dau_nam);
      sum[key] = (sum[key] || 0) + v;    // gom qua ps/khách hàng và cả 3 tháng
    }
    if (batch.length < PAGE) break;
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

  async getConfig(supa) { return await getKConfig(supa); },

  async saveConfig(supa, u, [config]) {
    if (u.role !== "ADMIN") throw new Error("Chỉ Admin được sửa cấu hình");
    const c = {
      k1: Number(config.k1), k2: Number(config.k2), k3: Number(config.k3),
      so_thang_dat_default: Number(config.so_thang_dat_default || 3),
    };
    if ([c.k1, c.k2, c.k3].some((x) => isNaN(x))) throw new Error("k1/k2/k3 phải là số");
    if ([c.k1, c.k2, c.k3].some((x) => x < 0)) throw new Error("Hệ số k phải >= 0");
    await supa.from("app_config").upsert({ key: "goi_y", value: c });
    await audit(supa, u.username, "SAVE_CONFIG", "", JSON.stringify(c));
    return c;
  },

  async listCatalog(supa, u) {
    if (u.role !== "ADMIN" && u.role !== "PM") throw new Error("Chỉ Admin/PM được xem cấu hình danh mục");
    const cols = "ma_bravo, ma_ncc, ten_vat_tu, nhom_san_pham, phan_loai_1, phan_loai_2, san_pham, don_gia_thau_moi, muc_do_sd, dat_hang";
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
    // 1. pick session
    let session: any = null;
    if (sessionId) {
      const { data } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
      session = data || null;
    } else if (mien && mien !== "ALL") {
      session = await findCurrentSession(supa, u, mien);
    }
    if (session && u.role === "AM" && u.mien !== session.mien) session = null;

    // 2. products = danh mục đặt hàng (dm_vat_tu WHERE dat_hang = true)
    let products = await fetchProducts(supa);
    // Lọc theo vai trò: AM -> BU, PM -> nhóm sản phẩm, MANAGER/ADMIN -> tất cả.
    const grants = await getGrants(supa, u);
    const visFilter = makeVisibleFilter(u.role, grants);
    if (visFilter) products = products.filter(visFilter);

    // 3. stock/usage + TB KH 3 tháng (sale_target + mapping)
    let stockMap: any = {}, usageMap: any = {}, sumByBo: Record<string, number> = {};
    const spBoMap = await loadSpBoMap(supa);   // mapping không theo miền -> nạp 1 lần
    if (session) { stockMap = await stockMapFor(supa, session.mien); usageMap = await usageMapFor(supa, session.mien); sumByBo = await saleTargetSumByBo(supa, session.mien); }
    else if (mien === "MB" || mien === "MN") { stockMap = await stockMapFor(supa, mien); usageMap = await usageMapFor(supa, mien); sumByBo = await saleTargetSumByBo(supa, mien); }
    else if (mien === "ALL") { stockMap = await stockMapFor(supa, "ALL"); usageMap = await usageMapFor(supa, "ALL"); sumByBo = await saleTargetSumByBo(supa, "ALL"); }

    // 4. items for session
    const itemMap: Record<string, any> = {};
    if (session) {
      const { data: its } = await supa.from("order_items").select("*").eq("session_id", session.session_id);
      (its || []).forEach((r) => { itemMap[r.ma_bravo] = r; });
    }

    // 5. build rows
    const cfg = await getKConfig(supa);

    // 5a. Gợi ý tính ở mức SẢN PHẨM (công thức hệ số k), sau đó phân bổ cho từng mã bravo theo %SD YTD.
    //     Gom theo san_pham: Σ tb_cknt, Σ tb_ytd, Σ tong_ton; tb_kh là số của sản phẩm (chung).
    const spGy: Record<string, { cknt: number; ytd: number; ton: number; kh: number; sothang: number }> = {};
    for (const p of products) {
      const spk = normKey(p.san_pham);
      if (!spk) continue;
      const us = usageMap[p.ma_bravo] || {};
      const s = stockMap[p.ma_bravo] || {};
      const a = spGy[spk] || (spGy[spk] = { cknt: 0, ytd: 0, ton: 0, kh: 0, sothang: 0 });
      a.cknt += num(us.tb_cknt);
      a.ytd += num(us.tb_ytd);
      a.ton += num(s.tong_ton);
      a.kh = tbKh3Thang(p, sumByBo, spBoMap);   // mức sản phẩm, mọi mã bravo như nhau
      a.sothang = Math.max(a.sothang, Number(p.so_thang_dat || cfg.so_thang_dat_default));
    }
    const spGoiY: Record<string, number> = {};
    for (const spk of Object.keys(spGy)) {
      const a = spGy[spk];
      spGoiY[spk] = buildGoiY(cfg, a.cknt, a.ytd, a.kh, a.sothang, a.ton);
    }

    const rows = products.map((p) => {
      const s = stockMap[p.ma_bravo] || {};
      const us = usageMap[p.ma_bravo] || {};
      const i = itemMap[p.ma_bravo] || {};
      const tb_cknt = num(us.tb_cknt), tb_ytd = num(us.tb_ytd);
      const tb_kh_3_thang = Math.round(tbKh3Thang(p, sumByBo, spBoMap));
      const so_thang_dat = Number(p.so_thang_dat || cfg.so_thang_dat_default);
      const tong_ton = num(s.tong_ton);
      const ty_le_sd_pct = num(us.ty_le_sd_pct);
      // Gợi ý mã bravo = Gợi ý sản phẩm × %SD YTD của mã bravo đó.
      const goi_y_dat = Math.max(0, Math.round((spGoiY[normKey(p.san_pham)] || 0) * ty_le_sd_pct / 100));
      return {
        ma_bravo: p.ma_bravo, code_ncc: p.code_ncc, ten_hang: p.ten_hang_hoa,
        nhom_hang: p.nhom_hang, phan_loai: p.phan_loai, nhom_san_pham: p.nhom_san_pham,
        muc_do_sd: p.muc_do_sd,
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
      stock_asof: await latestCycledate(supa),
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
  async rejectSession(supa, u, [sessionId, reason]) {
    const { data: s } = await supa.from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    let buoc = "";
    if (s.trang_thai === "SUBMITTED") { if (!canActAs(u, "PM")) throw new Error("Không có quyền từ chối (PM)"); buoc = "PM"; }
    else if (s.trang_thai === "PM_APPROVED") { if (!canActAs(u, "MANAGER")) throw new Error("Không có quyền từ chối (Manager)"); buoc = "Manager"; }
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
    const { data: items } = await supa.from("order_items").select("*").eq("session_id", sessionId);
    const prods = await fetchProducts(supa);
    const pMap: Record<string, any> = {}; prods.forEach((p) => pMap[p.ma_bravo] = p);
    const dmVal = session.de_nghi_mua_hang || "", poVal = session.po || "";
    const rows = (items || []).map((it) => {
      const p = pMap[it.ma_bravo] || {};
      const gia = num(p.gia), slDatHang = num(it.sl_dat_hang);
      return {
        ma_bravo: it.ma_bravo, code_ncc: p.code_ncc || "", ten_hang: p.ten_hang_hoa || "",
        nhom_hang: p.nhom_hang || "", phan_loai: p.phan_loai || "", don_vi: p.don_vi || "",
        gia, leadtime_ngay: num(p.leadtime_ngay),
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