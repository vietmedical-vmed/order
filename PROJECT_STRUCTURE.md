# Cấu trúc dự án — Đặt hàng CTCH

App "Đặt hàng CTCH" chạy trên **Supabase (Postgres + Edge Functions)** cho backend và
**GitHub Pages** cho frontend tĩnh, dùng chung danh mục (`dm_*`, `users`) với các web app
khác của công ty. Chi tiết kiến trúc & triển khai xem [README.md](README.md).

## Sơ đồ thư mục

```
order/
├── index.html                      # Frontend tĩnh (SPA) — deploy lên GitHub Pages
├── README.md                       # Tài liệu kiến trúc & hướng dẫn triển khai
├── PROJECT_STRUCTURE.md            # File này
├── .gitignore
│
├── .github/
│   └── workflows/
│       ├── deploy.yml              # Build & deploy frontend lên GitHub Pages
│       └── deploy-edge.yml         # Auto-deploy Edge Functions khi có thay đổi
│
├── sql/                            # Định nghĩa schema Postgres (chạy trong SQL Editor)
│   ├── 01_shared_catalog.sql       # Bảng dm_* dùng chung (IF NOT EXISTS)
│   ├── 02_order_app.sql            # order_catalog, order_sessions/items, stock…
│   ├── 03_rpc_aggregates.sql       # RPC tổng hợp (aggregates)
│   └── schema.sql                  # Schema tổng hợp / tham chiếu
│
├── scripts/                        # Tiện ích migrate & vận hành (Python)
│   ├── migrate.py                  # Migrate tổng
│   ├── migrate_catalog.py          # Nạp dm_* từ các file Excel master
│   ├── migrate_order.py            # Nạp order_catalog + sessions/items/log
│   ├── refresh_stock.py            # Aggregate + nạp tồn kho & usage (định kỳ)
│   └── set_password.py             # Đặt/đổi mật khẩu trong bảng users dùng chung
│
└── supabase/                       # Cấu hình Supabase + Edge Functions (Deno/TypeScript)
    ├── config.toml                 # project_id, verify_jwt=false cho login & api
    └── functions/
        ├── order-login/
        │   └── index.ts            # Xác thực users, lấy role/mien
        └── order-api/
            └── index.ts            # RPC; danh mục = order_catalog ⋈ dm_vat_tu
```

## Thành phần chính

| Lớp | Công nghệ | Vị trí |
|-----|-----------|--------|
| Frontend | HTML/JS tĩnh (SPA) | `index.html` |
| Backend API | Supabase Edge Functions (Deno/TypeScript) | `supabase/functions/order-api` |
| Đăng nhập | Edge Function | `supabase/functions/order-login` |
| Cơ sở dữ liệu | Postgres (Supabase) | `sql/*.sql` |
| Nạp dữ liệu / vận hành | Python | `scripts/*.py` |
| CI/CD | GitHub Actions | `.github/workflows/*.yml` |

## Luồng dữ liệu

1. Người dùng mở `index.html` (GitHub Pages) → gọi Edge Function `order-login` để xác thực,
   lấy `role`/`mien` từ bảng `users` dùng chung.
2. Frontend gọi Edge Function `order-api` cho các thao tác danh mục/đặt hàng; danh mục
   hiển thị = `order_catalog ⋈ dm_vat_tu`.
3. Dữ liệu master (`dm_*`) và dữ liệu đặt hàng được nạp qua các script trong `scripts/`.
4. Push lên GitHub → `deploy.yml` deploy frontend, `deploy-edge.yml` deploy Edge Functions.
