# Cấu trúc dự án — Đặt hàng

App "Đặt hàng" chạy trên **Supabase (Postgres + Edge Functions)** cho backend và **GitHub Pages**
cho frontend tĩnh, dùng chung danh mục (`shared.dm_*`, `shared.users`) với các web app khác.
Kiến trúc & triển khai: [README.md](README.md). Nghiệp vụ: [PRD.md](PRD.md).

## Sơ đồ thư mục

```
order/
├── index.html                      # Markup SPA (các màn dạng <template>) — GitHub Pages serve thẳng
├── README.md                       # Kiến trúc, triển khai, nạp dữ liệu
├── PRD.md                          # Tài liệu sản phẩm (nghiệp vụ, phân quyền, dữ liệu)
├── PROJECT_STRUCTURE.md            # File này
├── OPTIMIZATION_PLAN.md            # Kế hoạch tối ưu theo đợt (trạng thái từng mục)
├── package.json                    # Chỉ dùng cho Tailwind CLI (npm run build:css)
├── tailwind.config.js              # Bảng màu ngữ nghĩa: primary/danger/warning/slate
├── favicon.svg, logo.png           # Logo VietMedical
├── .gitignore
│
├── js/                             # JS frontend (ES modules, không cần bundler)
│   ├── app.js                      # Điểm vào: boot, đăng nhập, nav theo quyền, deep-link ?session&mien
│   ├── config.js                   # URL + anon key Supabase, khoá localStorage
│   ├── api.js                      # rpc() gọi order-api + timeout, xử lý mất phiên (401)
│   ├── state.js                    # State dùng chung + hàm kiểm tra quyền theo role
│   ├── auth.js                     # Decode token, cảnh báo sắp hết hạn
│   ├── session.js                  # Nạp danh sách đợt (dùng chung Chi tiết + Quản lý)
│   ├── router.js                   # Đổi màn hình theo state.view
│   ├── utils.js                    # $, $$, định dạng số/ngày, debounce, esc, viCmp
│   ├── modal.js                    # askConfirm + focus trap dùng chung
│   ├── toast.js                    # Toast xếp chồng (tối đa 3)
│   ├── table-sticky.js             # Đông cứng cột + header nổi của bảng đặt hàng
│   ├── export-excel.js             # Nạp lười SheetJS + xuất .xlsx bảng thông tin / đợt
│   └── views/
│       ├── order.js                # Chi tiết đặt hàng: tạo đợt, bảng SKU, lọc nhóm/SP/CSH, nhập SL
│       ├── manage.js               # Quản lý đặt hàng: danh sách đợt theo tháng, duyệt/từ chối/hủy,
│       │                           #   nhập PO, xuất Excel danh sách
│       ├── catalog.js              # Danh mục đặt hàng: lọc BU + nhóm, dat_hang/muc_do_sd/safety_stock
│       ├── report.js               # Báo cáo đặt hàng: SKU × tháng (năm tài chính T4 → T3)
│       ├── backtest.js             # Kiểm chứng gợi ý (Admin): backtest công thức với SL thực tế
│       ├── config.js               # Cấu hình hệ thống (Admin): công thức, email, dữ liệu & chỉ số
│       └── audit.js                # Nhật ký (Admin)
│
├── src/tailwind.css                # Nguồn CSS (Tailwind + component tự viết)
├── dist/app.css                    # CSS đã build — PHẢI commit lại sau khi đổi class
│
├── .github/workflows/
│   └── deploy-edge.yml             # Deploy order-api, order-login, notify-sender khi
│                                   #   supabase/functions/** đổi trên master
│
├── sql/                            # Migration Postgres (chạy theo số trong SQL Editor)
│   ├── 01_shared_catalog.sql       # Bảng dm_* dùng chung (IF NOT EXISTS)
│   ├── 02_order_app.sql            # order_sessions/items, audit_log, stock, app_config…
│   ├── 03_rpc_aggregates.sql       # usage_agg, stock_agg, session_stats
│   ├── 04_add_safety_stock.sql     # Cột safety_stock
│   ├── 05_config_log.sql           # order_config_log (lịch sử cấu hình gợi ý)
│   ├── 05_rpc_usage_fy.sql         # usage_fy_agg (SL TH theo năm tài chính)
│   ├── 06_password_v2_and_rate_limit.sql  # password_hash_v2 + bảng rate limit đăng nhập
│   ├── 06_usage_indicators.sql     # Cache usage_indicators + refresh_usage_indicators()
│   ├── 10_move_to_app_order.sql    # Dời bảng riêng app sang schema app_order (+ ROLLBACK)
│   ├── 11_session_nhom_san_pham.sql  # order_sessions.nhom_san_pham
│   ├── 12_session_bu.sql           # order_sessions.bu
│   ├── 12_notify_recipients.sql    # (cũ) người nhận theo bước — đã thay bởi 14
│   ├── 13_bu_code.sql              # dm_vat_tu.bu_code
│   ├── 13_notify_contacts.sql      # (cũ) danh bạ theo role — đã thay bởi 14
│   ├── 14_normalize_session_bu.sql # order_sessions.bu → bu_code
│   ├── 14_shared_notify.sql        # shared.users.email + outbox shared.notifications
│   ├── 15_master_data_dictionary.sql  # Từ điển dùng chung dm_bu / dm_mien (+ ROLLBACK)
│   ├── 16_master_data_fk.sql       # FK/CHECK BU, nhóm SP, miền (+ ROLLBACK)
│   ├── 17_master_data_fix_and_fk.sql  # Sửa dữ liệu lệch + khoá nốt (+ ROLLBACK)
│   ├── 18_stock_csh_agg.sql        # RPC stock_csh_agg (tồn theo chủ sở hữu ĐKLH)
│   ├── 19_session_csh_dklh.sql     # order_sessions.csh_dklh (+ ROLLBACK)
│   ├── 22_tb_th_window_by_muc_do_sd.sql  # TB tháng TH: 6 tháng cho "Hay sử dụng" (+ ROLLBACK)
│   ├── 23_logistics_snapshot_date.sql    # logistics_input theo snapshot_date (+ ROLLBACK)
│   ├── 24_logistics_replace_snapshot_rpc.sql  # RPC ghi 1 snapshot logistics (+ ROLLBACK)
│   ├── 25_tb_th_source_by_bu.sql   # SL TH BU khác CH&CS lấy từ hoá đơn (+ ROLLBACK)
│   ├── 26_backtest_goi_y.sql       # RPC backtest_goi_y cho tab Kiểm chứng gợi ý
│   ├── 27_session_po.sql           # order_session_po — nhiều PO / đợt (+ ROLLBACK)
│   └── schema.sql                  # Schema tham chiếu (bản cũ)
│
├── scripts/                        # Tiện ích migrate & vận hành (Python)
│   ├── migrate.py                  # Migrate tổng từ Google Sheets cũ
│   ├── migrate_catalog.py          # Nạp dm_* từ các file Excel master
│   ├── migrate_order.py            # Nạp sessions/items/log từ Google Sheets cũ
│   ├── refresh_stock.py            # Nạp tồn kho raw theo lô (+ usage) theo cycledate
│   ├── set_password.py             # Đặt/đổi mật khẩu, tạo user trong shared.users
│   └── verify_tbkh.py              # Kiểm chứng cách tính TB KH
│
└── supabase/
    ├── config.toml                 # project_id, verify_jwt=false cho order-login & order-api
    └── functions/
        ├── order-login/index.ts    # Đăng nhập (PBKDF2 + rate limit), đổi mật khẩu, cấp token
        ├── order-api/index.ts      # Toàn bộ nghiệp vụ: object H chứa các action
        └── notify-sender/index.ts  # Gửi email từ shared.notifications (SMTP / Zimbra SOAP), retry
```

Một số pipeline nạp dữ liệu (`merge_bao_cao_su_dung_vat_tu.py`, `build_logistics_input.py`,
`hang_di_duong_hang_ky_gui_pipeline.py`) nằm ngoài repo, trong thư mục script import riêng.

## Thành phần chính

| Lớp | Công nghệ | Vị trí |
|-----|-----------|--------|
| Frontend | HTML tĩnh + ES modules (SPA) | `index.html`, `js/**` |
| CSS | Tailwind build tĩnh (`npm run build:css`) | `src/tailwind.css` → `dist/app.css` |
| API nghiệp vụ | Supabase Edge Function (Deno/TypeScript) | `supabase/functions/order-api` |
| Đăng nhập | Edge Function | `supabase/functions/order-login` |
| Gửi email | Edge Function + pg_cron | `supabase/functions/notify-sender` |
| Cơ sở dữ liệu | Postgres (schema `shared`, `app_order`, `app_sale`, `public`) | `sql/*.sql` |
| Nạp dữ liệu / vận hành | Python | `scripts/*.py` + script ngoài repo |
| CI/CD | GitHub Actions | `.github/workflows/deploy-edge.yml` |

## Luồng dữ liệu

1. Người dùng mở `index.html` (GitHub Pages). `js/app.js` thử token sẵn có; nếu không có thì gọi
   `order-login` để xác thực với `shared.users` và nhận token HMAC.
2. Mọi thao tác gọi `order-api` (`POST { action, token, args }`). Server kiểm tra token,
   `users.active`, quyền theo role và phạm vi, rồi đọc/ghi Postgres bằng service_role.
3. Khi đợt chuyển bước, `order-api` ghi thư vào `shared.notifications`; `notify-sender` (pg_cron
   mỗi phút) gửi email và cập nhật trạng thái.
4. Tồn kho, SL thực hiện, logistics, danh mục được nạp bằng script. Sau khi nạp, Admin bấm
   "Tính lại chỉ số" để cập nhật `usage_indicators`.
5. Push lên `master`: GitHub Pages serve frontend (không có bước build CI — **đổi class Tailwind
   xong phải chạy `npm run build:css` và commit `dist/app.css`**); `deploy-edge.yml` deploy Edge
   Functions khi `supabase/functions/**` thay đổi.
