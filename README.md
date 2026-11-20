# Đặt hàng — Supabase + GitHub Pages

Web app đặt hàng vật tư y tế của khối Cung ứng Vietmedical. Luồng: AM đề xuất → PM duyệt →
Manager phê duyệt → Mua hàng nhập PO → Hoàn thành. App dùng chung danh mục (`shared.dm_*`,
`shared.users`) với các web app khác của công ty.

- Nghiệp vụ, phân quyền, công thức gợi ý, mô hình dữ liệu: [PRD.md](PRD.md).
- Sơ đồ thư mục: [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).

## Kiến trúc

```
Trình duyệt ── GitHub Pages (index.html + js/ + dist/app.css)
     │ HTTPS, token HMAC
     ▼
Supabase Edge Functions
  order-login    đăng nhập, đổi mật khẩu
  order-api      toàn bộ nghiệp vụ (POST { action, token, args })
  notify-sender  gửi email từ outbox, chạy theo pg_cron
     │ service_role (+ kết nối Postgres trực tiếp cho RPC nặng)
     ▼
Supabase Postgres
  shared     dm_bu, dm_mien, dm_nhom_san_pham, dm_san_pham, dm_vat_tu, dm_bo_vat_tu*,
             users, notifications            — dùng chung nhiều app
  app_order  order_sessions, order_items, order_session_po, audit_log, stock,
             logistics_input, sv, usage_indicators, app_config, order_config_log
  app_sale   hoa_don_bovattu                 — nguồn SL thực hiện BU khác CH&CS
  public     sale_target + các RPC
```

Điểm chính:
- **Danh mục đặt hàng** = `shared.dm_vat_tu WHERE dat_hang = true`. Cột riêng app (`dat_hang`,
  `muc_do_sd`, `safety_stock`) nằm trên chính `dm_vat_tu`. `app_order.order_catalog` là di sản,
  không còn đọc.
- **BU** khoá theo `bu_code` (`chcs`, `cttm`, `thnk`) trong từ điển `shared.dm_bu`. **Miền** khoá
  `MB / MT / MN` trong `shared.dm_mien`. FK / CHECK ở sql/16–17.
- **Role** lấy từ `shared.users.role`, map trong `ROLE_MAP` (`order-api/index.ts`):
  `admin→ADMIN`, `manager→MANAGER`, `area_manager / sale_manager / ps→AM`,
  `product_manager→PM`, `purchasing→PURCHASING`. Role khác bị chặn.
- **Phạm vi**: AM theo `users.mien` (nhiều miền: `"MB, MN"`) + `users.bu`; PM theo `users.scope`
  (danh sách nhóm SP); mọi role giới hạn thêm theo `users.nhom_san_pham` nếu có. Server đọc
  các cột này tươi ở mỗi request.
- **RLS** bật toàn bộ, deny anon. Chỉ Edge Function (service_role) đọc/ghi.

## Triển khai lần đầu

### 1. Database
Supabase → SQL Editor → chạy lần lượt các file `sql/` theo số thứ tự (`01` → `27`).
- File dùng `IF NOT EXISTS`, không đè bảng dùng chung đã có.
- File `*_ROLLBACK.sql` chỉ chạy khi cần quay lại bước tương ứng.
- Sau các migration chỉ số (22, 25): chạy `select public.refresh_usage_indicators();` hoặc bấm
  "Tính lại chỉ số" ở Cấu hình hệ thống.

### 2. Secrets Edge Function
```bash
supabase link --project-ref <PROJECT_REF>
supabase secrets set TOKEN_SECRET="<chuỗi random dài>"
supabase secrets set APP_URL="<URL GitHub Pages của app>"   # deep-link trong email
supabase secrets set SMTP_HOST=... SMTP_PORT=465 SMTP_USER=... SMTP_PASS=... SMTP_FROM=...
supabase secrets set CRON_SECRET="<chuỗi random>"
```
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` do Supabase tự cấp.
- `ZIMBRA_URL` (tuỳ chọn): có thì `notify-sender` gửi qua Zimbra SOAP (HTTPS 443) thay SMTP,
  đăng nhập bằng `SMTP_USER` / `SMTP_PASS`.
- Supabase Edge chặn outbound cổng 25 và 587: SMTP chỉ dùng 465 (hoặc 2525).

### 3. Deploy Edge Functions
Tự động: push thay đổi trong `supabase/functions/**` lên `master` → `.github/workflows/deploy-edge.yml`
(cần secret repo `SUPABASE_ACCESS_TOKEN`; `PROJECT_REF` khai báo trong workflow). Thủ công:
```bash
supabase functions deploy order-login --yes
supabase functions deploy order-api --yes
supabase functions deploy notify-sender --no-verify-jwt --yes
```
`supabase/config.toml` đặt `verify_jwt = false` cho `order-login` và `order-api` (dùng token HMAC nội bộ).

### 4. Lịch gửi email
Tạo job pg_cron (vd `notify-sender-1m`, mỗi phút) gọi URL function `notify-sender` qua pg_net,
kèm header `x-cron-secret: <CRON_SECRET>`. Email người nhận lấy từ `shared.users.email`
(Admin sửa ở Cấu hình hệ thống → Email thông báo).

### 5. Frontend
- `js/config.js`: `apiBase` + `anonKey` (có thể ghi đè bằng `window.ORDER_CONFIG`).
- GitHub Pages serve tĩnh trực tiếp từ nhánh `master`, không có bước build CI.
- Đổi class Tailwind trong `index.html` hoặc `js/**` thì chạy:
  ```bash
  npm install
  npm run build:css
  ```
  rồi **commit lại `dist/app.css`**, nếu không giao diện trên Pages sẽ lệch.

### 6. Tài khoản
`shared.users` đã có sẵn trên Supabase, không tạo lại. Đặt / đổi mật khẩu:
```bash
python scripts/set_password.py --user <username> --password <mật khẩu>
```
Thêm `--create --role admin --ho-va-ten "..."` để tạo user mới. Cần ít nhất 1 tài khoản `role = admin`.

## Nạp dữ liệu

| Dữ liệu | Cách nạp | Bảng |
|---|---|---|
| Danh mục dùng chung | `scripts/migrate_catalog.py --dir ./danh_muc` | `shared.dm_*` |
| Dữ liệu cũ từ Google Sheets | `scripts/migrate_order.py --source ./export_cu.xlsx` (một lần) | `app_order.*` |
| Tồn kho theo lô | `scripts/refresh_stock.py --stock ./chi_tiet.xlsx [--usage ./sdvt.xlsx] [--cycledate YYYY-MM-DD]` | `app_order.stock` |
| SL thực hiện CH&CS | pipeline `merge_bao_cao_su_dung_vat_tu.py` (ngoài repo) | `app_order.sv` |
| Hàng đi đường / ký gửi | `build_logistics_input.py` (ngoài repo) → RPC `logistics_replace_snapshot` | `app_order.logistics_input` |
| SL thực hiện BU khác | app Sale | `app_sale.hoa_don_bovattu` |
| Kế hoạch bán | app Sale | `public.sale_target` |

Script nạp cần biến môi trường `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`:
```bash
pip install pandas openpyxl supabase
set -a; source .env; set +a
```
Sau khi nạp dữ liệu mới, bấm "Tính lại chỉ số" để cập nhật cache `usage_indicators`.

## Ghi chú kỹ thuật

- **Tổng tồn** = `DA + ký gửi + đi đường − vét thầu`. Tồn kho chọn cycledate, logistics chọn
  snapshot mới nhất ≤ ngày mở đợt.
- **PostgREST timeout 8 giây** (DB dùng chung nhiều app): RPC nặng gọi qua `npm:postgres` +
  `SUPABASE_DB_URL` với `statement_timeout` riêng trong transaction, không nâng timeout của role.
  Đo thời gian bằng `set role service_role;` khi cache nguội.
- **`pg-safeupdate`** bật trên DB: mọi `DELETE` / `UPDATE` phải có `WHERE`.
- **`shared.users.active`** có thể NULL: luôn lọc `active !== false`, không dùng `.eq("active", true)`.
- **Mật khẩu**: v1 = `SHA-256(password)` hoặc `SHA-256(salt + ":" + password)`; v2 = PBKDF2-SHA256
  210k vòng (`password_hash_v2`), lazy upgrade khi đăng nhập.
- **Token**: HMAC-SHA256, TTL 8 giờ, payload decode bằng `TextDecoder` UTF-8 (tránh lỗi tiếng Việt).
- **Email**: nội dung chuyển về ASCII không dấu (webmail nội bộ không decode encoded-word).
- **CORS**: chỉ `https://vietmedical-vmed.github.io` và `localhost` / `127.0.0.1`.
- **Dev local**: chạy frontend bằng static server bất kỳ trên `localhost` (vd `python -m http.server`),
  backend gọi thẳng Supabase cloud.
