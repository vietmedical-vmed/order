# Đặt hàng CTCH — Supabase + GitHub Pages (kiến trúc danh mục dùng chung)

Chuyển app "Đặt hàng CTCH" từ Google Apps Script sang Supabase + GitHub Pages,
**dùng chung danh mục** (users, sản phẩm, vật tư…) với các web app khác của công ty.

## Kiến trúc

**Dùng chung — mọi app xài chung (bảng `dm_*` + `users`):**
- `users` — **đã có sẵn trên Supabase cloud, KHÔNG tạo lại.** Cột dùng: `username,
  ho_va_ten, password_hash, role, mien` (+ `salt` nếu có). App đọc role/mien trực tiếp
  từ đây. Map role: `area_manager`→AM, `product_manager`→PM, `manager`→MANAGER,
  `admin`→ADMIN. Role khác (vd `ps`) bị chặn đăng nhập app này.
- `dm_vat_tu` — master SKU (Mã Bravo, tên, giá, NCC, phân loại…) — nguồn tên/giá dùng chung.
- `dm_san_pham`, `dm_nhom_san_pham`, `dm_bu`, `dm_bo_vat_tu`, `dm_bo_vat_tu_mapping`.
- `dm_ps`, `dm_dia_ban`, `dm_khach_hang`.

**Riêng app Đặt hàng:**
- `order_catalog` — **danh mục đặt hàng** (chỉ thuộc tính riêng: muc_do_sd, leadtime,
  tb_kh_3_thang, so_thang_dat, active). Tên/giá/NCC/nhóm lấy từ `dm_vat_tu` qua `ma_bravo`.
- `order_sessions`, `order_items`, `audit_log`, `stock`, `usage_stat`, `app_config`.

Danh mục hiển thị trong app = `order_catalog ⋈ dm_vat_tu` (join trong Edge Function `api`).

## Cấu trúc repo

```
sql/01_shared_catalog.sql   -- bảng dm_* dùng chung (IF NOT EXISTS)
sql/02_order_app.sql        -- ctch_order_roles, order_catalog, order_* , stock…
supabase/functions/login/   -- verify users (chung) + lấy role/mien (ctch_order_roles)
supabase/functions/api/     -- RPC; danh mục = order_catalog ⋈ dm_vat_tu
scripts/migrate_catalog.py  -- nạp dm_* từ 4 file Excel master
scripts/migrate_order.py    -- nạp ctch_order_roles + order_catalog + sessions/items/log
scripts/refresh_stock.py    -- aggregate + nạp tồn kho & usage (chạy định kỳ)
scripts/set_password.py     -- đặt/đổi mật khẩu trong bảng users dùng chung
web/index.html              -- frontend tĩnh
.github/workflows/deploy.yml
```

## Các bước triển khai

### 1. Tạo bảng
Supabase → SQL Editor → chạy lần lượt `sql/01_shared_catalog.sql` rồi `sql/02_order_app.sql`.
(01 dùng IF NOT EXISTS nên không đè bảng dùng chung đã có.)

### 2. Secrets + deploy Edge Function
```bash
supabase secrets set TOKEN_SECRET="chuỗi-random-dài"
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy login
supabase functions deploy api
```
(config.toml đã đặt verify_jwt=false cho cả hai.)

### 3. Nạp danh mục dùng chung
```bash
pip install pandas openpyxl supabase
cp .env.example .env      # điền SUPABASE_URL + SERVICE_ROLE_KEY
set -a; source .env; set +a
python scripts/migrate_catalog.py --dir ./danh_muc     # thư mục chứa 4 file .xlsx
```

### 4. Nạp dữ liệu riêng app (từ export Google Sheet cũ)
```bash
python scripts/migrate_order.py --source ./export_cu.xlsx
```
- Role/mien: cập nhật TRỰC TIẾP trên bảng `users` dùng chung (không qua script).
- Tab `Products` cũ → `order_catalog` (giữ muc_do_sd/tb_kh_3_thang/so_thang_dat).
  Mã nào không có trong `dm_vat_tu` sẽ bị bỏ (in ra số lượng).

### 5. Nạp tồn kho + usage
```bash
python scripts/refresh_stock.py --stock ./chi_tiet.xlsx --usage ./sdvt.xlsx
```

### 6. Cấu hình + deploy frontend
Sửa `window.CTCH_CONFIG` trong `web/index.html` (apiBase + anonKey), push GitHub,
Settings → Pages → Source = **GitHub Actions**.

## Ghi chú kỹ thuật

- **Mapping nhom_hang/phan_loai**: mặc định `nhom_hang ← Phân loại 1`,
  `phan_loai ← Phân loại 2` (sửa trong `api/index.ts::fetchProducts` nếu cần).
- **gia** lấy từ `dm_vat_tu.don_gia_thau_moi`.
- **Mật khẩu**: bảng dùng chung để cột `salt` TRỐNG ⇒ verify `SHA-256(password)`.
  (Nếu điền salt thì tự chuyển sang `SHA-256(salt + ":" + password)`.) Dùng
  `set_password.py` để set cho đúng scheme. Cần ≥1 tài khoản `role=admin`.
- **PM theo scope**: cột `scope` của user (vd "Cột sống Ulrich, Khớp UOC") = danh sách
  `dm_vat_tu.nhom_san_pham` ngăn bằng dấu phẩy. PM chỉ nhập/sửa SL duyệt cho SKU thuộc
  scope (khớp không phân biệt hoa/thường); server chặn lại phần ngoài scope khi lưu.
  Nút "Xác nhận" của PM vẫn đẩy cả đợt sang PM_APPROVED — nếu có NHIỀU PM mỗi người 1
  scope trên cùng đợt và cần duyệt xong hết mới chuyển bước, đó là thay đổi luồng riêng
  (báo để làm thêm).
- **UTF-8 token**: `api` giải mã bằng TextDecoder utf-8 (tránh mojibake tiếng Việt).
- **NaN**: các script dùng `clean()`/`math.isnan`.
- **Tồn tổng** giữ nguyên: `DA + Ký gửi + Đi đường − Vét thầu`.
- **RLS** bật hết, deny anon; Edge Function dùng service_role bypass.
