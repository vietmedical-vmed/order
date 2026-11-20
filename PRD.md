# PRD — Ứng dụng "Đặt hàng"

- Phiên bản tài liệu: 2.0
- Ngày cập nhật: 2026-11-20 (đồng bộ với code tới commit `10cee5b`)
- Chủ sở hữu sản phẩm: Vietmedical — Bộ phận Cung ứng / Kinh doanh
- Repo: `order/` (Supabase + GitHub Pages, dùng chung danh mục `shared.*` với các web app khác)

---

## 0. Có gì mới so với bản 1.0 (2026-09-16)

| Mảng | Thay đổi chính |
|---|---|
| Đa BU | BU chuẩn hoá theo từ điển dùng chung `shared.dm_bu` (khoá = `bu_code`: `chcs`, `cttm`, `thnk`…). FK/CHECK khoá BU, nhóm SP, miền (sql/15–17). |
| Luồng duyệt | BU CTTM bỏ bước PM: Manager phê duyệt gộp 2 cấp từ `SUBMITTED`. PM tạo đợt thì đợt vào thẳng `SUBMITTED`. PM được từ chối đợt `SUBMITTED`. Manager được sửa SL đặt hàng ở đợt `APPROVED`. |
| Mua hàng | Thêm trạng thái cuối `COMPLETED`. Một đợt có nhiều PO (`order_session_po`). Manager được sửa PO/DM. Cột "Ngày đặt hàng" = ngày điền PO đầu tiên. |
| Tên đợt | Server tự đặt tên theo mẫu cố định; người dùng không nhập tên. |
| Chủ sở hữu ĐKLH | Đợt Miền Nam nhóm Khớp UOC / NSK Arthrex phải chọn chủ sở hữu ĐKLH (xuất xứ); tồn kho và gợi ý tính theo lô của chủ sở hữu đó. |
| AM | Một AM phụ trách được nhiều miền (`users.mien = "MB, MN"`). |
| Thông báo | Email tự động ở mỗi bước (outbox `shared.notifications` + Edge Function `notify-sender`, SMTP hoặc Zimbra SOAP). Email kèm deep-link mở đợt và link tải Excel. Admin quản lý email người nhận trong app. |
| Chỉ số | TB tháng TH: mã "Hay sử dụng" dùng cửa sổ 6 tháng, còn lại 12 tháng. Mã ngoài CH&CS lấy SL thực hiện từ hoá đơn (`app_sale.hoa_don_bovattu`). Hàng đi đường / ký gửi lưu lịch sử theo snapshot. |
| Màn hình mới | Báo cáo đặt hàng (theo tháng), Kiểm chứng gợi ý (backtest, Admin), Cấu hình hệ thống chia 3 tab con. |
| Quản lý đợt | Nhóm theo tháng, nhóm cột "Tiến trình" thu gọn được, cột Tạo bởi / Chủ sở hữu / TT đặt hàng, header dính + thanh cuộn ngang phía trên, xuất Excel danh sách đợt. |
| Bảo mật | Kiểm tra `shared.users.active` ở mọi request. Đăng nhập từ chối mật khẩu cũ khi hệ thống khác đã đổi `password_hash`. |
| Đã bỏ | Trạng thái `CLOSED` và nút "Chốt đợt"; ô "Ngày đóng đợt" khi tạo đợt; tính năng "SKU tồn thấp"; tự điền gợi ý vào SL yêu cầu. |

---

## 1. Tổng quan (Overview)

Ứng dụng "Đặt hàng" là web app SPA phục vụ quy trình **đề xuất — duyệt — đặt hàng vật tư y tế** cho khối Cung ứng của Vietmedical. Hệ thống thay thế Google Sheets + Apps Script cũ. Toàn bộ nghiệp vụ chạy trên **Supabase (Postgres + Edge Functions)**, dùng **danh mục chung** (`shared.dm_*`, `shared.users`) với các app nội bộ khác. Frontend là HTML tĩnh + ES modules, host trên GitHub Pages, không cần bundler.

Sản phẩm hiện tại hỗ trợ:
- Nhiều **BU** (CH&CS, CTTM & CTUT, THNS & CSVT…). Mỗi đợt gắn 1 BU, 1 miền (MB/MN), một hoặc nhiều nhóm sản phẩm, và (khi bắt buộc) 1 chủ sở hữu ĐKLH.
- Luồng duyệt: **AM đề xuất → PM duyệt → Manager phê duyệt → Mua hàng nhập PO → Hoàn thành**. BU CTTM: Manager duyệt gộp thay PM.
- Gợi ý số lượng đặt: `(k1·TB tháng TH + k2·TB tháng KH) × số tháng đặt + Safety stock − Tổng tồn`, tính ở mức sản phẩm rồi phân bổ về SKU theo `%SD`.
- Cấu hình danh mục (bật/tắt đặt hàng, safety stock, mức độ sử dụng) và cấu hình công thức (mặc định + override theo nhóm sản phẩm, có lịch sử phiên bản).
- Email thông báo tự động theo từng bước, kèm link mở đợt và link tải Excel.
- Báo cáo đặt hàng theo tháng; công cụ kiểm chứng (backtest) công thức gợi ý.
- Nhật ký (audit log) mọi thao tác.

Mục tiêu: chuẩn hoá dữ liệu đặt hàng vào Postgres, bỏ phụ thuộc bảng tính, mở rộng cho nhiều BU, và làm nguồn dữ liệu cho báo cáo tồn kho / dự báo mua hàng.

---

## 2. Bối cảnh & Vấn đề (Background & Problem)

### 2.1 Bối cảnh
Trước đây quy trình đặt hàng chạy trên Google Sheets + Apps Script:
- Mỗi đợt là 1 tab riêng. Dữ liệu chép tay giữa Area Manager, Product Manager, Manager và Mua hàng.
- Công thức gợi ý cứng trong bảng tính, không có lịch sử phiên bản.
- Danh mục vật tư (Mã Bravo, giá, nhóm, phân loại) trùng lặp giữa nhiều bảng tính, dễ lệch.
- Tồn kho từ ERP Bravo xuất Excel định kỳ và ghép thủ công.

### 2.2 Vấn đề chính
1. **Xung đột dữ liệu**: mã, tên, giá, phân loại giữa các bảng tính không đồng bộ.
2. **Không có phân quyền thực sự**: ai vào sheet cũng sửa được ngoài phạm vi.
3. **Không có lịch sử duyệt**: khó truy vết ai duyệt số nào, khi nào, vì sao từ chối.
4. **Công thức không phiên bản hoá**: đổi hệ số thì không tra lại được gợi ý của đợt cũ.
5. **Không mở rộng đa BU**: bảng tính gốc chỉ phục vụ CH&CS.
6. **Tồn kho không đồng bộ**: gộp DA/GU/KG thủ công, dễ tính sai "Tổng tồn".
7. **Thông báo thủ công**: các bên phải nhắn tin báo nhau khi đợt chuyển bước.

### 2.3 Mục tiêu triển khai
- Chuyển nghiệp vụ đặt hàng sang backend có kiểm soát (Postgres + Edge Functions).
- Một danh mục vật tư dùng chung (`shared.dm_vat_tu`) và một từ điển BU / miền dùng chung.
- Số hoá luồng duyệt, có audit log và email tự động; phiên bản hoá cấu hình gợi ý.
- Phục vụ nhiều BU / nhiều miền / nhiều nhóm sản phẩm.

---

## 3. Mục tiêu & Phi mục tiêu (Goals / Non-goals)

### 3.1 Mục tiêu (Goals)

**G1. Luồng đặt hàng số hoá đầu — cuối.** Từ AM tạo đề xuất tới Mua hàng nhập PO và hoàn thành đợt, tất cả trong app.

**G2. Danh mục dùng chung.** Tên / giá / NCC / phân loại SKU chỉ ở `shared.dm_vat_tu`. BU và miền chỉ ở từ điển `shared.dm_bu` / `shared.dm_mien`. App giữ thêm thuộc tính đặt hàng (`dat_hang`, `muc_do_sd`, `safety_stock`) trên chính `dm_vat_tu`.

**G3. Phân quyền theo phạm vi.** AM theo miền + BU. PM theo `scope` (nhóm sản phẩm phụ trách). Mọi role có thể bị giới hạn thêm theo `users.nhom_san_pham`. Server chặn cả đọc và ghi ngoài phạm vi.

**G4. Gợi ý minh bạch và phiên bản hoá.** Công thức mặc định + override theo nhóm sản phẩm, có `order_config_log`. Tooltip công thức trên từng cột chỉ số. Có công cụ backtest để đánh giá công thức.

**G5. Đa BU / đa miền / chủ sở hữu ĐKLH.** Đợt có `bu`, `mien`, `nhom_san_pham`, `csh_dklh`.

**G6. Thông báo tự động.** Mỗi lần đợt chuyển bước, người liên quan nhận email.

**G7. Audit log đầy đủ.** Mọi thay đổi trạng thái, số lượng, PO, cấu hình, đăng nhập đều ghi vào `app_order.audit_log`.

**G8. Hiệu năng.** Gộp tồn kho / usage / indicator bằng RPC Postgres. RPC nặng dùng kết nối Postgres trực tiếp để tránh giới hạn 8 giây của PostgREST.

**G9. Bảo mật.** RLS bật toàn bộ, deny anon. Edge Function dùng `service_role`. Token HMAC-SHA256 TTL 8 giờ. Mật khẩu lazy migrate lên PBKDF2 (210k vòng). Rate limit đăng nhập. Khoá tài khoản có hiệu lực ngay.

### 3.2 Phi mục tiêu (Non-goals)

- **Không quản lý PO đầy đủ**: chỉ lưu số PO / số đề nghị mua hàng do Mua hàng nhập; không tạo chứng từ PO.
- **Không lập hoá đơn / thanh toán.**
- **Không thay thế Bravo ERP**: tồn kho, giá, mã hàng vẫn từ Bravo (nạp qua script).
- **Không phải hệ thống dự báo ML**: gợi ý là công thức tuyến tính có hệ số.
- **Không có mobile app riêng**: chỉ web responsive.
- **Không sửa đồng thời nhiều người**: "ai lưu sau thắng" (trừ bước hoàn thành đợt có khoá theo trạng thái).

---

## 4. Đối tượng người dùng & Phân quyền (Personas & Roles)

### 4.1 Personas

| Persona | Vai trò | Nhu cầu chính |
|---|---|---|
| **AM (Area Manager)** | Đề xuất SL đặt cho miền mình phụ trách (1 hoặc nhiều miền) | Tạo đợt, nhập `sl_dat`, sửa tới khi PM duyệt, hủy khi cần |
| **PM (Product Manager)** | Duyệt SL theo nhóm sản phẩm | Chỉ thấy/sửa SKU trong `scope`, nhập `sl_duyet`, từ chối đợt về AM, tự tạo đợt |
| **MANAGER** | Phê duyệt cuối | Nhập `sl_dat_hang`, phê duyệt hoặc từ chối; BU CTTM duyệt gộp thay PM; sửa SL đặt hàng ở đợt đã duyệt; sửa PO |
| **PURCHASING** | Mua hàng | Theo dõi đợt từ `SUBMITTED`; nhập PO + đề nghị mua hàng (DM); hoàn thành đợt |
| **ADMIN** | Quản trị hệ thống | Cấu hình công thức, email, chỉ số; ghi đè số liệu; backtest; xem nhật ký |

### 4.2 Bảng phân quyền theo hành động

Role gốc trong `shared.users.role` được map sang mã nội bộ (`ROLE_MAP` trong `supabase/functions/order-api/index.ts`):
`admin→ADMIN`, `manager→MANAGER`, `area_manager / sale_manager / ps→AM`, `product_manager→PM`, `purchasing→PURCHASING`. Role khác bị chặn.

| Hành động | AM | PM | MANAGER | ADMIN | PURCHASING |
|---|:-:|:-:|:-:|:-:|:-:|
| Tạo đợt 1 miền | ✅ miền mình | ✅ nhóm trong scope, vào thẳng `SUBMITTED` | ❌ | ✅ | ❌ |
| Tạo đợt cả 2 miền | ❌ | ✅ | ❌ (xem R9) | ✅ | ❌ |
| Nhập `sl_dat` | ✅ `DRAFT` / `SUBMITTED` | ❌ | ❌ | ✅ ghi đè | ❌ |
| PM duyệt (`sl_duyet`) | ❌ | ✅ `SUBMITTED`; sửa tiếp ở `PM_APPROVED` | ✅ chỉ BU CTTM ở `SUBMITTED` | ✅ | ❌ |
| Manager phê duyệt (`sl_dat_hang`) | ❌ | ❌ | ✅ `PM_APPROVED`; sửa tiếp ở `APPROVED` | ✅ | ❌ |
| Từ chối (trả `DRAFT`) | ❌ | ✅ khi `SUBMITTED` | ✅ khi `PM_APPROVED` (CTTM: cả `SUBMITTED`) | ✅ | ❌ |
| Hủy đợt | ✅ `DRAFT` / `SUBMITTED` miền mình | ❌ | ❌ | ✅ | ❌ |
| Thêm / xóa PO, Hoàn thành đợt | ❌ | ❌ | ❌ | ✅ | ✅ |
| Sửa PO / DM / ghi chú PO | ❌ | ❌ | ✅ | ✅ | ✅ |
| Xuất Excel đợt (mọi trạng thái) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Xem "Quản lý đặt hàng" | ✅ chỉ xem | ✅ | ✅ | ✅ | ✅ chỉ xem + PO |
| Danh mục đặt hàng (`saveCatalog`) | ❌ | ✅ SKU trong scope | ✅ | ✅ | ❌ |
| Báo cáo đặt hàng | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cấu hình hệ thống (công thức, email, chỉ số) | ❌ | ❌ | ❌ | ✅ | ❌ |
| Kiểm chứng gợi ý | ❌ | ❌ | ❌ | ✅ | ❌ |
| Tab Nhật ký | ❌ | ❌ | ❌ | ✅ | ❌ |

### 4.3 Phạm vi dữ liệu

- **AM**: thấy đợt có `mien` thuộc danh sách miền của mình. `users.mien` nhận nhiều giá trị (`"MB, MN"`); rỗng / `BOTH` / `ALL` = mọi miền. Đợt lọc thêm theo `users.bu`.
- **PM**: `scope` là danh sách nhóm sản phẩm, phân tách bằng `,` hoặc `;`, so khớp không phân biệt hoa/thường. Đợt "tất cả nhóm" vẫn hiện.
- **Mọi role**: nếu `users.nhom_san_pham` có giá trị thì danh sách đợt và nhóm sản phẩm bị giới hạn theo đó.
- **MANAGER**: thấy đợt từ `SUBMITTED` trở đi (để duyệt gộp CTTM).
- **PURCHASING**: thấy đợt từ `SUBMITTED` trở đi (theo dõi), thao tác ở `APPROVED` / `COMPLETED`.
- **ADMIN**: toàn quyền; `adminSaveItems` ghi đè bất kỳ cột số lượng nào ở bất kỳ trạng thái nào, không đổi trạng thái.
- Server đọc `bu`, `scope`, `nhom_san_pham` trực tiếp từ `shared.users` ở mỗi request, nên thay đổi quyền có hiệu lực ngay, không chờ token hết hạn.

---

## 5. Luồng nghiệp vụ chính (User Flows)

### 5.1 Trạng thái đợt (`order_sessions.trang_thai`)

```
     AM tạo                        PM tạo
DRAFT ──────────► SUBMITTED ◄───────────────
  ▲  AM xác nhận    │      │
  │                 │      │ BU CTTM: Manager phê duyệt gộp
  │  PM từ chối ◄───┤      │
  │                 │ PM duyệt
  │                 ▼      │
  │            PM_APPROVED │
  │ Manager từ chối ◄─┤    │
  │                   │ Manager phê duyệt
  │                   ▼    ▼
  │                 APPROVED  (Manager vẫn sửa được SL đặt hàng)
  │                   │ Mua hàng nhập ≥ 1 PO, bấm "Hoàn thành đợt"
  │                   ▼
  │                 COMPLETED (Hoàn thành)
  │
  └── CANCELED (AM hủy khi còn DRAFT / SUBMITTED)
```

- Trạng thái cuối: `COMPLETED` và `CANCELED`.
- Từ chối luôn trả về `DRAFT`, xoá `ngay_pm_duyet` / `ngay_manager_duyet`, ghi `ly_do_tu_choi`, `nguoi_tu_choi`, `tu_choi_o_buoc` (`PM` / `Manager` / `Manager (CTTM)`), `tu_choi_luc`.
- Khi AM xác nhận lại từ `DRAFT`, các cột từ chối cũ bị xoá.
- `CLOSED` đã bỏ; code chỉ còn đọc giá trị này cho dữ liệu cũ.

### 5.2 Luồng chính

**F1. Tạo đợt**
1. Người dùng bấm "Tạo đợt mới", chọn miền (1 miền hoặc cả 2 miền), BU (mặc định `users.bu`), một hoặc nhiều nhóm sản phẩm (hoặc "Tất cả nhóm"). Danh sách nhóm lọc theo BU đã chọn.
2. Nếu miền + nhóm thuộc phạm vi chủ sở hữu ĐKLH (hiện tại: Miền Nam, nhóm Khớp UOC hoặc NSK Arthrex), bắt buộc chọn chủ sở hữu. Danh sách chủ sở hữu = các CSH đang có lô tồn; không có lựa chọn "Không có thông tin".
3. Server tự đặt tên đợt (form chỉ hiện bản xem trước):
   `T{tháng}/{năm} · {MÃ BU} · {nhóm SP | Tất cả nhóm} [· CSH {chủ sở hữu}] · Đợt {n}`
   - Tháng/năm theo giờ Việt Nam. Hơn 3 nhóm: 2 nhóm đầu + `+N`.
   - `n` = số đợt lớn nhất cùng phần đầu + 1. Cặp đợt MB/MN tạo cùng lúc dùng chung 1 tên.
4. AM / Admin tạo: đợt ở `DRAFT`. PM tạo: đợt vào thẳng `SUBMITTED` (`ngay_yeu_cau` = lúc tạo), nhóm phải nằm trong scope của PM.
5. Tạo cả 2 miền: tạo đợt MN trước (có thể bị từ chối vì thiếu CSH), rồi MB.

**F2. AM nhập SL yêu cầu**
1. AM mở màn "Chi tiết đặt hàng". Danh mục = `dm_vat_tu` có `dat_hang = true`, lọc theo phạm vi AM + nhóm của đợt.
2. AM tự nhập `sl_dat` và `ghi_chu_dat` (gợi ý chỉ hiển thị, không tự điền vào ô).
3. "Xác nhận" (`amConfirm`): `DRAFT → SUBMITTED`, ghi `ngay_yeu_cau`, gửi email `SUBMIT`.
4. Khi `SUBMITTED` mà PM chưa duyệt: AM vẫn sửa được ("Cập nhật SL yêu cầu", audit `AM_UPDATE`), trạng thái giữ nguyên.

**F3. PM duyệt**
1. PM mở đợt `SUBMITTED`, chỉ thấy SKU trong scope.
2. Nhập `sl_duyet`, `ghi_chu_duyet`. "Xác nhận" (`pmConfirm`): `SUBMITTED → PM_APPROVED`, ghi `ngay_pm_duyet`, gửi email `PM_APPROVE`.
3. Khi `PM_APPROVED` và Manager chưa duyệt: PM vẫn sửa được (`PM_UPDATE`).
4. "Phê duyệt nhanh" ở màn Quản lý (`approveSession`): chép `sl_duyet ← sl_dat` và chuyển bước.
5. "Từ chối" (bắt buộc lý do): đợt về `DRAFT` cho AM sửa, gửi email `REJECT`.
6. Cho phép xác nhận khi SL = 0 nếu có ghi chú.

**F4. Manager phê duyệt**
1. Đợt `PM_APPROVED`: Manager nhập `sl_dat_hang` (mặc định chép từ `sl_duyet`). "Phê duyệt" (`managerApprove`): `→ APPROVED`, ghi `ngay_manager_duyet`, gửi email `MANAGER_APPROVE`. Hoặc "Từ chối" (bắt buộc lý do).
2. **BU CTTM** (mọi nhóm SP của đợt thuộc BU `cttm`): không có PM. Manager mở đợt `SUBMITTED`, sửa `sl_duyet`, bấm "Phê duyệt" (`managerApproveCttm`): lưu `sl_duyet`, chép sang `sl_dat_hang`, đẩy thẳng `APPROVED`.
3. Đợt `APPROVED`: Manager vẫn sửa `sl_dat_hang` ("Cập nhật SL đặt hàng", audit `MANAGER_EDIT_APPROVED`), trạng thái giữ nguyên. Đợt `COMPLETED` khoá với Manager (chỉ Admin ghi đè).

**F5. Mua hàng nhập PO → Hoàn thành đợt**
1. Mua hàng mở đợt `APPROVED`, xuất Excel nếu cần, tạo DM + PO bên Bravo.
2. Mở "Nhập PO". Mỗi dòng PO (`addSessionPO`) gồm `po` (bắt buộc, không trùng trong đợt), `de_nghi_mua_hang`, `ghi_chu`. Xóa bằng `deleteSessionPO`.
3. "Hoàn thành đợt" (`completeSession`) cần ≥ 1 PO. Có thể nhập PO ngay trong form rồi hoàn thành, không phải bấm "+ Thêm PO" trước. `APPROVED → COMPLETED`, lưu `nguoi_mua_hang`, `ngay_mua_hang`, gửi email `PURCHASE`. Cập nhật có điều kiện theo trạng thái: hai người bấm cùng lúc thì chỉ một người thành công.
4. Đợt `COMPLETED` vẫn thêm/xóa PO được nhưng phải còn ≥ 1 PO; không đổi trạng thái, không gửi email.
5. Sửa PO đã có (`updateSessionPO`): Mua hàng, Manager, Admin; đợt `APPROVED` hoặc `COMPLETED`. Audit `PO_UPDATE` ghi giá trị cũ → mới.
6. `order_sessions.po` / `de_nghi_mua_hang` là cột tóm tắt ("PO1; PO2"), server ghi lại sau mỗi lần thêm/sửa/xóa PO.
7. **Ngày đặt hàng** = ngày điền PO đầu tiên (`min(order_session_po.tao_luc)`).

**F6. Danh mục đặt hàng (Admin / Manager / PM)**
1. Lọc theo BU và nhiều nhóm sản phẩm. SKU nhóm theo Sản phẩm (dòng cha gập/mở), nhóm sắp xếp ABC tiếng Việt.
2. Sửa `dat_hang` (bật/tắt), `muc_do_sd` ("Hay sử dụng" / "Ít sử dụng" / "Hiếm khi sử dụng"), `safety_stock` (số nguyên ≥ 0). PM chỉ thấy và sửa SKU trong scope.
3. Lưu (`saveCatalog`): gom patch giống nhau, UPDATE theo lô 200 SKU.

**F7. Cấu hình hệ thống (Admin)** — 3 tab con, mỗi tab có thanh lưu dính đáy:
1. **Công thức gợi ý**: `k1`, `k2`, `so_thang_dat_default`, `leadtime_thang_default` + override theo nhóm sản phẩm. Lưu (`saveConfig`) cập nhật `app_config.goi_y` và thêm 1 dòng `order_config_log`.
2. **Email thông báo**: danh sách user, sửa email nhận (`shared.users.email`, nhiều email ngăn bằng `,` hoặc `;`).
3. **Dữ liệu & chỉ số**: thông tin lần tính cache gần nhất và nút "Tính lại chỉ số" (`refreshIndicators` → RPC `refresh_usage_indicators`).

**F8. Đăng nhập / đổi mật khẩu**
1. `order-login`: rate limit theo (username, IP), cửa sổ 15 phút → tra `shared.users` → verify `password_hash_v2` (PBKDF2), fallback SHA-256 [+salt] → lazy upgrade lên v2.
2. Nếu hệ thống khác đã đổi `password_hash` (v1) thì v2 cũ không còn được chấp nhận.
3. Token `payload.sig` HMAC-SHA256 TTL 8 giờ. Payload: `username, ho_ten, role, mien, bu, scope, exp`.
4. Mọi request API kiểm tra `shared.users.active`; tài khoản bị khoá mất quyền ngay.
5. Đổi mật khẩu trong app: cập nhật salt + hash v1 (tương thích app khác) + hash v2.

### 5.3 Luồng phụ

- **Xuất Excel đợt** (`exportOrderData`): mọi role, mọi trạng thái. Tên file `<tên đợt>_<trạng thái>.xlsx`. Có 3 cột ghi chú (AM / PM / Manager); không có ĐVT / Đơn giá / Thành tiền.
- **Xuất Excel danh sách đợt** (màn Quản lý): 1 dòng / đợt theo bộ lọc hiện tại, tiêu đề cột khớp bảng, có Số PO, PO, DM, người/ngày hoàn thành, ngày đặt hàng.
- **Deep-link**: `?session=<id>&mien=<MB|MN>` mở thẳng đợt (dùng trong email).
- **Nhật ký** (`loadAuditLog`): lọc theo user / action / đợt, tối đa 200 dòng.
- **Admin ghi đè** (`adminSaveItems`): sửa `sl_dat / sl_duyet / sl_dat_hang` ở mọi trạng thái, chỉ ghi ô đã sửa.

---

## 6. Yêu cầu chức năng (Functional Requirements)

### 6.1 Danh sách action Edge Function `order-api`

Gọi qua `POST /functions/v1/order-api`, body `{ action, token, args:[...] }`. Handler nằm trong object `H` của `supabase/functions/order-api/index.ts`.

| Action | Mô tả | Quyền |
|---|---|---|
| `getCurrentUser` / `logout` / `auditPing` | Thông tin user, ghi LOGOUT, healthcheck | Mọi role |
| `listProductGroups` | Nhóm SP cho form tạo đợt (lọc theo BU) | Mọi role |
| `listCshOptions` | Miền/nhóm bật CSH + danh sách chủ sở hữu | Mọi role |
| `listBU` | BU từ `shared.dm_bu` (bỏ BU không active / test) | Mọi role |
| `getConfig` / `saveConfig` / `listConfigLog` | Cấu hình gợi ý + lịch sử | get: mọi role; save/log: ADMIN |
| `listUserEmails` / `saveUserEmails` | Email nhận thông báo | ADMIN |
| `refreshIndicators` / `indicatorsInfo` | Tính lại / xem cache `usage_indicators` | ADMIN |
| `backtestGoiY` | Kiểm chứng gợi ý tại 1–12 mốc `YYYY-MM` | ADMIN |
| `listCatalog` / `saveCatalog` | Danh mục đặt hàng | ADMIN / MANAGER / PM (scope) |
| `listSessions` | Danh sách đợt + stats + ngày đặt hàng + họ tên người tạo | Mọi role (theo phạm vi) |
| `loadOrderScreen` | Nạp màn Chi tiết đặt hàng (rows, session, editContext) | Mọi role |
| `createSession` / `createSessionBoth` | Tạo đợt 1 miền / cả 2 miền | Xem 4.2 |
| `amConfirm` | Lưu `sl_dat`; `DRAFT→SUBMITTED` hoặc giữ `SUBMITTED` | AM / ADMIN |
| `pmConfirm` | Lưu `sl_duyet`; `SUBMITTED→PM_APPROVED` hoặc giữ `PM_APPROVED` | PM / ADMIN |
| `managerApprove` | Lưu `sl_dat_hang`; `PM_APPROVED→APPROVED` hoặc giữ `APPROVED` | MANAGER / ADMIN |
| `managerApproveCttm` | Duyệt gộp CTTM `SUBMITTED→APPROVED` | MANAGER / ADMIN |
| `approveSession` | Phê duyệt nhanh (chép cột bước trước) | PM / MANAGER / ADMIN |
| `rejectSession` | Từ chối, về `DRAFT`, bắt buộc lý do | PM / MANAGER / ADMIN |
| `cancelSession` | Hủy đợt | AM / ADMIN |
| `listSessionPOs` | Danh sách PO của đợt | Mọi role |
| `addSessionPO` / `deleteSessionPO` | Thêm / xóa PO | PURCHASING / ADMIN |
| `updateSessionPO` | Sửa PO / DM / ghi chú | PURCHASING / MANAGER / ADMIN |
| `completeSession` | Hoàn thành đợt (cần ≥ 1 PO) | PURCHASING / ADMIN |
| `adminSaveItems` | Ghi đè số lượng | ADMIN |
| `approveItems` | Duyệt theo `item_id` (legacy) | PM / MANAGER / ADMIN |
| `exportOrderData` | Dữ liệu xuất Excel đợt | Mọi role |
| `loadOrderReport` | Báo cáo SL đặt hàng theo tháng | Mọi role (theo phạm vi) |
| `loadAuditLog` / `resolveAuditMeta` | Nhật ký + map username/đợt sang tên | Mọi role (AM chỉ của mình) |
| `debugTbKh` | Soi TB KH của 1 SKU | Nội bộ |

Edge Function khác:
- `order-login`: đăng nhập, đổi mật khẩu.
- `notify-sender`: gửi email từ outbox (xem 6.4).

### 6.2 Yêu cầu theo màn hình

Thanh điều hướng: Chi tiết đặt hàng · Quản lý đặt hàng · Danh mục đặt hàng · Báo cáo đặt hàng · Kiểm chứng gợi ý · Cấu hình hệ thống · Nhật ký. Tab ẩn theo quyền (xem 4.2). Bộ lọc nằm trên header, phía trên các tab.

**M1. Đăng nhập** — logo VietMedical, username/password, ghi nhớ đăng nhập. Header có avatar tròn chữ viết tắt + badge role, nút Reload và Đăng xuất. Cảnh báo token sắp hết hạn. Đổi mật khẩu trong app.

**M2. Chi tiết đặt hàng**
- Banner đợt: tên, miền, BU, nhóm, pill CSH (nếu có), nút Tạo đặt hàng và Xuất Excel cùng hàng.
- Bộ lọc: nhóm sản phẩm chọn nhiều, lọc tầng xuống sản phẩm và chủ sở hữu; tìm kiếm; filter "Chủ sở hữu ĐKLH" (chỉ hiện khi dữ liệu có CSH).
- Stat cards 1 dòng, cập nhật theo bộ lọc. Ngày tồn kho hiển thị dạng tag.
- Thẻ nhóm SP (mặc định gập): SKU, Tổng tồn, SL yêu cầu, SL PM duyệt, SL đặt hàng.
- Bảng SKU × chỉ số, cột trái đông cứng, header dính. Gộp trùng cặp (Mã NCC, Mã Bravo), sắp xếp theo Mã NCC A→Z. Số hiển thị làm tròn nguyên; Safety stock hiện "X tháng".
- Tooltip công thức cho Tổng tồn, %SD, TB tháng TH, TB tháng KH, Gợi ý.
- Ô nhập theo bước (AM: `sl_dat`; PM: `sl_duyet`; Manager: `sl_dat_hang`; CTTM Manager: `sl_duyet`; Admin: cả 3).

**M3. Quản lý đặt hàng (danh sách đợt)**
- Lọc theo miền / BU / nhóm SP / trạng thái.
- Đợt nhóm theo tháng mở đợt (tháng hiện tại mở sẵn, các tháng khác gập).
- Cột: Thời gian (ngày mở) · Đợt · Tạo bởi (họ tên) · BU · Nhóm SP · Miền · Chủ sở hữu · Trạng thái (pill 1 dòng) · TT đặt hàng (DM + PO) · Tác vụ.
- Nhóm cột "Tiến trình" bấm để mở/thu: Ngày yêu cầu · PM duyệt · Manager duyệt · Đặt hàng · SKU·SL yêu cầu · SKU·SL duyệt · SKU·SL đặt hàng.
- Header dính, thanh cuộn ngang phía trên bảng.
- Tác vụ theo trạng thái + role: Xem, Phê duyệt nhanh, Từ chối (form lý do), Hủy, Nhập PO.
- Xuất Excel danh sách đợt đang lọc.

**M4. Danh mục đặt hàng** — xem F6. Header bảng dính khi cuộn.

**M5. Báo cáo đặt hàng** — ma trận SKU × tháng theo năm tài chính (tháng 4 → tháng 3), giá trị = Σ `sl_dat_hang` của đợt `APPROVED` / `COMPLETED`. Lọc miền, BU, nhiều nhóm SP, tìm kiếm. Chỉ hiện SKU có SL. Header dính. Xuất Excel.

**M6. Kiểm chứng gợi ý (Admin)** — chọn dải mốc T; server (RPC `backtest_goi_y`) tính lại chỉ số chỉ bằng dữ liệu có trước T, kèm SL thực tế T…T+17. Client áp hệ số + cửa sổ:
- Dự báo = `(k1·TB TH + k2·TB KH) × N`, so với Thực tế = Σ SL các tháng `T+lt … T+lt+N−1`.
- Gợi ý = `max(0, Dự báo + Safety − Tồn tại T)`; Tồn cuối = `Tồn + Gợi ý − Σ thực tế` (< 0 = hết hàng).
- Chỉ số tổng hợp WAPE; dò lưới k1/k2 (bước 0,1) tìm cặp WAPE thấp nhất. Lọc BU / nhóm / miền. Xuất Excel.

**M7. Cấu hình hệ thống (Admin)** — xem F7.

**M8. Nhật ký (Admin)** — lọc theo user / action / đợt. Cột thời gian, người dùng, thao tác, đợt không xuống dòng; cột chi tiết chiếm phần còn lại.

### 6.3 Yêu cầu chức năng chung

- Toast xếp chồng tối đa 3 thông báo.
- Modal xác nhận có focus trap.
- Debounce ô tìm kiếm 250–300 ms.
- SheetJS chỉ tải khi xuất Excel.
- Token lưu `localStorage`; tự đăng xuất khi API trả 401.
- Cảnh báo trước khi rời màn khi còn thay đổi chưa lưu.
- Chặn cuộn chuột làm đổi giá trị ô số.
- Tên app cố định "Đặt hàng", không đổi theo BU.

### 6.4 Thông báo email

**Kiến trúc**: order-api chỉ INSERT vào `shared.notifications` (outbox dùng chung cho nhiều app). Edge Function `notify-sender` chạy theo lịch (pg_cron + pg_net, header `x-cron-secret`), lấy tối đa 20 thư `pending` mỗi lượt, gửi, đánh dấu `sent` / `failed`, thử lại tối đa 5 lần.
- Kênh gửi: SMTP nội bộ (cổng 465; Supabase Edge chặn 25 và 587). Nếu đặt `ZIMBRA_URL` thì gửi qua Zimbra SOAP (HTTPS 443).
- Nội dung chuyển về ASCII không dấu để webmail nội bộ đọc được.
- Lỗi gửi mail không chặn thao tác nghiệp vụ.

**Người nhận theo sự kiện** (`EVENT_ROLES`):

| Sự kiện | Khi nào | Người nhận |
|---|---|---|
| `SUBMIT` | Đợt vào `SUBMITTED` | AM, PM, MANAGER |
| `PM_APPROVE` | Đợt vào `PM_APPROVED` | MANAGER, AM, PM |
| `MANAGER_APPROVE` | Đợt vào `APPROVED` | PURCHASING, AM, PM, MANAGER, ADMIN |
| `REJECT` | Từ chối | AM, PM |
| `CANCEL` | Hủy đợt | PM, MANAGER, AM |
| `PURCHASE` | Hoàn thành đợt | AM, PM, MANAGER |

Lọc thêm: AM chỉ nhận đợt do mình tạo; PM và PURCHASING chỉ nhận khi scope giao với nhóm của đợt (đợt "tất cả nhóm" thì nhận hết); MANAGER / ADMIN nhận hết. User `active = false` bị bỏ (cột `active` NULL vẫn được nhận). Một user có thể có nhiều email.

**Nội dung**: tiêu đề `[Đặt hàng] <sự kiện>: <tên đợt> (<miền>)`; thân gồm đợt, miền, nhóm SP, người tạo, người thao tác, lý do từ chối, DM/PO, link mở app (deep-link, cần secret `APP_URL`) và link tải Excel (public URL Storage).

---

## 7. Mô hình dữ liệu (Data Model)

```
shared.dm_bu / dm_mien  (từ điển BU, miền — khoá FK)
shared.users            username, role, mien, bu, scope, nhom_san_pham, email, active, password_*
shared.dm_nhom_san_pham (bu → nhóm SP)
shared.dm_san_pham
shared.dm_vat_tu        SKU master + dat_hang, muc_do_sd, safety_stock
shared.dm_bo_vat_tu / dm_bo_vat_tu_mapping
shared.dm_ps / dm_dia_ban / dm_khach_hang
shared.notifications    outbox email dùng chung

app_order.order_sessions ──► order_items        (session_id)
                         ──► order_session_po   (session_id)
app_order.audit_log
app_order.stock            tồn theo lô, cycledate, csh_dklh
app_order.logistics_input  hàng đi đường / ký gửi theo snapshot_date
app_order.sv               SL thực hiện CH&CS theo tháng/miền
app_order.usage_stat
app_order.usage_indicators cache chỉ số (refresh qua RPC)
app_order.app_config       goi_y jsonb
app_order.order_config_log lịch sử cấu hình
app_order.order_catalog    legacy, không còn đọc

app_sale.hoa_don_bovattu   SL thực hiện BU khác CH&CS
public.sale_target         kế hoạch theo miền/tháng (nguồn TB KH)
```

### 7.1 Bảng dùng chung (`shared`)

- `dm_bu (bu_code PK, ten_bu, active, is_test, …)` — khoá BU là mã ngắn (`chcs`, `cttm`, `thnk`); tên dài chỉ là nhãn. Alias tên dài cũ vẫn quy đổi được về mã.
- `dm_mien` — khoá `MB / MT / MN`, nhãn "Miền Bắc / Miền Trung / Miền Nam".
- `users` — app đọc `username, ho_va_ten, password_hash, password_hash_v2, salt, role, mien, bu, scope, nhom_san_pham, email, active`.
- `dm_vat_tu` — khoá `ma_bravo`; thuộc tính `ten_vat_tu, ma_ncc, bu, bu_code, nhom_san_pham, san_pham, phan_loai_1, phan_loai_2, don_gia_thau_moi, …`; cột đặt hàng `dat_hang, muc_do_sd, safety_stock`. Danh mục app = `dm_vat_tu WHERE dat_hang = true`. BU của SKU suy ra từ nhóm SP qua `dm_nhom_san_pham`.
- `notifications (app, event, to_emails, subject, body, channel, status, retries, …)`.
- FK / CHECK (sql/16–17) khoá BU, nhóm SP, miền ở các bảng dùng chung; `'all'` và `''` đi qua cột sinh `*_ref`.

### 7.2 Bảng riêng app (`app_order`)

`order_sessions`:
- PK `session_id uuid`.
- `ten_dot, mien, bu (bu_code), nhom_san_pham ("A;B"), csh_dklh, trang_thai (DRAFT|SUBMITTED|PM_APPROVED|APPROVED|COMPLETED|CANCELED), tao_boi, ngay_mo, ngay_dong (chỉ ghi khi hủy), ngay_yeu_cau, ngay_pm_duyet, ngay_manager_duyet, ly_do_tu_choi, nguoi_tu_choi, tu_choi_o_buoc, tu_choi_luc, po, de_nghi_mua_hang (tóm tắt), nguoi_mua_hang, ngay_mua_hang`.

`order_items`:
- PK `item_id`, unique `(session_id, ma_bravo)`.
- `sl_dat, sl_duyet, sl_dat_hang, ghi_chu_dat, ghi_chu_duyet, ghi_chu_dat_hang, updated_at, updated_by`.

`order_session_po` (sql/27):
- PK `po_id`, FK `session_id`, unique `(session_id, po)`.
- `po, de_nghi_mua_hang, ghi_chu, tao_boi, tao_luc`.

`stock`: lô tồn kho theo `ma_bravo, mien, cycledate, warehousetype (DA|GU|KG), so_lo, quantity, csh_dklh, …`.

`logistics_input` (sql/23): 1 dòng / `(snapshot_date, mien, ma_bravo)` với `dd` (đi đường), `kg` (ký gửi). Mỗi lần nạp = 1 snapshot, ghi qua RPC `logistics_replace_snapshot` trong 1 transaction.

`usage_indicators`: `tb_th, tb_kh_3_thang, sl_th_fy24, sl_th_fy25, sl_th_fy26_ytd, ty_le_sd_pct`.

`app_config.goi_y`: `{k1, k2, so_thang_dat_default, leadtime_thang_default, groups}`.

`order_config_log`: `(id, cfg_key, value, created_at, created_by)`.

`audit_log`: `(log_id, timestamp, username, action, session_id, detail)`.

### 7.3 RPC

| RPC | Mục đích |
|---|---|
| `usage_agg`, `usage_fy_agg` | SL thực hiện theo cửa sổ / theo năm tài chính |
| `stock_agg(p_mien, p_ngaymo)` | Gộp DA / GU / KG + đi đường / ký gửi; chọn cycledate và snapshot hiệu lực |
| `stock_csh_agg(p_mien, p_ngaymo)` | Tồn DA / GU tách theo chủ sở hữu ĐKLH |
| `session_stats()` | SKU / SL theo đợt |
| `refresh_usage_indicators()` | Tính lại cache chỉ số |
| `logistics_replace_snapshot(p_date, p_rows, p_dry_run)` | Ghi 1 snapshot logistics (chỉ service_role) |
| `backtest_goi_y(p_asofs)` | Dữ liệu kiểm chứng gợi ý |

---

## 8. Quy tắc nghiệp vụ (Business Rules)

**B1. Chuyển trạng thái** chỉ theo sơ đồ 5.1. `saveAndAdvance` kiểm tra trạng thái nguồn và trả lỗi có nghĩa.

**B2. Sửa theo bước**: AM sửa `sl_dat` ở `DRAFT` / `SUBMITTED`; PM sửa `sl_duyet` ở `SUBMITTED` / `PM_APPROVED`; Manager sửa `sl_dat_hang` ở `PM_APPROVED` / `APPROVED`. Sửa mà không chuyển bước thì chỉ ghi ô đã chỉnh.

**B3. Xoá dòng `order_items`** chỉ khi đợt `DRAFT`, cột `sl_dat`, SL = 0 và không có ghi chú.

**B4. Từ chối bắt buộc lý do**; về `DRAFT`, xoá mốc duyệt.

**B5. Hủy đợt** chỉ AM (miền mình) hoặc ADMIN, khi `DRAFT` / `SUBMITTED`.

**B6. PO**: nhiều PO / đợt, không trùng số PO trong đợt. Thêm/xóa khi `APPROVED` / `COMPLETED`. Hoàn thành cần ≥ 1 PO. Đợt `COMPLETED` không xóa được PO cuối.

**B7. BU CTTM bỏ bước PM**: đợt mà mọi nhóm SP thuộc BU `cttm` thì Manager duyệt gộp từ `SUBMITTED`.

**B8. PM tạo đợt** → `SUBMITTED` ngay; nhóm phải nằm trong scope.

**B9. Tên đợt** do server đặt theo mẫu ở F1; tên client gửi lên bị bỏ qua.

**B10. Chủ sở hữu ĐKLH** (hằng số `CSH_MIENS = {MN}`, `CSH_GROUPS = {khớp uoc, nsk arthrex}`):
- Đợt có miền + nhóm thuộc phạm vi phải chọn CSH hợp lệ.
- Với các nhóm này, Tồn kho (DA), Vét thầu (GU), Tổng tồn và Gợi ý tính theo lô của CSH đó. Mã không có lô của CSH thì tồn = 0 nhưng vẫn hiện để đặt hàng.
- Ký gửi và đi đường không có CSH, giữ nguyên.

**B11. Phạm vi**: AM theo miền + BU; PM theo scope; mọi role theo `users.nhom_san_pham` nếu có. Server chặn cả đọc và ghi; frontend hiển thị chỉ đọc khi không có action.

**B12. Công thức gợi ý** (mức sản phẩm):
```
tb_th         = SL TH / số tháng có phát sinh trong cửa sổ
                cửa sổ: "Hay sử dụng" 6 tháng, còn lại 12 tháng, kết thúc ở tháng liền trước
                nguồn:  mã CH&CS → app_order.sv; mã BU khác → app_sale.hoa_don_bovattu
tb_kh_3_thang = TB kế hoạch (sale_target) trong cửa sổ lệch leadtime; SKU thuộc bộ cộng theo bộ
tong_ton      = Σ (DA + KG + đi đường − vét thầu) các SKU của sản phẩm
safety_stock  = Σ safety_stock các SKU của sản phẩm
goi_y_sp      = max(0, (k1·tb_th + k2·tb_kh_3_thang) × so_thang_dat + safety_stock − tong_ton)
goi_y_dat     = round(goi_y_sp × ty_le_sd_pct / 100)
```
`%SD` luôn tính trên cửa sổ 12 tháng. SL TH FY24 / FY25 / FY26 YTD luôn từ `sv`. Mặc định `k1 = 0,8`, `k2 = 0,2`, số tháng đặt = 3, leadtime = 3.

**B13. Quy đổi cấu hình cũ** 3 hệ số: `k1_mới = k1_cũ + k2_cũ`, `k2_mới = k3_cũ`.

**B14. Cấu hình theo thời điểm**: đợt dùng bản `order_config_log` mới nhất có `created_at ≤ ngay_mo`.

**B15. Tồn kho theo thời điểm**: `stock` chọn cycledate mới nhất ≤ ngày mở đợt (theo miền); `logistics_input` chọn snapshot mới nhất ≤ ngày mở đợt (đợt mở trước snapshot đầu tiên dùng snapshot sớm nhất).

**B16. Chuẩn hoá**: BU lưu `bu_code`; miền lưu `MB / MT / MN` (helper vẫn chấp nhận "Miền Bắc / Miền Nam" ở dữ liệu nguồn cũ).

**B17. Audit actions**: `CREATE_SESSION, AM_CONFIRM, AM_UPDATE, PM_CONFIRM, PM_UPDATE, PM_APPROVE, PM_CONFIRM_CTTM, MANAGER_APPROVE, MANAGER_EDIT_APPROVED, REJECT, CANCEL_SESSION, PO_ADD, PO_UPDATE, PO_DELETE, PURCHASE, ADMIN_SAVE, APPROVE, CONFIG_CATALOG, SAVE_CONFIG, SAVE_USER_EMAILS, REFRESH_INDICATORS, EXPORT, LOGIN, LOGIN_FAILED, LOGOUT, CHANGE_PASSWORD`.

**B18. RLS**: bật toàn bộ, deny anon; chỉ Edge Function (service_role) đọc/ghi.

**B19. Token**: TTL 8 giờ, HMAC-SHA256 (`TOKEN_SECRET`), verify constant-time. Role được map lại và kiểm tra `ORDER_ROLES` ở mỗi request.

**B20. Rate limit đăng nhập**: theo `(username, IP)`, cửa sổ 15 phút, vượt ngưỡng trả HTTP 429.

---

## 9. Yêu cầu phi chức năng (Non-functional)

### 9.1 Hiệu năng
- Gộp dữ liệu ở tầng DB (RPC).
- RPC nặng gọi qua kết nối Postgres trực tiếp (`npm:postgres`) thay vì PostgREST, tránh `statement_timeout` 8 giây (áp dụng cho backtest).
- Đọc danh mục phân trang 1000 dòng; `saveCatalog` UPDATE theo lô 200.
- `session_stats` thay cho kéo toàn bộ `order_items`.
- SheetJS tải lười.
- Cache `usage_indicators` tính lại theo yêu cầu.

### 9.2 Bảo mật
- PBKDF2-HMAC-SHA256 210k vòng; lazy migrate từ SHA-256.
- So sánh constant-time.
- CORS chỉ cho `https://vietmedical-vmed.github.io` và `localhost` / `127.0.0.1`.
- Frontend không giữ service key.
- Kiểm tra `active` ở mỗi request.
- Câu lệnh DELETE luôn có `WHERE` (DB bật `pg-safeupdate`).

### 9.3 Bảo trì
- Tài liệu: `README.md` (kiến trúc + triển khai), `PROJECT_STRUCTURE.md` (thư mục), `OPTIMIZATION_PLAN.md`, `PRD.md` (tài liệu này).
- Migration SQL đánh số tăng dần (`01` → `27`), file rủi ro có `_ROLLBACK.sql` đi kèm.
- Frontend tách module theo màn: `js/views/order.js, manage.js, catalog.js, report.js, backtest.js, config.js, audit.js`.

### 9.4 Truy vết
- Audit log không xoá tự động.
- `order_config_log` giữ mọi phiên bản cấu hình.
- `logistics_input` giữ lịch sử theo snapshot.

### 9.5 Trải nghiệm
- Tối ưu cho màn hình ≥ 1280px; mobile vẫn dùng được.
- Toàn bộ UI và thông báo lỗi bằng tiếng Việt.
- Header bảng dính, cột trái đông cứng ở các bảng lớn.

### 9.6 Sao lưu & khôi phục
- Supabase auto backup.
- Migration rủi ro có rollback; bảng bị sửa lớn được backup trước (vd `logistics_input_bak_20261102`).

---

## 10. Kiến trúc & Triển khai (Architecture & Deployment)

### 10.1 Sơ đồ

```
Trình duyệt (GitHub Pages: index.html + js/ + dist/app.css)
        │ HTTPS
        ▼
Supabase Edge Functions
  order-login    đăng nhập, đổi mật khẩu
  order-api      gateway nghiệp vụ
  notify-sender  gửi email từ outbox (pg_cron)
        │ service_role / kết nối Postgres trực tiếp
        ▼
Supabase Postgres
  shared     dm_*, users, notifications
  app_order  đợt, items, PO, audit, stock, logistics, chỉ số, cấu hình
  app_sale   hoá đơn (nguồn TB TH BU khác)
  public     sale_target, RPC
        ▲
Script nạp dữ liệu (Python): tồn kho, sv, logistics snapshot, danh mục
```

### 10.2 Thành phần

| Lớp | Công nghệ | Vị trí |
|---|---|---|
| Frontend | HTML tĩnh + ES modules | `index.html`, `js/**` |
| CSS | Tailwind CLI build tĩnh | `src/tailwind.css` → `dist/app.css` |
| API | Supabase Edge Functions (Deno + TS) | `supabase/functions/order-api`, `order-login`, `notify-sender` |
| CSDL | Postgres | `sql/*.sql` |
| Script | Python | `scripts/*.py` + thư mục import ngoài repo |
| CI/CD | GitHub Actions | `.github/workflows/deploy-edge.yml` |

### 10.3 Secrets

- `order-api` / `order-login`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOKEN_SECRET`, `APP_URL` (deep-link email), `SUPABASE_DB_URL` (kết nối Postgres trực tiếp cho RPC nặng; Supabase tự cấp).
- `notify-sender`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `CRON_SECRET`, `ZIMBRA_URL` (tuỳ chọn).
- `config.toml`: `verify_jwt = false` (dùng token HMAC nội bộ).
- Frontend chỉ giữ `SUPABASE_URL` + `anonKey`.

### 10.4 Deploy

- **Edge Functions**: push thay đổi trong `supabase/functions/**` lên `master` → workflow `deploy-edge.yml` deploy `order-api`, `order-login`, `notify-sender` (`--yes`; `notify-sender` thêm `--no-verify-jwt`).
- **Frontend**: push `master`, GitHub Pages serve tĩnh. Đổi class Tailwind thì chạy `npm run build:css` và commit `dist/app.css`.
- **Migration DB**: chạy tuần tự `sql/*.sql` trong Supabase SQL Editor. Sau migration chỉ số, bấm "Tính lại chỉ số".
- **Nạp dữ liệu định kỳ**: tồn kho (`refresh_stock.py`), SL thực hiện (`sv`), hàng đi đường / ký gửi (`build_logistics_input.py` → RPC `logistics_replace_snapshot`).

### 10.5 Dev local
- Chạy frontend bằng static server trên `localhost` (CORS đã cho phép).
- Backend gọi thẳng Supabase cloud.

---

## 11. Chỉ số thành công (KPIs)

**Vận hành**
- Số đợt / tuần theo BU và miền.
- Thời gian `DRAFT → APPROVED` (mục tiêu ≤ 48h) và `APPROVED → COMPLETED`.
- Tỷ lệ đợt bị từ chối (mục tiêu < 10%).
- Tỷ lệ email gửi thành công (`shared.notifications.status = 'sent'`) ≥ 99%.

**Chất lượng dữ liệu & gợi ý**
- SKU có `%SD` ≥ 95%; SKU có `safety_stock` ≥ 90%.
- WAPE của công thức gợi ý trên tab Kiểm chứng giảm theo thời gian.
- Số lần Admin ghi đè (`ADMIN_SAVE`) giảm về 0.

**Trải nghiệm**
- Nạp màn Chi tiết đặt hàng < 3 giây.
- Đăng nhập thất bại do quên mật khẩu / rate limit < 5%.

**Bảo mật**
- 100% tài khoản lên `password_hash_v2`.
- 0 sự cố lộ token; 0 truy cập Postgres trực tiếp từ frontend.

---

## 12. Rủi ro, giả định & Hướng phát triển

### 12.1 Rủi ro

| Mã | Rủi ro | Giảm nhẹ |
|---|---|---|
| R1 | App khác sửa lệch danh mục dùng chung | FK / CHECK trên từ điển BU, miền, nhóm SP |
| R2 | Token cũ sau khi đổi quyền / khoá tài khoản | Kiểm tra `active` + đọc grants tươi mỗi request |
| R3 | Tồn kho sai do cycledate / snapshot lệch | Chọn bản hiệu lực theo ngày mở đợt; RPC nạp snapshot có dry-run |
| R4 | PM sửa SKU ngoài scope | Chặn đọc + ghi ở server |
| R5 | Hai người sửa cùng đợt | "Ai lưu sau thắng"; `completeSession` cập nhật có điều kiện |
| R6 | Trang lớn chậm / timeout PostgREST | RPC, phân trang, kết nối Postgres trực tiếp |
| R7 | Mail nội bộ chặn cổng / lỗi encoding | Cổng 465 hoặc Zimbra SOAP; nội dung ASCII; retry 5 lần |
| R8 | Lô tồn thiếu CSH | Không cho chọn "Không có thông tin" khi tạo đợt; kho phải điền CSH |
| R9 | `createSessionBoth` cho phép MANAGER ở bước kiểm tra đầu nhưng `createSessionRow` chặn MANAGER | Hiện Manager không tạo được đợt; cần thống nhất quyền |
| R10 | Migration sai làm mất cột (sự cố `sv.builtin_order` 2026-10-28) | Backup trước migration; script khôi phục sql/21 |

### 12.2 Giả định
- Người dùng đăng nhập bằng username/password dùng chung giữa các app.
- Tồn kho, SL thực hiện, logistics được nạp định kỳ từ Bravo / file Mua hàng.
- `dm_vat_tu` và từ điển BU / miền được quản lý tập trung.
- Trình duyệt hiện đại (Chrome / Edge / Safari mới).

### 12.3 Hướng phát triển
- **Nhiều PM trên một đợt**: chờ mọi PM (theo nhóm) duyệt xong mới chuyển `PM_APPROVED`.
- **Mở rộng CSH ĐKLH** sang miền / nhóm khác (thêm vào `CSH_MIENS`, `CSH_GROUPS`, dữ liệu `stock.csh_dklh` phải đủ).
- **Đồng bộ Bravo tự động** thay cho script nạp tay.
- **Dashboard KPI** cho khối Cung ứng.
- **Import Excel đề xuất** để AM nhập `sl_dat` hàng loạt.
- **Optimistic locking** theo `updated_at`.
- **Bỏ hash v1** khi 100% tài khoản đã lên v2.
- **Tối ưu công thức** dựa trên kết quả tab Kiểm chứng gợi ý.

---

## 13. Phụ lục

### 13.1 Thuật ngữ

| Thuật ngữ | Giải thích |
|---|---|
| **BU** | Business Unit — ngành hàng (CH&CS, CTTM & CTUT, THNS & CSVT…). Mã: `chcs`, `cttm`, `thnk` |
| **Miền** | MB (Miền Bắc) / MT (Miền Trung) / MN (Miền Nam) |
| **AM** | Area Manager — đề xuất số lượng |
| **PM** | Product Manager — duyệt số lượng theo nhóm sản phẩm |
| **Manager** | Cấp phê duyệt cuối |
| **Purchasing** | Mua hàng — nhập PO, hoàn thành đợt |
| **Mã Bravo** | Mã SKU trên ERP Bravo |
| **Nhóm sản phẩm** | Cấp phân loại dùng cho scope PM và đợt |
| **Sản phẩm** | Cấp phân loại dưới nhóm, dùng để tính gợi ý |
| **DA / GU / KG** | Kho: DA = tồn thường, GU = vét thầu, KG = ký gửi |
| **Tổng tồn** | `DA + ký gửi + đi đường − vét thầu` |
| **TB tháng TH** | Trung bình tháng thực hiện (6 tháng với mã "Hay sử dụng", 12 tháng với mã khác) |
| **TB tháng KH** | Trung bình kế hoạch trong cửa sổ lệch leadtime (từ `sale_target`) |
| **%SD** | Tỷ lệ SL của SKU trong sản phẩm (12 tháng) |
| **Safety stock** | Tồn an toàn cấu hình theo SKU |
| **Số tháng đặt / Leadtime** | Số tháng nhu cầu cần đặt / số tháng hàng về |
| **Chủ sở hữu ĐKLH (CSH)** | Chủ sở hữu đăng ký lưu hành (xuất xứ) của lô hàng |
| **DM** | Đề nghị mua hàng trên Bravo |
| **PO** | Purchase Order trên Bravo |
| **Snapshot logistics** | Bộ số đi đường / ký gửi chốt tại 1 ngày |
| **WAPE** | Sai số tuyệt đối có trọng số, chỉ số đánh giá dự báo ở tab Kiểm chứng |

### 13.2 Ánh xạ UI ↔ Cột DB

**Đợt đặt hàng** (`app_order.order_sessions`)

| UI | Cột |
|---|---|
| Đợt | `ten_dot` |
| Thời gian | `ngay_mo` |
| Tạo bởi | `tao_boi` (hiển thị họ tên từ `shared.users`) |
| BU | `bu` |
| Nhóm SP | `nhom_san_pham` |
| Miền | `mien` |
| Chủ sở hữu | `csh_dklh` |
| Trạng thái | `trang_thai` |
| TT đặt hàng | `de_nghi_mua_hang` + `po` |
| Ngày yêu cầu / PM duyệt / Manager duyệt | `ngay_yeu_cau` / `ngay_pm_duyet` / `ngay_manager_duyet` |
| Đặt hàng (ngày) | `min(order_session_po.tao_luc)` |
| Người / ngày hoàn thành | `nguoi_mua_hang` / `ngay_mua_hang` |
| Lý do / người / bước từ chối | `ly_do_tu_choi` / `nguoi_tu_choi` / `tu_choi_o_buoc` |

**PO** (`app_order.order_session_po`): Số PO `po` · DM `de_nghi_mua_hang` · Ghi chú `ghi_chu` · Người nhập `tao_boi` · Lúc nhập `tao_luc`.

**Dòng đặt hàng** (`app_order.order_items`)

| UI | Cột |
|---|---|
| SL yêu cầu / Ghi chú AM | `sl_dat` / `ghi_chu_dat` |
| SL PM duyệt / Ghi chú PM | `sl_duyet` / `ghi_chu_duyet` |
| SL đặt hàng / Ghi chú đặt hàng | `sl_dat_hang` / `ghi_chu_dat_hang` |
| Người / lúc cập nhật | `updated_by` / `updated_at` |

**Danh mục** (`shared.dm_vat_tu`): Mã Bravo `ma_bravo` · Mã NCC `ma_ncc` · Tên hàng `ten_vat_tu` · Nhóm SP `nhom_san_pham` · Sản phẩm `san_pham` · Giá thầu `don_gia_thau_moi` · BU `bu_code` · Mức độ SD `muc_do_sd` · Safety stock `safety_stock` · Cho đặt hàng `dat_hang`.

**Tồn kho & chỉ số**

| UI | Nguồn |
|---|---|
| Tồn kho (DA) / Vét thầu (GU) | `stock_agg` (theo CSH: `stock_csh_agg`) |
| Hàng KTV/BV (ký gửi) / Hàng đi đường | `stock_agg` từ `logistics_input` |
| Tổng tồn | `stock_agg.tong_ton` |
| TB tháng TH, TB tháng KH, SL TH FY, %SD | `app_order.usage_indicators` |

**Cấu hình gợi ý** (`app_order.app_config.value`): `k1`, `k2`, `so_thang_dat_default`, `leadtime_thang_default`, `groups.<nhóm>.{k1, k2, so_thang_dat, leadtime_thang}`.

**Nhật ký** (`app_order.audit_log`): `timestamp`, `username`, `action`, `session_id`, `detail`.

---

*Mọi thay đổi nghiệp vụ cần cập nhật PRD này để đồng bộ với code (`sql/*.sql`, `supabase/functions/**`, `js/**`).*
