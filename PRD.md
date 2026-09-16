# PRD — Ứng dụng "Đặt hàng CTCH"

- Phiên bản tài liệu: 1.0
- Ngày cập nhật: 2026-09-16
- Chủ sở hữu sản phẩm: Vietmedical — Bộ phận Cung ứng / Kinh doanh
- Repo: `order/` (Supabase + GitHub Pages, dùng chung danh mục `dm_*` với các web app khác)

---

## 1. Tổng quan (Overview)

Ứng dụng "Đặt hàng CTCH" là web app SPA phục vụ quy trình **đề xuất — duyệt — chốt đặt hàng vật tư y tế** cho khối Cung ứng của Vietmedical. Hệ thống thay thế bảng tính Google Sheets + Google Apps Script cũ, đưa toàn bộ nghiệp vụ lên **Supabase (Postgres + Edge Functions)** với danh mục **dùng chung** (`dm_*`, `users`) giữa các app nội bộ. Frontend là HTML tĩnh + ES modules host trên GitHub Pages, không cần bundler.

Sản phẩm hiện tại hỗ trợ:
- Nhiều **BU** (CH&CS, CTTM & CTUT, …) — mỗi đợt đặt hàng gắn với 1 BU và 1 miền (MB/MN) hoặc "cả 2 miền".
- Luồng duyệt 3 bước: **AM đề xuất → PM duyệt số lượng → Manager phê duyệt → Mua hàng đặt PO**.
- Gợi ý số lượng đặt dựa trên công thức: `(k1·TB tháng thực hiện + k2·TB kế hoạch) × số tháng đặt + Safety stock − Tổng tồn`, phân bổ về từng SKU theo `%SD`.
- Cấu hình danh mục (bật/tắt đặt hàng, safety stock, mức độ sử dụng) và cấu hình công thức gợi ý (mặc định + override theo nhóm sản phẩm).
- Nhật ký (audit log) đầy đủ hành vi thay đổi trạng thái đợt.

Mục tiêu: chuẩn hoá dữ liệu đặt hàng vào Postgres, giảm phụ thuộc bảng tính, cho phép mở rộng sang các BU khác, và làm nguồn dữ liệu cho báo cáo tồn kho / dự báo mua hàng.

---

## 2. Bối cảnh & Vấn đề (Background & Problem)

### 2.1 Bối cảnh
Trước đây quy trình đặt hàng của khối Cung ứng chạy trên Google Sheets + Google Apps Script:
- Mỗi đợt là 1 tab riêng, dữ liệu chép tay giữa các bên (Area Manager, Product Manager, Manager, Mua hàng).
- Công thức gợi ý số lượng cứng trong bảng tính, không quản lý được lịch sử phiên bản công thức.
- Danh mục vật tư (Mã Bravo, giá, nhóm, phân loại) trùng lặp giữa các bảng tính của nhiều web app khác; mỗi bên tự bảo trì, dễ lệch dữ liệu.
- Tồn kho từ hệ ERP (Bravo) được xuất Excel định kỳ và ghép thủ công.

### 2.2 Vấn đề chính
1. **Xung đột dữ liệu**: mã Bravo, tên, giá, phân loại giữa các bảng tính không đồng bộ; khi bổ sung SKU phải cập nhật nhiều nơi.
2. **Không có phân quyền thực sự**: quyền chỉnh sửa dựa vào việc chia sheet, ai vào cũng có thể sửa quá phạm vi.
3. **Không có lịch sử duyệt**: khi đợt đã chốt, khó truy vết ai duyệt số lượng nào, khi nào, vì sao từ chối.
4. **Công thức gợi ý không phiên bản hoá**: đổi hệ số k1/k2/số tháng đặt → không còn tra lại được gợi ý mà đợt cũ đã dùng.
5. **Không mở rộng đa BU**: bảng tính gốc chỉ phục vụ CH&CS; muốn thêm CTTM/CTUT phải nhân đôi cấu trúc.
6. **Tồn kho không đồng bộ**: aggregate DA/GU/KG thủ công, dễ tính sai "Tổng tồn".

### 2.3 Mục tiêu triển khai
- Chuyển toàn bộ nghiệp vụ đặt hàng sang backend có kiểm soát (Postgres + Edge Functions).
- Dùng chung một danh mục vật tư (`shared.dm_vat_tu`) cho mọi web app trong công ty.
- Số hoá luồng duyệt kèm audit log; phiên bản hoá cấu hình công thức gợi ý.
- Sẵn sàng phục vụ nhiều BU / nhiều miền / nhiều nhóm sản phẩm.

---

## 3. Mục tiêu & Phi mục tiêu (Goals / Non-goals)

### 3.1 Mục tiêu (Goals)

**G1. Luồng đặt hàng số hoá đầu — cuối.** Từ AM tạo đề xuất tới Manager phê duyệt và Mua hàng gắn PO, tất cả trong app; không còn bước copy-paste Excel.

**G2. Danh mục dùng chung.** Tên/giá/NCC/phân loại của SKU chỉ tồn tại một chỗ (`shared.dm_vat_tu`). App đặt hàng chỉ giữ thuộc tính riêng của mình (bật/tắt đặt, safety stock, mức độ SD, ghi chú).

**G3. Phân quyền chặt theo phạm vi.** AM giới hạn theo miền + BU. PM giới hạn theo `scope` = danh sách nhóm sản phẩm mình phụ trách (server chặn ghi ngoài scope). Manager/Admin/Purchasing có phạm vi rộng hơn theo quy tắc rõ ràng.

**G4. Gợi ý số lượng minh bạch và phiên bản hoá.** Công thức mặc định + override theo nhóm sản phẩm, kèm log `order_config_log`; xem lại đợt cũ dùng cấu hình có hiệu lực tại `ngay_mo`.

**G5. Đa BU / đa miền.** Đợt có cột `bu`, `mien`, `nhom_san_pham`. `dm_vat_tu.bu_code` chuẩn hoá để lọc theo `users.bu`.

**G6. Audit log đầy đủ.** Mọi hành vi thay đổi trạng thái đợt, sửa số lượng, cấu hình, đăng nhập, đổi mật khẩu đều ghi vào `app_order.audit_log`.

**G7. Hiệu năng.** Aggregate tồn kho / usage / indicator qua RPC (Postgres) thay vì kéo hàng chục nghìn dòng về Edge Function. Danh mục và stats phân trang trong Edge Function.

**G8. Bảo mật.** Bật RLS toàn bộ, deny anon; Edge Function dùng `service_role`. Token HMAC-SHA256 8 giờ. Mật khẩu lazy migrate lên PBKDF2 (`password_hash_v2`, 210k iterations). Rate limit đăng nhập theo (username, IP).

### 3.2 Phi mục tiêu (Non-goals)

- **Không quản lý PO end-to-end**: PO chỉ lưu số tham chiếu do Mua hàng nhập; không có màn tạo PO chi tiết, không xuất chứng từ.
- **Không lập hoá đơn / thanh toán**: chỉ trong phạm vi đề xuất và duyệt số lượng.
- **Không thay thế Bravo ERP**: tồn kho, giá, mã hàng vẫn lấy từ Bravo (qua script xuất Excel định kỳ).
- **Không phải hệ thống dự báo phức tạp**: gợi ý là công thức tuyến tính có hệ số, không dùng ML.
- **Không có mobile app riêng**: chỉ web responsive dùng qua trình duyệt.
- **Không realtime multi-user editing**: 1 người sửa đợt tại 1 thời điểm; xung đột giải quyết bằng "ai lưu sau thắng".

---

## 4. Đối tượng người dùng & Phân quyền (Personas & Roles)

### 4.1 Personas

| Persona | Vai trò | Nhu cầu chính |
|---|---|---|
| **AM (Area Manager)** | Đề xuất số lượng đặt cho miền mình phụ trách | Tạo đợt, nhập `sl_dat`, sửa cho tới khi PM duyệt, hủy khi cần |
| **PM (Product Manager)** | Duyệt số lượng theo nhóm sản phẩm | Chỉ thấy/sửa SKU thuộc `scope` của mình, nhập `sl_duyet` |
| **MANAGER** | Ký duyệt đợt sau khi PM đã duyệt | Xem đợt PM_APPROVED, phê duyệt (nhập `sl_dat_hang`) hoặc từ chối |
| **PURCHASING** | Nhân viên Mua hàng | Xem đợt đã APPROVED, nhập Đề nghị mua hàng + PO |
| **ADMIN** | Quản trị hệ thống | Cấu hình công thức, cấu hình danh mục, ghi đè dữ liệu đợt, xem toàn bộ nhật ký |

### 4.2 Bảng phân quyền theo hành động

Ghi chú: role gốc trong `users` (`area_manager`, `product_manager`, `manager`, `admin`, `purchasing`, `sale_manager`, `ps`) được map sang mã nội bộ `AM/PM/MANAGER/ADMIN/PURCHASING` (`ROLE_MAP` trong `order-api/index.ts`).

| Hành động | AM | PM | MANAGER | ADMIN | PURCHASING |
|---|:-:|:-:|:-:|:-:|:-:|
| Đăng nhập app | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tạo đợt (1 miền) | ✅ (chỉ miền mình) | ✅ | ❌ | ✅ | ❌ |
| Tạo đợt cả 2 miền | ❌ | ✅ | ✅ | ✅ | ❌ |
| Nhập `sl_dat` (SL yêu cầu) | ✅ (DRAFT/SUBMITTED trước khi PM duyệt) | ❌ | ❌ | ✅ (ghi đè) | ❌ |
| Duyệt PM (nhập `sl_duyet`) | ❌ | ✅ (SKU trong `scope`) | ❌ | ✅ | ❌ |
| Phê duyệt Manager (nhập `sl_dat_hang`) | ❌ | ❌ | ✅ | ✅ | ❌ |
| Từ chối (trả DRAFT) | ❌ | ❌ | ✅ (khi PM_APPROVED) | ✅ | ❌ |
| Hủy đợt (CANCELED) | ✅ (DRAFT/SUBMITTED của miền mình) | ❌ | ❌ | ✅ | ❌ |
| Ghi Đề nghị mua hàng + PO | ❌ | ❌ | ❌ | ✅ | ✅ (đợt APPROVED) |
| Xuất Excel đợt (APPROVED) | ❌ | ❌ | ✅ | ✅ | ✅ |
| Cấu hình danh mục (`saveCatalog`) | ❌ | ✅ (SKU thuộc scope) | ✅ | ✅ | ❌ |
| Cấu hình công thức gợi ý (`saveConfig`) | ❌ | ❌ | ❌ | ✅ | ❌ |
| Xem nhật ký toàn hệ thống | ❌ (chỉ của mình) | ✅ | ✅ | ✅ | ✅ |
| Refresh cache indicators | ❌ | ❌ | ❌ | ✅ | ❌ |

### 4.3 Phạm vi dữ liệu

- **AM**: chỉ thấy/tạo đợt của `mien` = mình, và (nếu có) `bu` khớp `users.bu` (so khớp ilike, không phân biệt hoa/thường).
- **PM**: `scope` là danh sách nhóm sản phẩm, phân tách bằng dấu phẩy hoặc `;` (vd `"Cột sống Ulrich, Khớp UOC"`). Filter khớp không phân biệt hoa/thường. Server chặn cả read (`listCatalog`, `loadOrderScreen`) lẫn write (`pmConfirm`, `saveCatalog`).
- **MANAGER**: chỉ thấy đợt từ `PM_APPROVED` trở đi.
- **PURCHASING**: chỉ thấy đợt `APPROVED`.
- **ADMIN**: toàn quyền, bao gồm `adminSaveItems` để ghi đè bất kỳ cột số lượng nào ở bất kỳ trạng thái nào (không đổi trạng thái, không ràng buộc scope).

---

## 5. Luồng nghiệp vụ chính (User Flows)

### 5.1 Trạng thái đợt (`order_sessions.trang_thai`)

```
        AM tạo
DRAFT ─────────────► SUBMITTED
  ▲                     │ PM duyệt
  │ Manager từ chối     ▼
  │ (kèm lý do)      PM_APPROVED
  │                     │ Manager phê duyệt
  │                     ▼
  │                  APPROVED ───► (Purchasing nhập Đề nghị mua hàng + PO)
  │
  └─── CANCELED (AM hủy khi còn DRAFT/SUBMITTED)
```

Trạng thái cuối: `APPROVED` (đã duyệt và có thể ghi PO) và `CANCELED` (đợt hủy). Từ chối trả về `DRAFT`, xoá mốc `ngay_pm_duyet` / `ngay_manager_duyet` và ghi lại `ly_do_tu_choi` + `nguoi_tu_choi` + `tu_choi_o_buoc` + `tu_choi_luc`.

### 5.2 Luồng chính

**F1. AM tạo đợt và nhập SL yêu cầu**
1. AM chọn "Tạo đợt mới": nhập tên đợt, chọn miền (bắt buộc = `users.mien`), chọn BU (mặc định = `users.bu`), chọn 1 hoặc nhiều nhóm sản phẩm (hoặc để "tất cả nhóm").
2. Backend tạo `order_sessions` với `trang_thai = 'DRAFT'`, `tao_boi = username`.
3. AM mở màn Chi tiết đặt hàng: danh mục = `order_catalog ⋈ dm_vat_tu`, filter theo phạm vi AM (miền + BU + `nhom_san_pham` của đợt).
4. AM nhập `sl_dat` (SL yêu cầu) và `ghi_chu_dat` cho các SKU cần đặt.
5. Bấm "Xác nhận" → gọi `amConfirm` → chuyển `DRAFT → SUBMITTED`, ghi `ngay_yeu_cau`, xoá `ly_do_tu_choi` (nếu có).
6. Sau khi SUBMITTED nhưng **PM chưa duyệt**, AM vẫn có thể sửa `sl_dat` (backend giữ nguyên trạng thái SUBMITTED, action = `AM_UPDATE`).

**F2. PM duyệt số lượng**
1. PM mở đợt đang `SUBMITTED`. Chỉ thấy SKU thuộc `scope` (nhóm sản phẩm mình phụ trách).
2. PM nhập `sl_duyet` và `ghi_chu_duyet`.
3. Bấm "Xác nhận PM" → `pmConfirm` → `SUBMITTED → PM_APPROVED`, ghi `ngay_pm_duyet`.
4. Có "Phê duyệt nhanh" (`approveSession`) sao chép `sl_duyet ← sl_dat` khi PM không muốn sửa.

**F3. Manager phê duyệt**
1. Manager thấy đợt `PM_APPROVED`, nhập `sl_dat_hang` và `ghi_chu_dat_hang` (mặc định copy từ `sl_duyet`).
2. Bấm "Phê duyệt" → `managerApprove` → `PM_APPROVED → APPROVED`, ghi `ngay_manager_duyet`.
3. Hoặc "Từ chối" → nhập lý do (bắt buộc) → `rejectSession` → trả về `DRAFT`.

**F4. Mua hàng ghi PO**
1. Purchasing (hoặc Admin) mở đợt `APPROVED`, xuất Excel (nếu cần), tạo Đề nghị mua hàng bên Bravo.
2. Nhập `de_nghi_mua_hang` + `po` → `recordPurchase` → lưu `nguoi_mua_hang`, `ngay_mua_hang`.

**F5. Cấu hình danh mục (Admin/Manager/PM)**
1. Mở màn "Cấu hình danh mục".
2. Chỉnh cột `dat_hang` (bật/tắt), `muc_do_sd` ("Hay sử dụng"/"Ít sử dụng"/"Hiếm khi"), `safety_stock` (nguyên, ≥ 0).
3. Lưu → `saveCatalog` gom patch giống nhau UPDATE hàng loạt (chunk 200 SKU/lần).

**F6. Cấu hình công thức gợi ý (Admin)**
1. Mở màn "Cấu hình Gợi ý": nhập `k1`, `k2`, `so_thang_dat_default`, `leadtime_thang_default`.
2. Tuỳ chọn override theo nhóm sản phẩm (bảng `groups` trong JSON).
3. Lưu → `saveConfig` cập nhật `app_config.goi_y` **và** insert 1 dòng vào `order_config_log` (phiên bản mới).
4. Từ đó về sau, đợt mở mới dùng cấu hình mới; đợt cũ dùng cấu hình có hiệu lực tại `ngay_mo` (đọc qua `getConfigAt`).

**F7. Đăng nhập / đổi mật khẩu**
1. Người dùng gõ `username`/`password` → gọi Edge Function `order-login`.
2. Server: rate limit (IP + username, 15 phút reset) → tra `shared.users` → verify (`password_hash_v2` PBKDF2 nếu có, fallback SHA-256 [+salt]) → lazy upgrade lên v2.
3. Map role → tạo token `payload.sig` (HMAC-SHA256, TTL 8h). Payload chứa `username, ho_ten, role, mien, bu, scope, exp`.
4. Đổi mật khẩu: `order-login` action `changePassword` → verify mật khẩu hiện tại → tạo salt mới + hash v1 (giữ tương thích app khác) + hash v2 → update cả 3 cột.

### 5.3 Luồng phụ

- **Xuất Excel đợt APPROVED** (`exportOrderData`): trả về `session` + `rows` đã tính đủ chỉ số → frontend dùng SheetJS (lazy load) build `.xlsx`.
- **Xem nhật ký** (`loadAuditLog`): lọc theo `username`, `action`, `session_id`, giới hạn 200 dòng.
- **Admin ghi đè** (`adminSaveItems`): sửa `sl_dat/sl_duyet/sl_dat_hang` ở bất kỳ trạng thái nào mà không đổi state — dùng cho sửa lỗi số liệu sau khi đợt đã APPROVED.

---

## 6. Yêu cầu chức năng (Functional Requirements)

### 6.1 Danh sách action Edge Function

Tất cả gọi qua `POST /functions/v1/order-api` với body `{ action, token, args:[...] }`. Bảng dưới liệt kê action hiện có (trong object `H` tại `supabase/functions/order-api/index.ts:679`).

| Action | Mô tả | Đối tượng dùng | Ghi chú |
|---|---|---|---|
| `getCurrentUser` | Trả thông tin user hiện tại | Mọi role | Đọc từ token |
| `logout` | Ghi audit LOGOUT | Mọi role | — |
| `auditPing` | Ping healthcheck | Mọi role | — |
| `listProductGroups` | Danh sách `nhom_san_pham` để tạo đợt | Mọi role | Filter theo `dat_hang=true` |
| `listBU` | Danh sách BU (bu, ten_bu, bu_code) | Mọi role | Nguồn `shared.dm_bu` |
| `getConfig` / `saveConfig` | Lấy / lưu cấu hình gợi ý | ADMIN (save), mọi role (get) | `saveConfig` insert vào `order_config_log` |
| `listConfigLog` | Lịch sử cấu hình gợi ý | ADMIN | Giới hạn 200 |
| `refreshIndicators` | Refresh cache `usage_indicators` | ADMIN | Gọi RPC `refresh_usage_indicators` |
| `listCatalog` / `saveCatalog` | Danh mục đặt hàng | ADMIN/MANAGER/PM | PM giới hạn scope |
| `listSessions` | Danh sách đợt (kèm stats) | Mọi role (theo phạm vi) | Stats từ RPC `session_stats` |
| `loadOrderScreen` | Nạp màn Chi tiết đặt hàng (rows + session + user + editContext) | Mọi role | Rows đã tính gợi ý |
| `createSession` / `createSessionBoth` | Tạo đợt 1 miền / cả 2 miền | Xem bảng 4.2 | — |
| `amConfirm` | AM lưu `sl_dat` + chuyển trạng thái | AM/ADMIN | DRAFT→SUBMITTED hoặc SUBMITTED (không đổi) |
| `pmConfirm` | PM lưu `sl_duyet` + chuyển trạng thái | PM/ADMIN | SUBMITTED→PM_APPROVED hoặc PM_APPROVED (không đổi) |
| `managerApprove` | Manager lưu `sl_dat_hang` + APPROVED | MANAGER/ADMIN | PM_APPROVED→APPROVED |
| `approveSession` | Duyệt nhanh (copy cột trước) | PM (SUBMITTED) / MANAGER (PM_APPROVED) | — |
| `rejectSession` | Từ chối, trả DRAFT (bắt buộc lý do) | MANAGER/ADMIN | Chỉ khi PM_APPROVED |
| `cancelSession` | Hủy đợt | AM/ADMIN | Chỉ DRAFT/SUBMITTED |
| `recordPurchase` | Ghi Đề nghị mua hàng + PO | PURCHASING/ADMIN | Chỉ APPROVED |
| `approveItems` | Duyệt số theo `item_id` (legacy) | PM/MANAGER/ADMIN | — |
| `adminSaveItems` | Admin ghi đè số lượng | ADMIN | Không đổi trạng thái |
| `exportOrderData` | Trả dữ liệu để xuất Excel | MANAGER/ADMIN/PURCHASING | Chỉ APPROVED |
| `loadAuditLog` | Nhật ký (max 200) | Mọi role | AM chỉ thấy của mình |
| `resolveAuditMeta` | Map username → ho_ten, session_id → ten_dot | Mọi role | Phục vụ hiển thị log |
| `debugTbKh` | Debug TB KH của 1 SKU | ADMIN | — |

### 6.2 Yêu cầu chi tiết theo màn hình

**M1. Đăng nhập** — form username/password. Cảnh báo hết hạn token trước 5 phút. Đổi mật khẩu ngay trong app.

**M2. Danh sách đợt** — filter theo miền/BU/trạng thái. Thẻ đợt hiển thị: tên, miền, BU, ngày mở, trạng thái, sku, tổng SL, người tạo. Có action tương ứng trạng thái + role (Xem, Sửa, Duyệt, Từ chối, Hủy, Xuất Excel, Ghi PO).

**M3. Chi tiết đặt hàng** — bảng SKU × chỉ số. Cột đông cứng bên trái (Mã Bravo, Tên hàng), header dính đỉnh. Ô nhập theo cột hoạt động (AM: `sl_dat`; PM: `sl_duyet`; MANAGER: `sl_dat_hang`; ADMIN: cả 3 khi cần). Hiển thị Tổng tồn, TB TH, TB KH, Gợi ý đặt. Có lọc + tìm + sort. Export Excel.

**M4. Quản lý đợt** — dành cho PM/MANAGER/PURCHASING duyệt/từ chối/chốt/ghi PO. Có form nhập lý do từ chối.

**M5. Cấu hình danh mục** — table `dm_vat_tu` filter theo BU/nhóm. PM chỉ thấy scope của mình. Chỉnh: `dat_hang`, `muc_do_sd`, `safety_stock`.

**M6. Cấu hình gợi ý** — form k1/k2/số tháng đặt/leadtime; bảng override theo nhóm sản phẩm; danh sách phiên bản (đọc `listConfigLog`).

**M7. Nhật ký** — filter theo user/action/session_id. Bảng có phân trang khách (200 dòng/lần).

### 6.3 Yêu cầu chức năng bổ sung

- Toast xếp chồng tối đa 3 thông báo (info/warn/error/success).
- Modal xác nhận có focus trap.
- Debounce ô search 250ms.
- Xuất Excel lazy load SheetJS chỉ khi cần.
- Frontend cache token trong `localStorage`; tự đăng xuất khi 401.
- Cảnh báo trước khi thoát khi có thay đổi chưa lưu.

---

## 7. Mô hình dữ liệu (Data Model)

Sơ đồ tổng quát (bảng chính; xem `sql/01_shared_catalog.sql`, `sql/02_order_app.sql`, các migration 04–14):

```
shared.users ─────────────┐
                          │
shared.dm_bu ──┐          │
shared.dm_nhom_san_pham  │
shared.dm_san_pham       │
shared.dm_vat_tu ◄───┐   │
shared.dm_bo_vat_tu   │   │
shared.dm_bo_vat_tu_mapping
shared.dm_ps / dm_dia_ban / dm_khach_hang
                      │   │
             ma_bravo  │   │ username / role / mien / bu / scope
                      │   │
app_order.order_catalog (FK ma_bravo)
app_order.order_sessions ──────► order_items (FK session_id)
app_order.audit_log
app_order.stock            (raw theo lô, cycledate)
app_order.usage_stat       (aggregate xuất theo năm)
app_order.usage_indicators (cache indicator, refresh RPC)
app_order.app_config       (goi_y jsonb)
app_order.order_config_log (lịch sử phiên bản gợi y)
app_order.sv               (bán ra theo tháng/area — nguồn TB TH)
public.sale_target         (kế hoạch theo miền — nguồn TB KH)
```

### 7.1 Bảng dùng chung (`shared`)

`shared.users` — dùng cho tất cả app. App đặt hàng đọc: `username, ho_va_ten, password_hash, password_hash_v2, salt, role, mien, bu, scope, active`.

`shared.dm_bu (bu PK, ten_bu, bu_code)` — danh sách BU.

`shared.dm_nhom_san_pham (bu, nhom_san_pham)` — nhóm sản phẩm theo BU.

`shared.dm_san_pham (bu, nhom_san_pham, san_pham)` — sản phẩm cấp 3.

`shared.dm_vat_tu` — bảng SKU master:
- Khoá: `ma_bravo`.
- Thuộc tính: `ten_vat_tu, ma_ncc, bu, bu_code, nhom_san_pham, san_pham, phan_loai_1, phan_loai_2, hang, ma_hang, don_gia_thau_cu, don_gia_thau_moi, ma_pldt, ten_pldt, nhom_pldt`.
- Cột riêng app đặt hàng gắn vào master: `dat_hang boolean`, `muc_do_sd text`, `safety_stock numeric`.
- Index: `idx_vattu_bu`, `idx_vattu_pl1`, `idx_vattu_dat_hang` (partial WHERE dat_hang=true), `idx_vattu_bu_code`.

`shared.dm_bo_vat_tu`, `shared.dm_bo_vat_tu_mapping` — bộ vật tư + định mức để tính TB KH theo bộ (khi SKU thuộc bộ, TB KH cộng theo các bộ chứa nó).

### 7.2 Bảng riêng app (`app_order`)

`app_order.order_catalog` — legacy (di sản), thuộc tính riêng đặt hàng của SKU (một số đã dời sang `dm_vat_tu`).

`app_order.order_sessions`:
- PK `session_id uuid`.
- Cột: `ten_dot, mien (MB|MN), bu, ngay_mo, ngay_dong, trang_thai (DRAFT|SUBMITTED|PM_APPROVED|APPROVED|CLOSED|CANCELED), tao_boi, nhom_san_pham (nullable, "A;B" khi nhiều), ly_do_tu_choi, nguoi_tu_choi, tu_choi_o_buoc, tu_choi_luc, ngay_yeu_cau, ngay_pm_duyet, ngay_manager_duyet, de_nghi_mua_hang, po, nguoi_mua_hang, ngay_mua_hang`.
- Index: `idx_sessions_bu`.

`app_order.order_items`:
- PK `item_id uuid`, unique `(session_id, ma_bravo)`.
- Cột: `session_id (FK), ma_bravo, sl_dat, sl_duyet, sl_dat_hang, ghi_chu_dat, ghi_chu_duyet, ghi_chu_dat_hang, updated_at, updated_by`.
- Trigger `trg_items_touch` cập nhật `updated_at`.

`app_order.audit_log`:
- PK `log_id uuid`, index `idx_audit_ts (timestamp desc)`.
- Cột: `timestamp, username, action, session_id, detail`.

`app_order.stock`:
- Không PK. Cột: `ma_bravo, mien, cycledate, itemcode_ncc, warehousetype (DA|GU|KG), warehousecode, warehousename, serialcode, so_lo, quantity, expirydate, mfgdate, note`.
- Index: `idx_stock_mien_cycle (mien, cycledate desc)`.
- Aggregate qua RPC `stock_agg(p_mien, p_cycledate)`.

`app_order.usage_stat` — PK `(ma_bravo, mien)`. Cột `xuat_2024, xuat_2025, xuat_lk_2026, ty_le_sd_pct`.

`app_order.usage_indicators` — cache indicator gồm `tb_th, tb_kh_3_thang, sl_th_fy24, sl_th_fy25, sl_th_fy26_ytd, ty_le_sd_pct` (refresh qua RPC `refresh_usage_indicators`).

`app_order.app_config` — jsonb theo key. Key `goi_y` chứa `{k1, k2, so_thang_dat_default, leadtime_thang_default, groups}`.

`app_order.order_config_log` — mỗi lần lưu cấu hình insert 1 dòng `(id, cfg_key, value jsonb, created_at, created_by)`.

`app_order.sv` — dữ liệu bán ra theo tháng, index `idx_sv_area_month (area, month)`.

`public.sale_target` — kế hoạch theo miền + tháng, index `idx_sale_target_mien_thang (mien, thang_ke_hoach)`.

### 7.3 RPC (`sql/03_rpc_aggregates.sql`, `05_rpc_usage_fy.sql`, `06_usage_indicators.sql`)

- `public.usage_agg(p_mien, p_y, p_m)` → per (mien, item_code): `th, th_months, san_pham` (cửa sổ T01 năm ngoái → tháng liền trước).
- `public.stock_agg(...)` → gom DA/GU/KG theo `ma_bravo/mien`.
- `public.session_stats()` → SL / SKU tổng hợp theo `session_id`.
- `public.refresh_usage_indicators()` → tính lại `usage_indicators`.

---

## 8. Quy tắc nghiệp vụ (Business Rules)

**B1. Chuyển trạng thái** chỉ được đi theo đúng bảng đích trong 5.1. Bất kỳ hàm nào cập nhật `trang_thai` phải kiểm tra `from` trong danh sách được phép và trả lỗi có ngữ nghĩa (`saveAndAdvance` tại `order-api/index.ts:1498`).

**B2. AM sửa `sl_dat`** được phép trong `DRAFT` (đẩy lên SUBMITTED) và `SUBMITTED` khi PM chưa duyệt (giữ nguyên trạng thái). Không sửa được sau khi PM đã duyệt.

**B3. Xoá dòng `order_items`** chỉ được phép khi `from = DRAFT`, `field = sl_dat`, `sl = 0` và không có ghi chú (tránh mất dữ liệu ở các bước sau).

**B4. Từ chối phải có lý do**. `rejectSession` trim và bắt buộc `!empty`. Khi trả về DRAFT xoá `ngay_pm_duyet`, `ngay_manager_duyet` để mốc phản ánh lần duyệt kế tiếp.

**B5. Hủy đợt** chỉ AM (miền mình) hoặc ADMIN, và chỉ khi `DRAFT`/`SUBMITTED`.

**B6. Mua hàng ghi PO** yêu cầu ít nhất một trong `de_nghi_mua_hang` hoặc `po`, đợt phải `APPROVED`.

**B7. Xuất Excel** chỉ khi `APPROVED`, chỉ MANAGER/ADMIN/PURCHASING.

**B8. Filter theo phạm vi**:
- `AM.mien` bắt buộc khớp `session.mien`.
- `AM.bu` khớp `session.bu` (ilike).
- `PM.scope` = danh sách `nhom_san_pham`, khớp không phân biệt hoa/thường (helper `normGroup`).
- Server chặn cả read + write; frontend hiển thị `readOnly` khi `editContextForSession` trả `action=null`.

**B9. Công thức gợi ý** tại mức **sản phẩm** (không phải SKU):
```
tb_kh_3_thang = TB KH theo sản phẩm (dùng dm_bo_vat_tu_mapping nếu là bộ)
tong_ton      = Σ tong_ton (DA + KG + đi_đường − vét_thầu) của các SKU thuộc sản phẩm
safety_stock  = Σ safety_stock các SKU thuộc sản phẩm
tb_th         = Σ (SL bán ra / số tháng có phát sinh) trong cửa sổ TH
so_thang_dat  = max(so_thang_dat theo cấu hình nhóm / default)

goi_y_sp = max(0, (k1·tb_th + k2·tb_kh_3_thang) × so_thang_dat + safety_stock − tong_ton)
```
Sau đó phân bổ về SKU theo `ty_le_sd_pct` (%SD): `goi_y_dat = round(goi_y_sp × ty_le_sd_pct / 100)`.

**B10. Migration công thức cũ**. Bản cấu hình `{k1, k2, k3}` (3 hệ số CKNT/YTD/KH) được `normalizeCfg`/`migrateK` quy đổi:
- `k1_mới = k1_cũ + k2_cũ` (gộp CKNT + YTD thành TB TH).
- `k2_mới = k3_cũ` (giữ nguyên trọng số TB KH).

Nhờ vậy đợt cũ vẫn ra công thức tương đương khi xem lại.

**B11. Cấu hình có hiệu lực theo thời điểm**. `getConfigAt(supa, atTime)` đọc bản `order_config_log` mới nhất có `created_at <= atTime`; đợt cũ dùng đúng cấu hình lúc mở. Cấu hình mới ảnh hưởng chỉ đợt mở sau.

**B12. Tồn kho chọn cycledate**. `resolveStockCycledate` chọn `cycledate` mới nhất ≤ `ngay_mo` (theo miền). Nếu không có → dùng `latestCycledate`.

**B13. Miền chuẩn hoá**. `stock`, `sv` có cả `MB/MN` và `Miền Bắc/Miền Nam`; helper `mienVariants` mở rộng cả 2 dạng khi query.

**B14. BU chuẩn hoá**. `dm_vat_tu.bu_code` (chcs/cttm/…) dùng để lọc theo `users.bu`. Session lưu `bu` bằng tên hiển thị (CH&CS, CTTM & CTUT); listSessions dùng `ilike` để so khớp.

**B15. Audit log**. Mọi action có state-change đều gọi `audit(supa, username, action, sessionId, detail)`:
- `CREATE_SESSION, AM_CONFIRM, AM_UPDATE, PM_CONFIRM, PM_UPDATE, PM_APPROVE, MANAGER_APPROVE, REJECT, CANCEL_SESSION, PURCHASE, ADMIN_SAVE, CONFIG_CATALOG, SAVE_CONFIG, EXPORT, LOGIN, LOGOUT, CHANGE_PASSWORD, APPROVE`.

**B16. RLS**. Bật RLS toàn bộ, deny anon; chỉ Edge Function dùng `service_role` (`SUPABASE_SERVICE_ROLE_KEY`) mới đọc/ghi. Frontend không có key nào truy cập trực tiếp Postgres.

**B17. Token**. TTL 8 giờ, HMAC-SHA256 với secret `TOKEN_SECRET`. Verify constant-time. Payload gồm `username, ho_ten, role (chữ thường), mien, bu, scope, exp`.

**B18. Rate limit đăng nhập**. `order-login` giới hạn theo `(username_lower, IP)`, cửa sổ 15 phút, ngưỡng đủ để reject bằng HTTP 429 (`Đăng nhập sai quá nhiều lần…`).

---

## 9. Yêu cầu phi chức năng (Non-functional)

### 9.1 Hiệu năng
- Aggregate ở tầng DB (RPC) thay vì kéo raw về Edge Function.
- `listCatalog` phân trang PostgREST 1000/lần và gộp tại Edge (~2300 dòng dm_vat_tu).
- `saveCatalog` gom patch cùng nội dung UPDATE hàng loạt (chunk 200).
- Frontend lazy load SheetJS chỉ khi user bấm xuất Excel.
- Trang danh sách đợt: dùng RPC `session_stats` thay vì kéo toàn bộ `order_items` (tránh cắt 1000).

### 9.2 Bảo mật
- Password v2: PBKDF2-HMAC-SHA256, 210k iterations (OWASP 2023).
- Lazy migrate v1 → v2 mỗi lần login thành công.
- Constant-time compare cả HMAC verify và PBKDF2.
- CORS strict: chỉ `https://vietmedical-vmed.github.io` + `localhost/127.0.0.1` (dev).
- RLS + service_role bypass; frontend không giữ service key.
- Rate limit đăng nhập.
- Không lưu password rõ; audit log không lưu chi tiết password/hash.

### 9.3 Khả năng bảo trì
- Cấu trúc tài liệu: `README.md` (kiến trúc), `PROJECT_STRUCTURE.md` (thư mục), `OPTIMIZATION_PLAN.md` (kế hoạch tối ưu), `PRD.md` (tài liệu này).
- SQL migration đánh số tăng dần (`01_shared_catalog.sql` → `14_normalize_session_bu.sql`), idempotent (`IF NOT EXISTS`).
- Frontend module theo màn hình (`js/views/order.js`, `manage.js`, `catalog.js`, `config.js`, `audit.js`).

### 9.4 Khả năng truy vết
- Audit log ≥ 12 tháng (không xoá tự động; scale bằng partition khi cần).
- `order_config_log` giữ mọi phiên bản; xem lại đợt cũ ra đúng công thức.

### 9.5 Trải nghiệm & khả năng truy cập
- Responsive tối thiểu 1280px (dùng bàn làm việc). Mobile không phải target chính, nhưng SPA vẫn hoạt động.
- Ngôn ngữ: tiếng Việt (Vietnamese) toàn UI + thông báo lỗi.
- Toast + Modal có focus trap để keyboard-only user thao tác được.

### 9.6 Sao lưu & khôi phục
- Supabase auto backup theo policy dự án.
- Migration reversible cho các bước rủi ro (`10_move_to_app_order_ROLLBACK.sql`).

---

## 10. Kiến trúc & Triển khai (Architecture & Deployment)

### 10.1 Sơ đồ kiến trúc

```
+-----------------------------+
|  Trình duyệt người dùng     |
|  (GitHub Pages: index.html) |
|   js/ ES modules + dist/    |
+--------------+--------------+
               │ HTTPS
               ▼
+-----------------------------+
|  Supabase Edge Functions    |
|  order-login  (auth+PBKDF2) |
|  order-api    (RPC gateway) |
+--------------+--------------+
               │ service_role
               ▼
+-----------------------------+
|  Supabase Postgres          |
|  schema shared: dm_*, users |
|  schema app_order: đợt/items/audit/stock/... |
|  RPC: usage_agg, stock_agg, session_stats,   |
|       refresh_usage_indicators               |
+-----------------------------+
```

### 10.2 Thành phần

| Lớp | Công nghệ | Vị trí |
|---|---|---|
| Frontend | HTML tĩnh + ES modules (SPA) | `index.html`, `js/**` |
| CSS | Tailwind build tĩnh | `src/tailwind.css` → `dist/app.css` |
| Backend API | Supabase Edge Functions (Deno + TS) | `supabase/functions/order-api` |
| Đăng nhập | Edge Function riêng | `supabase/functions/order-login` |
| CSDL | Postgres (Supabase, 2 schema: `shared`, `app_order`, plus `public`) | `sql/*.sql` |
| Migration & vận hành | Python scripts | `scripts/*.py` |
| CI/CD | GitHub Actions | `.github/workflows/deploy-edge.yml` |

### 10.3 Bí mật & môi trường

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_SECRET` set qua `supabase secrets set`.
- `config.toml` khai báo `verify_jwt=false` cho cả 2 function (dùng HMAC token nội bộ, không dùng JWT của Supabase).
- Frontend chỉ giữ `SUPABASE_URL` + `anonKey` (đủ để gọi Edge Function), không có service_role.

### 10.4 Deploy

- **Backend**: `supabase functions deploy order-login order-api` (thủ công hoặc qua `.github/workflows/deploy-edge.yml` khi có thay đổi).
- **Frontend**: push nhánh `master`, GitHub Pages serve tĩnh trực tiếp. Đổi Tailwind class → chạy `npm run build:css` và commit lại `dist/app.css`.
- **Migration DB**: chạy tuần tự các file `sql/*.sql` trong Supabase SQL Editor.
- **Nạp dữ liệu master**: `scripts/migrate_catalog.py --dir ./danh_muc` (4 file Excel).
- **Nạp tồn/usage định kỳ**: `scripts/refresh_stock.py --stock ... --usage ...`.

### 10.5 Kịch bản dev local

- Chạy frontend qua `python -m http.server` (hoặc bất kỳ static server nào) trên `localhost` → CORS đã whitelist.
- Backend gọi thẳng Supabase cloud (không có emulator).

---

## 11. Chỉ số thành công (Success Metrics / KPIs)

**KPI vận hành**
- Số đợt tạo/tuần theo BU và miền.
- Thời gian trung bình từ `DRAFT → APPROVED` (giờ). Mục tiêu ≤ 48h cho đợt tiêu chuẩn.
- Tỉ lệ đợt bị Manager từ chối (bounce rate). Mục tiêu < 10%.
- Số SKU/đợt trung bình.

**KPI chất lượng dữ liệu**
- Tỉ lệ SKU có đủ `%SD` (indicator không null) ≥ 95%.
- Tỉ lệ SKU có `safety_stock` cấu hình ≥ 90%.
- Số lần Admin phải `adminSaveItems` để fix dữ liệu — mục tiêu tối thiểu (giảm về 0).

**KPI trải nghiệm**
- Thời gian nạp màn Chi tiết đặt hàng < 3s ở kết nối văn phòng.
- Tỉ lệ đăng nhập thất bại do quên mật khẩu / rate limit < 5%.

**KPI bảo mật**
- Tỉ lệ tài khoản đã lên `password_hash_v2` = 100% trong 30 ngày sau go-live.
- 0 sự cố lộ token, 0 truy cập trực tiếp Postgres từ frontend.

---

## 12. Rủi ro, giả định & Hướng phát triển (Risks / Future)

### 12.1 Rủi ro
| Mã | Rủi ro | Giảm nhẹ |
|---|---|---|
| R1 | Danh mục dùng chung được app khác sửa lệch | RLS + service_role, quy định 1 chủ sở hữu `dm_vat_tu` |
| R2 | Người dùng dùng token cũ sau khi role đổi | TTL 8h + kiểm tra `ORDER_ROLES` mỗi request |
| R3 | Stock aggregate sai do cycledate lệch | `resolveStockCycledate` + test data hàng tuần |
| R4 | PM sửa nhầm SKU ngoài scope | Chặn cả read + write ở Edge Function; frontend disable ô |
| R5 | Xung đột 2 người sửa 1 đợt | "Ai lưu sau thắng"; audit log truy vết; roadmap: optimistic lock qua `updated_at` |
| R6 | Trang lớn (>2000 SKU) chậm | Đã có RPC + phân trang; roadmap: virtualized table |
| R7 | Password v1 (SHA-256) còn tồn tại | Lazy migrate v2; roadmap: force reset |
| R8 | Rate limit chặn nhầm nhiều user cùng IP | Ngưỡng cấu hình được, cửa sổ 15 phút; roadmap: unlock qua admin panel |

### 12.2 Giả định
- Toàn bộ user đăng nhập bằng SSO nội bộ (hiện tại là username/password chung).
- Tồn kho / usage được xuất định kỳ từ Bravo và nạp qua `refresh_stock.py`.
- Danh mục master `dm_vat_tu` được cập nhật tập trung, mọi web app khác đọc-only phần này.
- Chỉ chạy trên trình duyệt hiện đại (Chrome/Edge/Safari mới nhất).

### 12.3 Hướng phát triển
- **Đa nhóm PM trên cùng đợt**: hiện PM duyệt xong là đẩy cả đợt sang `PM_APPROVED`. Roadmap: chờ tất cả PM (theo nhóm SP) duyệt xong mới chuyển bước.
- **Kết nối trực tiếp Bravo**: thay `refresh_stock.py` bằng job đồng bộ tự động.
- **Realtime notification**: Manager nhận ping ngay khi PM duyệt xong.
- **Dashboard KPI**: trang tổng quan cho khối Cung ứng.
- **Import excel đề xuất**: AM upload file để tạo `sl_dat` hàng loạt.
- **Optimistic locking**: dùng `updated_at` để cảnh báo xung đột.
- **Force reset password**: sau khi tỉ lệ v2 = 100% thì bỏ v1.
- **RLS granular**: chuyển bớt logic phạm vi từ Edge Function xuống policy (khi user trực tiếp truy cập DB, hiện chưa cần).

---

## 13. Phụ lục — Từ điển thuật ngữ & Ánh xạ field ↔ Cột DB

### 13.1 Từ điển thuật ngữ

| Thuật ngữ | Giải thích |
|---|---|
| **BU** | Business Unit — ngành hàng (CH&CS, CTTM & CTUT, …) |
| **Miền** | MB (Miền Bắc) / MN (Miền Nam) |
| **AM** | Area Manager — quản lý khu vực, đề xuất số lượng |
| **PM** | Product Manager — quản lý ngành hàng, duyệt số lượng theo nhóm sản phẩm |
| **Manager** | Trưởng khối / cấp phê duyệt cuối |
| **Purchasing** | Nhân viên Mua hàng, ghi PO |
| **Mã Bravo** | Mã SKU theo hệ ERP Bravo |
| **Nhóm sản phẩm (`nhom_san_pham`)** | Cấp phân loại 2, dùng cho scope của PM và filter đợt |
| **Sản phẩm (`san_pham`)** | Cấp phân loại 3, dùng để aggregate TB KH / TB TH |
| **DA / GU / KG** | Loại kho: DA = tồn thường, GU = vét thầu, KG = ký gửi |
| **Tổng tồn** | `DA + KG + đi_đường − vét_thầu` |
| **TB TH** | Trung bình tháng thực hiện (12 tháng có phát sinh trong cửa sổ) |
| **TB KH** | Trung bình kế hoạch 3 tháng tới (từ `sale_target`) |
| **Safety stock** | Tồn an toàn cấu hình theo SKU (`dm_vat_tu.safety_stock`) |
| **Số tháng đặt** | Bao nhiêu tháng nhu cầu muốn đặt trong đợt |
| **Leadtime tháng** | Số tháng offset cửa sổ TB KH (thời gian hàng về) |
| **Gợi ý đặt** | Số lượng đề xuất auto: `max(0, (k1·TB TH + k2·TB KH) × số tháng đặt + safety − tổng tồn)` |
| **%SD (`ty_le_sd_pct`)** | Tỷ lệ SL của SKU trong tổng SL của sản phẩm (dùng để phân bổ gợi ý xuống SKU) |
| **Scope** | Cột `users.scope`, danh sách `nhom_san_pham` PM phụ trách (phân tách bằng `,` hoặc `;`) |
| **Đề nghị mua hàng (DM)** | Số đề nghị bên Bravo do Mua hàng nhập |
| **PO** | Số Purchase Order Bravo |

### 13.2 Ánh xạ field UI ↔ Cột DB

**Đợt đặt hàng (Session)**

| UI | Cột | Bảng |
|---|---|---|
| Tên đợt | `ten_dot` | `app_order.order_sessions` |
| Miền | `mien` | `app_order.order_sessions` |
| BU | `bu` | `app_order.order_sessions` |
| Nhóm sản phẩm | `nhom_san_pham` (chuỗi "A;B") | `app_order.order_sessions` |
| Trạng thái | `trang_thai` | `app_order.order_sessions` |
| Ngày mở | `ngay_mo` | `app_order.order_sessions` |
| Ngày đóng | `ngay_dong` | `app_order.order_sessions` |
| Ngày AM xác nhận | `ngay_yeu_cau` | `app_order.order_sessions` |
| Ngày PM duyệt | `ngay_pm_duyet` | `app_order.order_sessions` |
| Ngày Manager duyệt | `ngay_manager_duyet` | `app_order.order_sessions` |
| Lý do từ chối | `ly_do_tu_choi` | `app_order.order_sessions` |
| Người từ chối | `nguoi_tu_choi` | `app_order.order_sessions` |
| Bước bị từ chối | `tu_choi_o_buoc` | `app_order.order_sessions` |
| Đề nghị mua hàng | `de_nghi_mua_hang` | `app_order.order_sessions` |
| PO | `po` | `app_order.order_sessions` |
| Người tạo đợt | `tao_boi` | `app_order.order_sessions` |

**Dòng đặt hàng (Item)**

| UI | Cột | Bảng |
|---|---|---|
| SL yêu cầu (AM) | `sl_dat` | `app_order.order_items` |
| Ghi chú AM | `ghi_chu_dat` | `app_order.order_items` |
| SL duyệt (PM) | `sl_duyet` | `app_order.order_items` |
| Ghi chú PM | `ghi_chu_duyet` | `app_order.order_items` |
| SL đặt hàng (Manager) | `sl_dat_hang` | `app_order.order_items` |
| Ghi chú Manager | `ghi_chu_dat_hang` | `app_order.order_items` |
| Người cập nhật | `updated_by` | `app_order.order_items` |
| Cập nhật lúc | `updated_at` | `app_order.order_items` (trigger `touch_updated_at`) |

**Danh mục vật tư (SKU)**

| UI | Cột | Bảng |
|---|---|---|
| Mã Bravo | `ma_bravo` | `shared.dm_vat_tu` |
| Mã NCC | `ma_ncc` | `shared.dm_vat_tu` |
| Tên hàng | `ten_vat_tu` | `shared.dm_vat_tu` |
| Nhóm sản phẩm | `nhom_san_pham` | `shared.dm_vat_tu` |
| Sản phẩm | `san_pham` | `shared.dm_vat_tu` |
| Phân loại 1 (Nhóm hàng) | `phan_loai_1` | `shared.dm_vat_tu` |
| Phân loại 2 | `phan_loai_2` | `shared.dm_vat_tu` |
| Giá thầu | `don_gia_thau_moi` | `shared.dm_vat_tu` |
| BU | `bu` (+ `bu_code`) | `shared.dm_vat_tu` |
| Mức độ SD | `muc_do_sd` | `shared.dm_vat_tu` |
| Safety stock | `safety_stock` | `shared.dm_vat_tu` |
| Cho đặt hàng | `dat_hang` | `shared.dm_vat_tu` |

**Tồn kho & indicator**

| UI | Cột / RPC | Bảng |
|---|---|---|
| Tồn kho (DA) | `stock_agg.ton_kho` | `app_order.stock` |
| Hàng KTV/BV (KG) | `stock_agg.hang_ktv_bv` | `app_order.stock` |
| Hàng vét thầu (GU) | `stock_agg.hang_vet_thau` | `app_order.stock` |
| Hàng đi đường | `stock_agg.hang_di_duong` | `app_order.stock` |
| Tổng tồn | `stock_agg.tong_ton` | `app_order.stock` |
| TB TH | `usage_indicators.tb_th` | `app_order.usage_indicators` |
| TB KH 3 tháng | `usage_indicators.tb_kh_3_thang` | `app_order.usage_indicators` |
| SL TH FY24 / FY25 / FY26 YTD | `sl_th_fy24 / sl_th_fy25 / sl_th_fy26_ytd` | `app_order.usage_indicators` |
| %SD | `ty_le_sd_pct` | `app_order.usage_indicators` |

**Cấu hình gợi ý**

| UI | Cột JSONB (`app_order.app_config.value`) |
|---|---|
| k1 (TB tháng TH) | `k1` |
| k2 (TB KH) | `k2` |
| Số tháng đặt mặc định | `so_thang_dat_default` |
| Leadtime mặc định | `leadtime_thang_default` |
| Override theo nhóm SP | `groups.<nhom_san_pham>.{k1, k2, so_thang_dat, leadtime_thang}` |

**Nhật ký**

| UI | Cột | Bảng |
|---|---|---|
| Thời điểm | `timestamp` | `app_order.audit_log` |
| Người thực hiện | `username` | `app_order.audit_log` |
| Hành động | `action` | `app_order.audit_log` |
| Session | `session_id` | `app_order.audit_log` |
| Chi tiết | `detail` | `app_order.audit_log` |

---

*Hết tài liệu. Mọi thay đổi thiết kế/nghiệp vụ vui lòng cập nhật vào PRD này để đồng bộ với code (`sql/*.sql` + `supabase/functions/order-api/index.ts` + `js/**`).*
