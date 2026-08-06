// Edge Function: api
//  POST { action, token, args:[...] }  -> kết quả JSON (giống google.script.run cũ)
//  Xác thực token HMAC (giải mã payload bằng TextDecoder UTF-8 — tránh mojibake tiếng Việt).
//  Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TOKEN_SECRET

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.110.8";

// Chỉ cho phép frontend thật (GitHub Pages) + localhost khi dev, thay vì "*".
const ALLOWED_ORIGINS = ["https://vietmedical-vmed.github.io"];
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) || LOCALHOST_RE.test(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
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
// leadtime_thang_default = số tháng để hàng về (offset cửa sổ TB KH). Nếu chưa cấu hình
// -> fallback về so_thang_dat_default (giữ hành vi cũ khi leadtime ~ số tháng đặt).
// k1 = TB tháng TH (thực hiện), k2 = TB KH. Trước đây có 3 hệ số (CKNT/YTD/KH = .4/.4/.2);
// CKNT + YTD đã gộp thành TB TH nên mặc định mới = .8/.2 (giữ nguyên tổng trọng số).
const DEFAULT_CFG = { k1: 0.8, k2: 0.2, so_thang_dat_default: 3, leadtime_thang_default: 3 };

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
async function hmacVerify(data: string, sigB64url: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlToBytes(sigB64url); } catch { return false; }
  // crypto.subtle.verify tự so sánh constant-time, tránh timing attack so với `expect !== sig`.
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
}
async function verifyToken(token: string, secret: string): Promise<any> {
  if (!token || token.indexOf(".") < 0) throw new Error("AUTH_REQUIRED");
  const [payloadB64, sig] = token.split(".");
  if (!(await hmacVerify(payloadB64, sig, secret))) throw new Error("AUTH_REQUIRED");
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
// Cấu hình CŨ có 3 hệ số (k1·TB CKNT + k2·TB YTD + k3·TB KH). Sau khi gộp CKNT+YTD
// thành TB TH, dạng mới chỉ còn 2 (k1·TB TH + k2·TB KH). Các bản đã lưu (app_config +
// order_config_log của những đợt cũ) vẫn ở dạng 3 hệ số -> quy đổi khi đọc:
//   k1_mới = k1_cũ + k2_cũ (cùng nhân với chỉ số thực hiện), k2_mới = k3_cũ.
// Nhờ vậy tổng trọng số không đổi và xem lại đợt cũ vẫn ra công thức tương đương.
const OLD_DEFAULT_K = { k1: 0.4, k2: 0.4, k3: 0.2 };
const hasNum = (v: any) => v !== undefined && v !== null && v !== "" && !isNaN(Number(v));

// Quy đổi 1 object hệ số (mức mặc định hoặc mức nhóm) từ dạng 3 hệ số về dạng 2 hệ số.
// `base` = k1/k2 mặc định của chính bản cấu hình đó — cần khi override nhóm chỉ nhập 1
// trong 2 ô k1/k2 (ô còn lại thừa kế mặc định), để k1 gộp ra đúng trọng số hiệu lực.
// Ô nào không được set thì vẫn bỏ trống (tiếp tục thừa kế mặc định).
function migrateK(r: any, base: any) {
  const out: any = { ...r };
  delete out.k3;
  if (hasNum(r.k1) || hasNum(r.k2)) {
    out.k1 = (hasNum(r.k1) ? Number(r.k1) : Number(base.k1)) +
             (hasNum(r.k2) ? Number(r.k2) : Number(base.k2));
  } else {
    delete out.k1;
  }
  if (hasNum(r.k3)) out.k2 = Number(r.k3); else delete out.k2;
  return out;
}

// Chuẩn hoá 1 object cấu hình thô (từ app_config hoặc order_config_log) về dạng dùng được.
function normalizeCfg(raw: any) {
  const r0 = raw || {};
  // Bản CŨ nhận diện bằng k3 ở mức mặc định; khi đó mọi override nhóm cũng ở dạng cũ.
  const legacy = hasNum(r0.k3);
  const oldBase = {                                   // mặc định cũ của chính bản cấu hình này
    k1: hasNum(r0.k1) ? Number(r0.k1) : OLD_DEFAULT_K.k1,
    k2: hasNum(r0.k2) ? Number(r0.k2) : OLD_DEFAULT_K.k2,
  };
  const c = legacy ? migrateK(r0, oldBase) : r0;
  // Override theo nhóm sản phẩm: { "<nhom_san_pham>": { k1,k2,so_thang_dat,leadtime_thang } }
  const groups: Record<string, any> = {};
  const gin = (c.groups && typeof c.groups === "object") ? c.groups : {};
  for (const [g, rg] of Object.entries(gin)) {
    if (!g || !rg || typeof rg !== "object") continue;
    const e: any = {};
    const r = legacy ? migrateK(rg as any, oldBase) : (rg as any);
    for (const k of ["k1", "k2"]) {
      if (r[k] !== undefined && r[k] !== null && r[k] !== "") e[k] = Number(r[k]);
    }
    if (r.so_thang_dat !== undefined && r.so_thang_dat !== null && r.so_thang_dat !== "") {
      e.so_thang_dat = Number(r.so_thang_dat);
    }
    if (r.leadtime_thang !== undefined && r.leadtime_thang !== null && r.leadtime_thang !== "") {
      e.leadtime_thang = Number(r.leadtime_thang);   // offset cửa sổ TB KH theo nhóm (màn CH sau)
    }
    if (Object.keys(e).length) groups[g] = e;
  }
  const so_thang_dat_default = Number(c.so_thang_dat_default ?? DEFAULT_CFG.so_thang_dat_default);
  return {
    k1: Number(c.k1 ?? DEFAULT_CFG.k1),
    k2: Number(c.k2 ?? DEFAULT_CFG.k2),
    so_thang_dat_default,
    // Chưa cấu hình leadtime -> dùng số tháng đặt (offset = số tháng đặt) như hiện tại.
    leadtime_thang_default: Number(c.leadtime_thang_default ?? so_thang_dat_default),
    groups,
  };
}

async function getKConfig(supa: SupabaseClient) {
  const { data } = await supa.schema("app_order").from("app_config").select("value").eq("key", "goi_y").maybeSingle();
  return normalizeCfg(data?.value);
}

// Cấu hình công thức CÓ HIỆU LỰC tại thời điểm `atTime` (ISO string):
// bản log mới nhất có created_at <= atTime. Nếu chưa có log nào trước thời điểm đó
// (vd đợt cũ tạo trước khi bật tính năng log) -> fallback về cấu hình hiện hành.
async function getConfigAt(supa: SupabaseClient, atTime?: string | null) {
  if (atTime) {
    const { data, error } = await supa
      .schema("app_order").from("order_config_log")
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
      .schema("shared").from("dm_vat_tu")
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
    await supa.schema("app_order").from("audit_log").insert({ username, action, session_id: sid || "", detail: detail || "" });
  } catch (_) { /* ignore */ }
}

// ---------- goi_y + row builder ----------
function buildGoiY(cfg: any, tb_th: number, tb_kh_3_thang: number, safety_stock: number, so_thang_dat: number, tong_ton: number) {
  // Gợi ý = (k1·TB tháng TH + k2·TB KH 3 tháng) × Số tháng đặt + Safety stock − Tổng tồn
  // 2 số TB đều là SL trung bình/THÁNG ⇒ ×số tháng đặt = nhu cầu kỳ đặt; Safety stock cộng
  // thẳng (không nhân số tháng), rồi trừ tồn hiện có.
  const raw = (cfg.k1 * tb_th + cfg.k2 * tb_kh_3_thang) * so_thang_dat + safety_stock;
  return Math.max(0, Math.round(raw - tong_ton));
}

// Cấu hình hiệu lực cho 1 nhóm sản phẩm: override của nhóm (nếu có) đè lên mặc định.
function cfgForGroup(cfg: any, group: string) {
  const g = (cfg.groups && group && cfg.groups[group]) || {};
  return {
    k1: g.k1 ?? cfg.k1,
    k2: g.k2 ?? cfg.k2,
    so_thang_dat_default: g.so_thang_dat ?? cfg.so_thang_dat_default,
    leadtime_thang_default: g.leadtime_thang ?? cfg.leadtime_thang_default,
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
    const iy = num(x._iy) + num(y._iy);       // Σ SL vật tư trong cửa sổ TH (2 miền)
    const py = num(x._py) + num(y._py);       // Σ SL sản phẩm trong cửa sổ TH (2 miền)
    out[k] = {
      tb_th: num(x.tb_th) + num(y.tb_th),      // SL TB/tháng -> cộng 2 miền
      ty_le_sd_pct: py > 0 ? Math.round((iy / py) * 100) : 0,  // %SD -> tính lại từ raw
      _iy: iy, _py: py,
    };
  }
  return out;
}
const num = (v: any) => Number(v || 0);

// Chuẩn hoá KHOÁ ma_bravo dùng để ghép map giữa các nguồn (dm_vat_tu / sv / stock).
// Chỉ cắt khoảng trắng thừa đầu/cuối (\s đã gồm space/tab/NBSP/BOM/unicode-space) để
// khớp mã giữa các nguồn. Lý do: feed stock có mã sạch còn danh mục/usage đôi khi
// dính space thừa -> stockMap[dm_vat_tu.ma_bravo] bị trượt, tồn hiển thị 0.
const maKey = (s: unknown) =>
  String(s ?? "").replace(/^\s+|\s+$/g, "");

// PostgREST chặn số dòng trả về (mặc định 1000). Các RPC aggregate trả tới vài NGHÌN
// dòng -> gọi .rpc() trực tiếp sẽ bị CẮT còn 1000 (không ORDER BY -> thứ tự tuỳ ý),
// khiến một số mã biến mất khỏi map -> tồn/usage hiển thị 0. Đọc phân trang bằng
// .range() + .order() (khoá ổn định) để lấy ĐỦ mọi dòng.
async function rpcAll(
  supa: SupabaseClient, fn: string,
  params: Record<string, unknown>, orderCols: string[],
): Promise<any[]> {
  const PAGE = 1000;
  const all: any[] = [];
  // Tiến theo SỐ DÒNG THẬT nhận được (không giả định giới hạn = PAGE) và chỉ dừng khi
  // trả về rỗng -> đúng kể cả khi PostgREST cắt < PAGE. Cần .order() khoá ổn định để
  // các trang không trùng/sót dòng.
  for (let from = 0; ; ) {
    let q: any = supa.rpc(fn, params);
    for (const c of orderCols) q = q.order(c, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`RPC ${fn}: ${error.message}`);
    const batch = data || [];
    all.push(...batch);
    if (batch.length === 0) break;
    from += batch.length;
  }
  return all;
}

// Chuẩn hoá scope: "Cột sống Ulrich, Khớp UOC" -> Set{"cột sống ulrich","khớp uoc"}
function parseScope(scope: string): Set<string> {
  return new Set(
    String(scope || "").split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}
const normGroup = (s: string) => String(s || "").trim().toLowerCase();

// Chuẩn hoá lựa chọn nhóm sản phẩm (mảng hoặc chuỗi "A;B") -> "A;B;C" (bỏ trùng/rỗng, giữ tên gốc).
function normalizeGroups(v: any): string {
  const arr = Array.isArray(v) ? v : String(v || "").split(/[,;]/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const t = String(s || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(";");
}

// Quyền xem/đặt/duyệt hàng theo vai trò:
//  - AM : theo BU  (users.bu  ⋈ dm_vat_tu.bu)            -> toàn bộ nhóm SP của BU đó
//  - PM : theo nhóm SP (users.scope ⋈ dm_vat_tu.nhom_san_pham) -> cả 2 miền
//  - MANAGER / ADMIN: xem tất cả
// Đọc bu/scope trực tiếp từ users để không phụ thuộc token cũ & cập nhật tức thì.
async function getGrants(supa: SupabaseClient, u: any): Promise<{ bu: string; scope: string }> {
  if (u.role === "ADMIN" || u.role === "MANAGER" || u.role === "PURCHASING") return { bu: "", scope: "" };
  const { data } = await supa.schema("shared").from("users").select("bu, scope").eq("username", u.username).maybeSingle();
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
      .schema("shared").from("dm_vat_tu")
      // Chú ý: don_vi / leadtime_ngay / so_thang_dat KHÔNG tồn tại trong bảng dm_vat_tu hiện tại
      // (mapping bên dưới cố tình đọc undefined -> fallback 0/''/null, phòng khi cột được thêm
      // sau) — TUYỆT ĐỐI không thêm các tên này vào select() vì PostgREST sẽ lỗi "column does
      // not exist" (đã từng gây lỗi 500 toàn màn Chi tiết đặt hàng, xem OPTIMIZATION_PLAN).
      .select("ma_bravo, ma_ncc, ten_vat_tu, nhom_san_pham, phan_loai_1, san_pham, phan_loai_2, bu, muc_do_sd, safety_stock, don_gia_thau_moi")
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
  let q = supa.schema("app_order").from("stock").select("cycledate").in("mien", mienVariants(mien))
    .order("cycledate", { ascending: false }).limit(1);
  if (ngayMo) q = q.lt("cycledate", ngayMo);
  const { data } = await q.maybeSingle();
  return data && data.cycledate ? String(data.cycledate) : "";
}

// Tồn kho (DA) + Vét thầu (GU): bảng stock — phân biệt bằng cột warehousetype, SL ở cột quantity.
// Hàng đi đường + Hàng ký gửi: bảng logistics_input (nhập tay từ Excel, tạm thời).
// ngayMo = ngày mở đợt: chốt tồn kho theo cycledate mới nhất có ngày <= ngày mở đợt (so theo DATE,
// nên snapshot chốt cùng ngày mở đợt vẫn được tính) để không lấy nhầm log mở sau.
async function stockMapFor(supa: SupabaseClient, mien: string, ngayMo?: string | null) {
  // Aggregate DA/GU + logistics ngay trong DB (stock_agg). Cycledate hiệu lực chốt
  // trong hàm SQL. Đọc phân trang để không bị PostgREST cắt 1000 dòng (xem rpcAll).
  const data = await rpcAll(supa, "stock_agg",
    { p_mien: mien, p_ngaymo: ngayMo ?? null }, ["ma_bravo", "mien"]);

  const buildOne = (rows: any[]) => {
    const map: Record<string, any> = {};
    for (const r of rows) {
      const ton_kho = num(r.ton_kho), hang_vet_thau = num(r.hang_vet_thau);
      const hang_ktv_bv = num(r.hang_ktv_bv), hang_di_duong = num(r.hang_di_duong);
      map[maKey(r.ma_bravo)] = {
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
    .schema("app_order").from("stock").select("cycledate").order("cycledate", { ascending: false }).limit(1).maybeSingle();
  return data && data.cycledate ? String(data.cycledate).slice(0, 10) : "";
}

// ---------- usage đọc từ bảng sv qua RPC usage_agg ----------
// sv: { month, item_code, quantity, area }  — area = miền ('MB' | 'MN')
// Tổng SL thực hiện + SỐ THÁNG có phát sinh (cửa sổ T01 năm trước..tháng liền trước)
// được tính trong SQL (xem usage_agg).
//
// usage_agg trả per (mien, item_code) các tổng THÔ + san_pham; phần chia trung bình /
// %SD / làm tròn nằm ở JS (một chỗ duy nhất).
//   TB tháng TH = Σ SL các tháng có phát sinh / SỐ tháng có phát sinh.
//   %SD (số nguyên) = Σ SL của mã bravo / Σ SL của cả sản phẩm — cùng cửa sổ TH.
//   Mã chưa từng phát sinh -> 0 (không chia cho 0).
async function usageMapFor(supa: SupabaseClient, mien: string) {
  const now = new Date();
  const Y = now.getFullYear(), M = now.getMonth() + 1;
  const data = await rpcAll(supa, "usage_agg",
    { p_mien: mien, p_y: Y, p_m: M }, ["item_code", "mien"]);

  const buildOne = (rows: any[]) => {
    const perProdTh: Record<string, number> = {};   // %SD: tổng SL cửa sổ TH theo sản phẩm
    for (const r of rows) {
      const sp = r.san_pham || ("__" + r.item_code);
      perProdTh[sp] = (perProdTh[sp] || 0) + num(r.th);
    }
    const map: Record<string, any> = {};
    for (const r of rows) {
      const sp = r.san_pham || ("__" + r.item_code);
      const py = perProdTh[sp] || 0;
      const th = num(r.th);
      const thMonths = num(r.th_months);
      map[maKey(r.item_code)] = {
        tb_th: thMonths > 0 ? Math.round(th / thMonths) : 0,
        ty_le_sd_pct: py > 0 ? Math.round((th / py) * 100) : 0,
        _iy: th, _py: py,
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

// Cửa sổ 'TB KH' = các tháng hàng SẼ VỀ & ĐƯỢC DÙNG (không phải các tháng liền kề đợt đặt).
// Trả `count` tháng 'yyyy-mm', bắt đầu lệch `offset` tháng so với tháng hiện tại (giờ VN, UTC+7).
// VD tháng hiện tại 2026-07, số tháng đặt = 3 -> offset=3, count=3 -> [2026-10, 2026-11, 2026-12].
function planMonthsKH(count: number, offset: number): string[] {
  const now = new Date(Date.now() + 7 * 3600 * 1000);
  let m = now.getUTCMonth() + offset;                 // 0-based + lệch offset tháng
  let y = now.getUTCFullYear() + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(y + "-" + String(m + 1).padStart(2, "0"));
    if (++m > 11) { m = 0; y++; }
  }
  return out;
}

// Cửa sổ TB KH toàn màn (tạm dùng mặc định toàn cục; leadtime theo nhóm sẽ có màn CH sau):
//   khCount  = số tháng đặt   -> ĐỘ RỘNG cửa sổ + số chia khi lấy trung bình (>= 1)
//   khOffset = leadtime tháng -> ĐỘ LỆCH tới tháng hàng bắt đầu về & được dùng (>= 0)
const khCount  = (cfg: any) => Math.max(1, Math.round(Number(cfg?.so_thang_dat_default) || 3));
const khOffset = (cfg: any) => Math.max(0, Math.round(Number(cfg?.leadtime_thang_default ?? cfg?.so_thang_dat_default) || 3));

// { normKey(san_pham): { le, bos } } — 1 san_pham -> nhiều bo_vat_tu. Không theo miền.
type SpBo = { le: boolean; bos: string[] };
async function loadSpBoMap(supa: SupabaseClient): Promise<Record<string, SpBo>> {
  const acc: Record<string, { le: boolean; bos: Set<string> }> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa
      .schema("shared").from("dm_bo_vat_tu_mapping").select("san_pham, bo_vat_tu")
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
async function saleTargetSumByBo(supa: SupabaseClient, mien: string, count: number, offset: number): Promise<Record<string, number>> {
  // Cửa sổ = `count` (số tháng đặt) tháng, bắt đầu lệch `offset` (leadtime) tháng — tức các
  // tháng hàng SẼ VỀ & ĐƯỢC DÙNG, không phải các tháng liền kề đợt đặt.
  const months = planMonthsKH(count, offset);
  const data = await rpcAll(supa, "sale_target_agg",
    { p_mien: mien, p_months: months }, ["san_pham", "mien"]);
  const sum: Record<string, number> = {};
  for (const r of (data || [])) {
    const key = normKey(r.san_pham);   // = tên bộ (bộ thực) hoặc tên vật tư lẻ
    if (!key) continue;
    sum[key] = (sum[key] || 0) + num(r.tong);   // gom qua ps/khách hàng, cả 3 tháng & 2 miền
  }
  return sum;
}

// TB KH cho 1 dòng dm_vat_tu (theo san_pham). Chia cho đúng số tháng của cửa sổ (soThangDat).
function tbKh3Thang(p: any, sumByBo: Record<string, number>, spBoMap: Record<string, SpBo>, soThangDat: number): number {
  const spKey = normKey(p.san_pham);
  const m = spBoMap[spKey];
  let total = 0;
  if (!m || m.le || m.bos.length === 0) {
    total = sumByBo[spKey] || 0;                       // vật tư lẻ / không có mapping
  } else {
    for (const bo of m.bos) total += (sumByBo[bo] || 0); // cộng dồn các bộ chứa san_pham
  }
  return total / Math.max(1, soThangDat);              // chia số tháng của cửa sổ
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

  // Danh sách nhóm sản phẩm (nhom_san_pham) trong danh mục đặt hàng — cho combobox tạo đợt.
  async listProductGroups(supa) {
    return await listOrderGroups(supa);
  },

  // Soi TB KH cho 1 vật tư: nhánh lẻ/bộ, danh sách bộ, Σ từng bộ, và TB cuối.
  async debugTbKh(supa, _u, [maBravo, mien]) {
    const mm = mien || "MB";
    const { data: p } = await supa.schema("shared").from("dm_vat_tu")
      .select("ma_bravo, san_pham").eq("ma_bravo", maBravo).maybeSingle();
    if (!p) return { error: "Không thấy ma_bravo=" + maBravo };
    const cfg = await getKConfig(supa);
    const khC = khCount(cfg), khO = khOffset(cfg);
    const spBoMap = await loadSpBoMap(supa);
    const sumByBo = await saleTargetSumByBo(supa, mm, khC, khO);
    const spKey = normKey(p.san_pham);
    const m = spBoMap[spKey];
    const detail: Record<string, number> = {};
    if (!m || m.le || m.bos.length === 0) {
      detail[spKey] = sumByBo[spKey] || 0;
    } else {
      for (const bo of m.bos) detail[bo] = sumByBo[bo] || 0;
    }
    return {
      ma_bravo: p.ma_bravo, san_pham: p.san_pham, mien: mm,
      so_thang_dat: khC, leadtime_thang: khO, months: planMonthsKH(khC, khO),
      co_trong_mapping: !!m,
      nhanh: (!m || m.le) ? "vật tư lẻ / không mapping" : "bộ",
      cac_bo: m ? m.bos : [],
      tong_theo_bo_3thang: detail,       // Σ các tháng cửa sổ của từng khoá đã tra
      tb_kh_3_thang: Math.round(tbKh3Thang(p, sumByBo, spBoMap, khC)),
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
      k1: Number(config.k1), k2: Number(config.k2),   // k1 = TB tháng TH, k2 = TB KH
      so_thang_dat_default: Number(config.so_thang_dat_default || 3),
      groups: {},
    };
    if ([c.k1, c.k2].some((x) => isNaN(x))) throw new Error("k1/k2 phải là số");
    if ([c.k1, c.k2].some((x) => x < 0)) throw new Error("Hệ số k phải >= 0");
    if (isNaN(c.so_thang_dat_default) || c.so_thang_dat_default < 1) throw new Error("Số tháng đặt mặc định phải >= 1");
    // Leadtime mặc định (số tháng để hàng về) — offset cửa sổ TB KH. Tuỳ chọn; nếu không nhập
    // sẽ fallback về số tháng đặt khi tính (xem normalizeCfg). Màn cấu hình theo nhóm bổ sung sau.
    if (config.leadtime_thang_default !== undefined && config.leadtime_thang_default !== null && config.leadtime_thang_default !== "") {
      const lt = Number(config.leadtime_thang_default);
      if (isNaN(lt) || lt < 0) throw new Error("Leadtime mặc định phải >= 0");
      c.leadtime_thang_default = lt;
    }
    // Override theo nhóm sản phẩm — chỉ lưu các ô được nhập; validate số & dấu.
    const gin = (config.groups && typeof config.groups === "object") ? config.groups : {};
    for (const [g, raw] of Object.entries(gin) as [string, any][]) {
      if (!g || !raw || typeof raw !== "object") continue;
      const e: any = {};
      for (const k of ["k1", "k2"]) {
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
      if (raw.leadtime_thang !== undefined && raw.leadtime_thang !== null && raw.leadtime_thang !== "") {
        const n = Number(raw.leadtime_thang);
        if (isNaN(n) || n < 0) throw new Error(`Leadtime của nhóm "${g}" phải >= 0`);
        e.leadtime_thang = n;
      }
      if (Object.keys(e).length) c.groups[g] = e;
    }
    await supa.schema("app_order").from("app_config").upsert({ key: "goi_y", value: c });
    // Ghi log phiên bản cấu hình — áp dụng từ thời điểm này đến khi có bản mới thay thế.
    // Nhờ vậy khi xem lại 1 đợt đặt hàng cũ, Gợi ý dùng đúng công thức tại thời điểm đợt đó.
    // Best-effort: nếu bảng log chưa được tạo (chưa chạy 05_config_log.sql) thì vẫn lưu được cấu hình.
    try {
      await supa.schema("app_order").from("order_config_log").insert({ cfg_key: "goi_y", value: c, created_by: u.username });
    } catch (_) { /* ignore — log là phụ, không chặn lưu cấu hình */ }
    await audit(supa, u.username, "SAVE_CONFIG", "", JSON.stringify(c));
    return c;
  },

  // Lịch sử các phiên bản cấu hình công thức (mới nhất trước).
  async listConfigLog(supa, u, [limit]) {
    if (u.role !== "ADMIN") throw new Error("Chỉ Admin được xem lịch sử cấu hình");
    const { data } = await supa
      .schema("app_order").from("order_config_log")
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
        .schema("shared").from("dm_vat_tu")
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
        const { data } = await supa.schema("shared").from("dm_vat_tu")
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
        const { error } = await supa.schema("shared").from("dm_vat_tu").update(patch).in("ma_bravo", slice);
        if (error) throw new Error("Lưu danh mục: " + error.message);
        updated += slice.length;
      }
    }
    await audit(supa, u.username, "CONFIG_CATALOG", "", updated + " vật tư");
    return { ok: true, updated };
  },

  async listSessions(supa, u, [filter]) {
    filter = filter || {};
    let q = supa.schema("app_order").from("order_sessions").select("*");
    if (u.role === "AM") q = q.eq("mien", u.mien);
    else if (filter.mien && filter.mien !== "ALL") q = q.eq("mien", filter.mien);
    // Mua hàng chỉ thấy đợt đã được duyệt (APPROVED) hoặc đã chốt (CLOSED).
    if (u.role === "PURCHASING") q = q.in("trang_thai", ["APPROVED", "CLOSED"]);
    if (filter.status && filter.status !== "ALL") q = q.eq("trang_thai", filter.status);
    const { data: sessions } = await q;
    const list = sessions || [];

    // Thống kê SKU/SL theo đợt: group ngay trong DB (RPC session_stats) thay vì
    // kéo toàn bộ order_items về JS — tránh PostgREST cắt 1000 dòng khi tổng
    // items toàn hệ thống vượt 1000 (bug cũ khiến thống kê sai), và nhanh hơn
    // hẳn khi càng nhiều đợt (listSessions gọi rất thường xuyên).
    const statRows = await rpcAll(supa, "session_stats", {}, ["session_id"]);
    const stat: Record<string, any> = {};
    statRows.forEach((r) => {
      stat[String(r.session_id)] = {
        sku: num(r.sku), sl_dat: num(r.sl_dat), sl_duyet: num(r.sl_duyet),
        sl_dat_hang: num(r.sl_dat_hang), approved_sku: num(r.approved_sku), ordered_sku: num(r.ordered_sku),
      };
    });

    const out = list.map((s) => ({
      session_id: String(s.session_id),
      ten_dot: String(s.ten_dot || ""),
      mien: String(s.mien || ""),
      ngay_mo: s.ngay_mo ? new Date(s.ngay_mo).toISOString() : "",
      ngay_dong: s.ngay_dong ? new Date(s.ngay_dong).toISOString() : "",
      trang_thai: String(s.trang_thai || ""),
      tao_boi: String(s.tao_boi || ""),
      nhom_san_pham: s.nhom_san_pham || "",
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
        ? supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle().then(r => r.data || null)
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
    const khC = khCount(cfg), khO = khOffset(cfg);   // độ rộng = số tháng đặt, offset = leadtime

    const visFilter = makeVisibleFilter(u.role, grants);
    let products = visFilter ? products0.filter(visFilter) : products0;
    // AM: nếu cấu hình BU không khớp sản phẩm nào (BU trống/sai lệch dữ liệu) thì hiển thị
    // toàn bộ danh mục thay vì màn trắng "không có SKU". AM vẫn bị giới hạn theo miền
    // qua tồn kho & phạm vi đợt đặt hàng.
    if (u.role === "AM" && visFilter && products.length === 0 && products0.length > 0) {
      products = products0;
    }
    // Đợt gắn 1 hoặc NHIỀU nhóm sản phẩm -> chỉ hiển thị danh mục thuộc các nhóm đó
    // (áp sau lọc theo vai trò). parseScope tách "A;B" và chuẩn hoá chữ thường.
    if (session && session.nhom_san_pham) {
      const set = parseScope(session.nhom_san_pham);
      if (set.size) products = products.filter((p: any) => set.has(normGroup(p.nhom_san_pham)));
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
        saleTargetSumByBo(supa, effMien, khC, khO),
        resolveStockCycledate(supa, effMien, ngayMo),
        session ? supa.schema("app_order").from("order_items").select("*").eq("session_id", session.session_id).then(r => r.data || []) : Promise.resolve([]),
      ]);
      stockMap = sm; usageMap = um; sumByBo = sb; stockAsof = sa;
      (its as any[]).forEach((r) => { itemMap[maKey(r.ma_bravo)] = r; });
    } else if (effMien === "ALL") {
      const [sm, um, sb, sa, its] = await Promise.all([
        stockMapFor(supa, "ALL"),
        usageMapFor(supa, "ALL"),
        saleTargetSumByBo(supa, "ALL", khC, khO),
        latestCycledate(supa),
        session ? supa.schema("app_order").from("order_items").select("*").eq("session_id", session.session_id).then(r => r.data || []) : Promise.resolve([]),
      ]);
      stockMap = sm; usageMap = um; sumByBo = sb; stockAsof = sa;
      (its as any[]).forEach((r) => { itemMap[maKey(r.ma_bravo)] = r; });
    }

    // 5. build rows

    // 5a. Gợi ý tính ở mức SẢN PHẨM (công thức hệ số k), sau đó phân bổ cho từng mã bravo theo %SD.
    //     Gom theo san_pham: Σ tb_th, Σ tong_ton; tb_kh là số của sản phẩm (chung).
    const spGy: Record<string, { th: number; ton: number; kh: number; safety: number; sothang: number; grp: string }> = {};
    for (const p of products) {
      const spk = normKey(p.san_pham);
      if (!spk) continue;
      const us = usageMap[maKey(p.ma_bravo)] || {};
      const s = stockMap[maKey(p.ma_bravo)] || {};
      const gcfg = cfgForGroup(cfg, p.nhom_san_pham);   // hệ số/số tháng đặt theo nhóm SP
      const a = spGy[spk] || (spGy[spk] = { th: 0, ton: 0, kh: 0, safety: 0, sothang: 0, grp: p.nhom_san_pham });
      a.th += num(us.tb_th);
      a.ton += num(s.tong_ton);
      a.safety += num(p.safety_stock);          // safety stock cộng dồn theo sản phẩm
      a.kh = tbKh3Thang(p, sumByBo, spBoMap, khC);  // mức sản phẩm, mọi mã bravo như nhau
      a.sothang = Math.max(a.sothang, Number(p.so_thang_dat || gcfg.so_thang_dat_default));
    }
    const spGoiY: Record<string, number> = {};
    for (const spk of Object.keys(spGy)) {
      const a = spGy[spk];
      const gcfg = cfgForGroup(cfg, a.grp);
      spGoiY[spk] = buildGoiY(gcfg, a.th, a.kh, a.safety, a.sothang, a.ton);
    }

    const rows = products.map((p) => {
      const s = stockMap[maKey(p.ma_bravo)] || {};
      const us = usageMap[maKey(p.ma_bravo)] || {};
      const i = itemMap[maKey(p.ma_bravo)] || {};
      const tb_th = num(us.tb_th);
      const tb_kh_3_thang = Math.round(tbKh3Thang(p, sumByBo, spBoMap, khC));
      const gcfgRow = cfgForGroup(cfg, p.nhom_san_pham);
      const so_thang_dat = Number(p.so_thang_dat || gcfgRow.so_thang_dat_default);
      const leadtime_thang = Number(gcfgRow.leadtime_thang_default);   // số tháng để hàng về (theo nhóm)
      const tong_ton = num(s.tong_ton);
      const ty_le_sd_pct = num(us.ty_le_sd_pct);
      // Gợi ý mã bravo = Gợi ý sản phẩm × %SD của mã bravo đó (cùng cửa sổ TH).
      const goi_y_dat = Math.max(0, Math.round((spGoiY[normKey(p.san_pham)] || 0) * ty_le_sd_pct / 100));
      return {
        ma_bravo: p.ma_bravo, code_ncc: p.code_ncc, ten_hang: p.ten_hang_hoa,
        nhom_hang: p.nhom_hang, phan_loai: p.phan_loai, nhom_san_pham: p.nhom_san_pham,
        muc_do_sd: p.muc_do_sd,
        safety_stock: num(p.safety_stock),
        don_vi: p.don_vi || "", gia: num(p.gia), leadtime_ngay: num(p.leadtime_ngay),
        leadtime_thang,
        tb_kh_3_thang, so_thang_dat,
        ton_kho: num(s.ton_kho), hang_ktv_bv: num(s.hang_ktv_bv),
        hang_vet_thau: num(s.hang_vet_thau), hang_di_duong: num(s.hang_di_duong),
        tong_ton,
        tb_th,
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
        nhom_san_pham: session.nhom_san_pham || "",
        ly_do_tu_choi: session.ly_do_tu_choi || "",
        nguoi_tu_choi: session.nguoi_tu_choi || "",
        tu_choi_o_buoc: session.tu_choi_o_buoc || "",
        de_nghi_mua_hang: session.de_nghi_mua_hang || "",
        po: session.po || "",
      };
    }
    const ec = session ? editContextForSession(u, session) : { action: null, editFields: [] };

    // Rows đã được lọc theo quyền (AM: BU, PM: nhóm SP) nên đều thuộc phạm vi user.
    rows.forEach((r: any) => { r.editable = true; });

    return {
      user: { username: u.username, ho_ten: u.ho_ten, role: u.role, mien: u.mien, scope: u.scope || "" },
      session: sessionOut, rows, action: ec.action || null, editFields: ec.editFields || [], readOnly: !ec.action,
      isCatalogOnly: !session, isAllView: mien === "ALL" && !session,
      stock_asof: (stockAsof || await latestCycledate(supa)).slice(0, 10),
    };
  },

  async createSession(supa, u, [name, mien, ngayDong, nhomSanPham]) {
    if (u.role === "ADMIN" || u.role === "PM") { /* ok */ }
    else if (u.role === "AM") { if (u.mien !== mien) throw new Error("AM chỉ tạo được đợt cho miền " + u.mien); }
    else throw new Error("Không có quyền tạo đợt");
    const row: any = { ten_dot: name, mien, ngay_dong: ngayDong || null, trang_thai: "DRAFT", tao_boi: u.username };
    // Có thể chọn NHIỀU nhóm -> lưu dạng "A;B;C". Chỉ set khi có chọn -> đợt "tất cả nhóm"
    // vẫn tạo được kể cả khi cột chưa migrate.
    const grp = normalizeGroups(nhomSanPham);
    if (grp) row.nhom_san_pham = grp;
    const { data, error } = await supa.schema("app_order").from("order_sessions").insert(row).select().single();
    if (error) throw new Error(error.message);
    await audit(supa, u.username, "CREATE_SESSION", data.session_id, name + " · " + mien + (grp ? " · " + grp : ""));
    return data;
  },

  async createSessionBoth(supa, u, [name, ngayDong, nhomSanPham]) {
    if (u.role !== "ADMIN" && u.role !== "PM") throw new Error("Chỉ Admin/PM được tạo đợt cho cả 2 miền");
    const mb = await H.createSession(supa, u, [name, "MB", ngayDong, nhomSanPham]);
    const mn = await H.createSession(supa, u, [name, "MN", ngayDong, nhomSanPham]);
    return { mb, mn };
  },

  async amConfirm(supa, u, [sessionId, items]) {
    if (!canActAs(u, "AM")) throw new Error("Không có quyền xác nhận (AM)");
    const { data: s } = await supa.schema("app_order").from("order_sessions").select("mien, trang_thai").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    if (u.role === "AM" && s.mien !== u.mien) throw new Error("Bạn không phụ trách miền " + s.mien);
    // AM được sửa SL yêu cầu tới KHI PM DUYỆT: DRAFT -> xác nhận (đẩy lên SUBMITTED);
    // SUBMITTED (PM chưa duyệt) -> chỉ cập nhật SL yêu cầu, GIỮ NGUYÊN trạng thái.
    if (s.trang_thai === "DRAFT")
      return await saveAndAdvance(supa, u, sessionId, items, ["sl_dat", "ghi_chu_dat"], ["DRAFT"], "SUBMITTED", "AM_CONFIRM");
    if (s.trang_thai === "SUBMITTED")
      return await saveAndAdvance(supa, u, sessionId, items, ["sl_dat", "ghi_chu_dat"], ["SUBMITTED"], null, "AM_UPDATE");
    throw new Error("Đợt đang ở trạng thái " + s.trang_thai + " — AM không sửa được nữa (PM đã duyệt)");
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
        const { data: vt } = await supa.schema("shared").from("dm_vat_tu").select("ma_bravo, nhom_san_pham").in("ma_bravo", mas);
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

  // Admin ghi đè: sửa BẤT KỲ cột số lượng nào (sl_dat / sl_duyet / sl_dat_hang) + ghi chú,
  // ở BẤT KỲ trạng thái nào (kể cả APPROVED/CLOSED), KHÔNG ràng buộc scope, KHÔNG đổi trạng thái.
  // Chỉ ghi các dòng client gửi lên (đã lọc "có chỉnh" phía client) để không đụng dòng khác.
  async adminSaveItems(supa, u, [sessionId, items]) {
    if (u.role !== "ADMIN") throw new Error("Chỉ Admin dùng được lưu ghi đè");
    const { data: session } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!session) throw new Error("Không tìm thấy đợt");
    const { data: existingRows } = await supa.schema("app_order").from("order_items").select("*").eq("session_id", sessionId);
    const byMa: Record<string, any> = {}; (existingRows || []).forEach((r) => byMa[r.ma_bravo] = r);
    const QTY = ["sl_dat", "sl_duyet", "sl_dat_hang"];
    const NOTES = ["ghi_chu_dat", "ghi_chu_duyet", "ghi_chu_dat_hang"];
    let created = 0, updated = 0;
    for (const it of (items || [])) {
      if (!it || !it.ma_bravo) continue;
      const patch: any = { updated_by: u.username };
      for (const f of QTY) if (it[f] !== undefined) patch[f] = num(it[f]);
      for (const f of NOTES) if (it[f] !== undefined) patch[f] = it[f] || "";
      if (Object.keys(patch).length <= 1) continue;   // chỉ có updated_by -> không có gì để ghi
      const cur = byMa[it.ma_bravo];
      if (cur) {
        await supa.schema("app_order").from("order_items").update(patch).eq("item_id", cur.item_id); updated++;
      } else {
        await supa.schema("app_order").from("order_items").insert({ session_id: sessionId, ma_bravo: it.ma_bravo, ...patch }); created++;
      }
    }
    await audit(supa, u.username, "ADMIN_SAVE", sessionId, `+${created} ~${updated} (status ${session.trang_thai})`);
    return { ok: true, created, updated, deleted: 0, newStatus: session.trang_thai };
  },

  // Phê duyệt NHANH từ màn Quản lý (không sửa số lượng): tự sao chép cột bước trước rồi đẩy trạng thái.
  //  SUBMITTED   (PM):      sl_duyet    ← sl_dat   → PM_APPROVED
  //  PM_APPROVED (MANAGER): sl_dat_hang ← sl_duyet → APPROVED
  async approveSession(supa, u, [sessionId]) {
    const { data: s } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    const { data: rows } = await supa.schema("app_order").from("order_items").select("*").eq("session_id", sessionId);
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
    const { data: s } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    let buoc = "";
    if (s.trang_thai === "PM_APPROVED") { if (!canActAs(u, "MANAGER")) throw new Error("Không có quyền từ chối (Manager)"); buoc = "Manager"; }
    else if (s.trang_thai === "SUBMITTED") throw new Error("Bước PM không còn chức năng từ chối — PM chỉ phê duyệt");
    else throw new Error("Đợt đang ở trạng thái " + s.trang_thai + " — không thể từ chối");
    const lyDo = String(reason || "").trim();
    if (!lyDo) throw new Error("Vui lòng nhập lý do từ chối");
    await supa.schema("app_order").from("order_sessions").update({
      trang_thai: "DRAFT", ly_do_tu_choi: lyDo, nguoi_tu_choi: u.username,
      tu_choi_o_buoc: buoc, tu_choi_luc: new Date().toISOString(),
      ngay_pm_duyet: null, ngay_manager_duyet: null,
    }).eq("session_id", sessionId);
    await audit(supa, u.username, "REJECT", sessionId, buoc + ": " + lyDo);
    return { ok: true, newStatus: "DRAFT" };
  },

  // AM hủy đợt khi CHƯA được PM duyệt (còn DRAFT hoặc SUBMITTED) -> trạng thái CANCELED (kết thúc).
  async cancelSession(supa, u, [sessionId]) {
    if (!canActAs(u, "AM")) throw new Error("Không có quyền hủy đợt (AM)");
    const { data: s } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    if (u.role === "AM" && s.mien !== u.mien) throw new Error("Bạn không phụ trách miền " + s.mien);
    if (s.trang_thai !== "DRAFT" && s.trang_thai !== "SUBMITTED")
      throw new Error("Chỉ hủy được khi đợt chưa được PM duyệt");
    await supa.schema("app_order").from("order_sessions").update({
      trang_thai: "CANCELED", ngay_dong: new Date().toISOString(),
    }).eq("session_id", sessionId);
    await audit(supa, u.username, "CANCEL_SESSION", sessionId, "Hủy khi đang " + s.trang_thai);
    return { ok: true, newStatus: "CANCELED" };
  },

  // Mua hàng "Đặt hàng": lưu thông tin tracking (Đề nghị mua hàng + PO) cho đợt đã duyệt.
  async recordPurchase(supa, u, [sessionId, dm, po]) {
    if (u.role !== "PURCHASING" && u.role !== "ADMIN") throw new Error("Chỉ Mua hàng/Admin được đặt hàng");
    const { data: s } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!s) throw new Error("Không tìm thấy đợt");
    if (s.trang_thai !== "APPROVED" && s.trang_thai !== "CLOSED")
      throw new Error("Chỉ đặt hàng khi đợt đã được duyệt (APPROVED)");
    const deNghi = String(dm || "").trim();
    const poStr = String(po || "").trim();
    if (!deNghi && !poStr) throw new Error("Nhập ít nhất Đề nghị mua hàng hoặc số PO");
    await supa.schema("app_order").from("order_sessions").update({
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
      await supa.schema("app_order").from("order_items").update(patch).eq("item_id", a.item_id);
    }
    await audit(supa, u.username, "APPROVE", sessionId, approvals.length + " SKU");
    return { ok: true, count: approvals.length };
  },

  async closeSession(supa, u, [sessionId]) {
    if (!canApprove(u)) throw new Error("Không có quyền chốt đợt");
    await supa.schema("app_order").from("order_sessions").update({ trang_thai: "CLOSED" }).eq("session_id", sessionId);
    await audit(supa, u.username, "CLOSE_SESSION", sessionId, "");
    return { ok: true };
  },

  async exportOrderData(supa, u, [sessionId]) {
    const { data: session } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
    if (!session) throw new Error("Không tìm thấy đợt");
    if (u.role !== "MANAGER" && u.role !== "ADMIN" && u.role !== "PURCHASING")
      throw new Error("Chỉ Manager/Admin/Mua hàng được xuất file Excel");
    if (session.trang_thai !== "APPROVED" && session.trang_thai !== "CLOSED")
      throw new Error("Chỉ xuất được khi đợt đã được Manager phê duyệt (APPROVED)");

    // Xuất đủ cột như màn Chi tiết → cần tính lại stock/usage/Gợi ý theo đúng logic loadOrderScreen.
    const mienExp = session.mien;
    const ngayMoExp = session.ngay_mo || null;
    const cfg = await getConfigAt(supa, ngayMoExp);   // dùng đúng công thức có hiệu lực khi mở đợt
    const khC = khCount(cfg), khO = khOffset(cfg);     // cửa sổ TB KH (tháng hàng về & được dùng)
    const [items, prods, spBoMap, stockMap, usageMap, sumByBo] = await Promise.all([
      supa.schema("app_order").from("order_items").select("*").eq("session_id", sessionId).then((r) => r.data || []),
      fetchProducts(supa),
      loadSpBoMap(supa),
      stockMapFor(supa, mienExp, ngayMoExp),
      usageMapFor(supa, mienExp),
      saleTargetSumByBo(supa, mienExp, khC, khO),
    ]);
    const pMap: Record<string, any> = {}; prods.forEach((p) => pMap[maKey(p.ma_bravo)] = p);

    // Gợi ý tính ở mức sản phẩm rồi phân bổ theo %SD (giống loadOrderScreen).
    const spGyE: Record<string, any> = {};
    for (const p of prods) {
      const spk = normKey(p.san_pham);
      if (!spk) continue;
      const us = usageMap[maKey(p.ma_bravo)] || {};
      const s = stockMap[maKey(p.ma_bravo)] || {};
      const gcfg = cfgForGroup(cfg, p.nhom_san_pham);
      const a = spGyE[spk] || (spGyE[spk] = { th: 0, ton: 0, kh: 0, safety: 0, sothang: 0, grp: p.nhom_san_pham });
      a.th += num(us.tb_th);
      a.ton += num(s.tong_ton);
      a.safety += num(p.safety_stock);
      a.kh = tbKh3Thang(p, sumByBo, spBoMap, khC);
      a.sothang = Math.max(a.sothang, Number(p.so_thang_dat || gcfg.so_thang_dat_default));
    }
    const spGoiYE: Record<string, number> = {};
    for (const spk of Object.keys(spGyE)) {
      const a = spGyE[spk];
      spGoiYE[spk] = buildGoiY(cfgForGroup(cfg, a.grp), a.th, a.kh, a.safety, a.sothang, a.ton);
    }

    const dmVal = session.de_nghi_mua_hang || "", poVal = session.po || "";
    const rows = (items || []).map((it) => {
      const p = pMap[maKey(it.ma_bravo)] || {};
      const s = stockMap[maKey(it.ma_bravo)] || {};
      const us = usageMap[maKey(it.ma_bravo)] || {};
      const gia = num(p.gia), slDatHang = num(it.sl_dat_hang);
      const ty_le_sd_pct = num(us.ty_le_sd_pct);
      const gcfgRow = cfgForGroup(cfg, p.nhom_san_pham);
      const so_thang_dat = Number(p.so_thang_dat || gcfgRow.so_thang_dat_default);
      const leadtime_thang = Number(gcfgRow.leadtime_thang_default);
      const goi_y_dat = Math.max(0, Math.round((spGoiYE[normKey(p.san_pham)] || 0) * ty_le_sd_pct / 100));
      return {
        ma_bravo: it.ma_bravo, code_ncc: p.code_ncc || "", ten_hang: p.ten_hang_hoa || "",
        nhom_hang: p.nhom_hang || "", phan_loai: p.phan_loai || "", muc_do_sd: p.muc_do_sd || "",
        don_vi: p.don_vi || "", gia,
        ton_kho: num(s.ton_kho), hang_ktv_bv: num(s.hang_ktv_bv), hang_vet_thau: num(s.hang_vet_thau),
        hang_di_duong: num(s.hang_di_duong), tong_ton: num(s.tong_ton),
        ty_le_sd_pct, tb_th: num(us.tb_th),
        tb_kh_3_thang: Math.round(tbKh3Thang(p, sumByBo, spBoMap, khC)),
        safety_stock: num(p.safety_stock), so_thang_dat, leadtime_ngay: num(p.leadtime_ngay), leadtime_thang,
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
    let q = supa.schema("app_order").from("audit_log").select("*").order("timestamp", { ascending: false })
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
    const { data: users } = await supa.schema("shared").from("users").select("username, ho_va_ten");
    const { data: sessions } = await supa.schema("app_order").from("order_sessions").select("session_id, ten_dot, mien");
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

// Ngữ cảnh SỬA của 1 đợt cho 1 user: action (nút xác nhận/lưu) + editFields (các cột số
// lượng được sửa trực tiếp trên bảng). Tách khỏi actionForSession vì admin/AM có luật riêng.
function editContextForSession(u: any, session: any) {
  const st = session.trang_thai;

  // ADMIN: sửa MỌI cột (SL yêu cầu / PM duyệt / đặt hàng) ở MỌI trạng thái, không ràng buộc
  // scope/thời gian. Lưu bằng adminSaveItems — ghi đè trực tiếp, KHÔNG đẩy trạng thái.
  if (u.role === "ADMIN") {
    const noteByStatus: Record<string, string> = {
      DRAFT: "ghi_chu_dat", SUBMITTED: "ghi_chu_duyet",
      PM_APPROVED: "ghi_chu_dat_hang", APPROVED: "ghi_chu_dat_hang", CLOSED: "ghi_chu_dat_hang",
    };
    return {
      // changesOnly: chỉ ghi ô đã sửa (không điền sẵn hàng loạt); prefill off (không có cột "chính").
      action: {
        code: "ADMIN_SAVE", label: "Lưu (Admin)", changesOnly: true, prefill: false,
        hint: "Admin · sửa bất kỳ ô số lượng nào rồi bấm Lưu",
        editField: null, editNoteField: noteByStatus[st] || "ghi_chu_dat_hang", endpoint: "adminSaveItems",
      },
      editFields: [
        { field: "sl_dat", noteField: "ghi_chu_dat" },
        { field: "sl_duyet", noteField: "ghi_chu_duyet" },
        { field: "sl_dat_hang", noteField: "ghi_chu_dat_hang" },
      ],
    };
  }

  // AM: sửa SL yêu cầu tới KHI PM DUYỆT — tức khi đợt còn DRAFT hoặc SUBMITTED.
  if (u.role === "AM" && (st === "DRAFT" || st === "SUBMITTED")) {
    if (u.mien !== session.mien) return { action: null, editFields: [] };
    const advancing = st === "DRAFT";
    // DRAFT: điền sẵn gợi ý + xác nhận cả đợt (đẩy SUBMITTED). SUBMITTED: chỉ sửa ô đã chỉnh
    // (không điền sẵn để không vô tình thêm hàng loạt dòng gợi ý), giữ nguyên trạng thái.
    const action = advancing
      ? { code: "AM_CONFIRM", label: "Xác nhận",
          editField: "sl_dat", editNoteField: "ghi_chu_dat", endpoint: "amConfirm" }
      : { code: "AM_CONFIRM", label: "Cập nhật SL yêu cầu", changesOnly: true, prefill: false,
          hint: "Sửa SL yêu cầu rồi bấm Cập nhật (đợt vẫn chờ PM duyệt)",
          editField: "sl_dat", editNoteField: "ghi_chu_dat", endpoint: "amConfirm" };
    return { action, editFields: [{ field: "sl_dat", noteField: "ghi_chu_dat" }] };
  }

  // Các vai trò/luồng còn lại: giữ mô hình 1 cột theo bước hiện tại.
  const a = actionForSession(u, session);
  return { action: a, editFields: a ? [{ field: a.editField, noteField: a.editNoteField }] : [] };
}

async function findCurrentSession(supa: SupabaseClient, u: any, mienHint: string) {
  let q = supa.schema("app_order").from("order_sessions").select("*");
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
  fields: string[], fromStatus: string | string[], toStatus: string | null, actionName: string,
) {
  const { data: session } = await supa.schema("app_order").from("order_sessions").select("*").eq("session_id", sessionId).maybeSingle();
  if (!session) throw new Error("Không tìm thấy đợt");
  const from = session.trang_thai;
  const allowed = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowed.includes(from))
    throw new Error("Đợt đang ở trạng thái " + from + ", không thể thực hiện " + actionName);

  const { data: existingRows } = await supa.schema("app_order").from("order_items").select("*").eq("session_id", sessionId);
  const byMa: Record<string, any> = {}; (existingRows || []).forEach((r) => byMa[r.ma_bravo] = r);

  let created = 0, updated = 0, deleted = 0;
  const slField = fields[0], noteField = fields[1];
  const isBaseEdit = slField === "sl_dat";   // chỉ cột gốc (SL yêu cầu) mới thêm/xoá dòng order_items

  // Chặn phía ghi: chỉ ghi những SKU thuộc phạm vi của user (AM: BU, PM: nhóm SP).
  let workItems = items || [];
  const grants = await getGrants(supa, u);
  const visFilter = makeVisibleFilter(u.role, grants);
  if (visFilter) {
    const mas = [...new Set(workItems.map((it: any) => it.ma_bravo))];
    const info: Record<string, any> = {};
    for (let i = 0; i < mas.length; i += 500) {
      const { data } = await supa.schema("shared").from("dm_vat_tu")
        .select("ma_bravo, bu, nhom_san_pham").in("ma_bravo", mas.slice(i, i + 500));
      (data || []).forEach((r: any) => { info[r.ma_bravo] = r; });
    }
    const filtered = workItems.filter((it: any) => info[it.ma_bravo] && visFilter(info[it.ma_bravo]));
    // ĐỒNG BỘ với read-path: khi BU của AM không khớp SKU nào, loadOrderScreen hiển thị TOÀN
    // danh mục (fallback) và cho nhập. Nếu ở đây vẫn lọc rỗng thì SL yêu cầu AM vừa nhập bị
    // xoá trắng khi submit (bug cũ). Chỉ giữ nguyên khi filter rỗng — còn khi BU khớp một phần
    // thì vẫn siết đúng phạm vi (nhất quán với danh sách AM nhìn thấy).
    workItems = (u.role === "AM" && filtered.length === 0 && workItems.length > 0) ? workItems : filtered;
  }

  for (const it of workItems) {
    const cur = byMa[it.ma_bravo];
    const sl = num(it[slField]);
    const note = it[noteField] || "";
    if (cur) {
      // Xoá dòng khi AM để trống hẳn (SL=0, không ghi chú) — chỉ khi đợt còn DRAFT.
      if (isBaseEdit && from === "DRAFT" && sl === 0 && !note) {
        await supa.schema("app_order").from("order_items").delete().eq("item_id", cur.item_id); deleted++;
      } else {
        const patch: any = { updated_by: u.username };
        fields.forEach((f) => { if (it[f] !== undefined) patch[f] = it[f]; });
        await supa.schema("app_order").from("order_items").update(patch).eq("item_id", cur.item_id); updated++;
      }
    } else if (isBaseEdit && sl > 0) {
      // Dòng mới chỉ tạo được khi ghi cột gốc SL yêu cầu (DRAFT, hoặc AM bổ sung khi SUBMITTED).
      await supa.schema("app_order").from("order_items").insert({
        session_id: sessionId, ma_bravo: it.ma_bravo, sl_dat: sl, ghi_chu_dat: note, updated_by: u.username,
      }); created++;
    }
  }

  const sessPatch: any = {};
  // toStatus null (hoặc trùng from) -> chỉ lưu số liệu, GIỮ NGUYÊN trạng thái (vd AM cập nhật khi SUBMITTED).
  if (toStatus && toStatus !== from) {
    sessPatch.trang_thai = toStatus;
    // Ghi mốc thời gian cho từng bước duyệt (để hiển thị ở màn Quản lý).
    const nowIso = new Date().toISOString();
    if (toStatus === "SUBMITTED") sessPatch.ngay_yeu_cau = nowIso;        // AM xác nhận
    else if (toStatus === "PM_APPROVED") sessPatch.ngay_pm_duyet = nowIso; // PM duyệt
    else if (toStatus === "APPROVED") sessPatch.ngay_manager_duyet = nowIso; // Manager duyệt
    // Rời DRAFT (AM xác nhận / xác nhận lại sau khi bị từ chối) -> xoá lý do từ chối cũ.
    if (from === "DRAFT") {
      sessPatch.ly_do_tu_choi = null; sessPatch.nguoi_tu_choi = null;
      sessPatch.tu_choi_o_buoc = null; sessPatch.tu_choi_luc = null;
    }
  }
  if (Object.keys(sessPatch).length)
    await supa.schema("app_order").from("order_sessions").update(sessPatch).eq("session_id", sessionId);
  const finalStatus = toStatus || from;
  await audit(supa, u.username, actionName, sessionId, `+${created} ~${updated} -${deleted} → ${finalStatus}`);
  return { ok: true, created, updated, deleted, newStatus: finalStatus };
}

// ============================ ENTRY ============================
Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
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
    return json({ ok: true, data: result }, 200, cors);
  } catch (e) {
    const msg = String(e?.message || e);
    const status = msg === "AUTH_REQUIRED" ? 401 : 400;
    return json({ error: msg }, status, cors);
  }
});

function json(obj: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}