# Cấu trúc dự án — Đặt hàng CTCH

App "Đặt hàng CTCH" chạy trên **Supabase (Postgres + Edge Functions)** cho backend và
**GitHub Pages** cho frontend tĩnh, dùng chung danh mục (`dm_*`, `users`) với các web app
khác của công ty. Chi tiết kiến trúc & triển khai xem [README.md](README.md).

## Sơ đồ thư mục

```
order/
├── index.html                      # Markup SPA (5 màn dạng <template>) — GitHub Pages serve thẳng
├── README.md                       # Tài liệu kiến trúc & hướng dẫn triển khai
├── PROJECT_STRUCTURE.md            # File này
├── OPTIMIZATION_PLAN.md            # Kế hoạch tối ưu theo đợt (trạng thái từng mục)
├── package.json                    # Chỉ dùng cho Tailwind CLI (npm run build:css)
├── tailwind.config.js              # Bảng màu ngữ nghĩa: primary/danger/warning/slate
├── .gitignore
│
├── js/                             # Toàn bộ JS frontend (ES modules, không cần bundler)
│   ├── app.js                      # Điểm vào: boot, đăng nhập, nav, đăng xuất
│   ├── config.js                   # URL + anon key Supabase, khoá localStorage
│   ├── api.js                      # rpc/rpcOpts/rpcRaw + fetch có timeout
│   ├── state.js                    # State dùng chung + hàm kiểm tra quyền theo role
│   ├── auth.js                     # Decode token, cảnh báo sắp hết hạn
│   ├── session.js                  # Nạp danh sách đợt
│   ├── router.js                   # Đổi màn hình theo state.view
│   ├── utils.js                    # $, $$, định dạng số/ngày, debounce, esc
│   ├── modal.js                    # askConfirm + focus trap dùng chung
│   ├── toast.js                    # Toast xếp chồng (tối đa 3)
│   ├── table-sticky.js             # Đông cứng cột + header nổi của bảng đặt hàng
│   ├── export-excel.js             # Nạp lười SheetJS + xuất .xlsx
│   └── views/
│       ├── order.js                # Màn Chi tiết đặt hàng (bảng, lọc, sắp xếp, nhập liệu)
│       ├── manage.js               # Màn Quản lý đợt (duyệt/từ chối/chốt/DM-PO)
│       ├── catalog.js              # Màn Cấu hình danh mục
│       ├── config.js               # Màn Cấu hình công thức Gợi ý
│       └── audit.js                # Màn Nhật ký
│
├── src/tailwind.css                # Nguồn CSS (Tailwind + component tự viết)
├── dist/app.css                    # CSS đã build — PHẢI commit lại sau khi đổi class
│
├── .github/
│   └── workflows/
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
| Frontend | HTML tĩnh + ES modules (SPA) | `index.html`, `js/**` |
| CSS | Tailwind build tĩnh (`npm run build:css`) | `src/tailwind.css` → `dist/app.css` |
| Backend API | Supabase Edge Functions (Deno/TypeScript) | `supabase/functions/order-api` |
| Đăng nhập | Edge Function | `supabase/functions/order-login` |
| Cơ sở dữ liệu | Postgres (Supabase) | `sql/*.sql` |
| Nạp dữ liệu / vận hành | Python | `scripts/*.py` |
| CI/CD | GitHub Actions | `.github/workflows/*.yml` |

## Luồng dữ liệu

1. Người dùng mở `index.html` (GitHub Pages) → `js/app.js` thử token sẵn có, nếu không có thì
   gọi Edge Function `order-login` để xác thực, lấy `role`/`mien` từ bảng `users` dùng chung.
2. Frontend gọi Edge Function `order-api` cho các thao tác danh mục/đặt hàng; danh mục
   hiển thị = `order_catalog ⋈ dm_vat_tu`.
3. Dữ liệu master (`dm_*`) và dữ liệu đặt hàng được nạp qua các script trong `scripts/`.
4. Push lên GitHub → GitHub Pages serve thẳng nhánh `master` (không có bước build CI, nên
   **đổi class Tailwind xong phải chạy `npm run build:css` và commit `dist/app.css`**);
   `deploy-edge.yml` deploy Edge Functions.
