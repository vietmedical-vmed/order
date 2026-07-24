# Kế hoạch tối ưu web app "Đặt hàng CH&CS"

> Phạm vi khảo sát: `index.html` (~2.900 dòng, SPA thuần + Tailwind CDN),
> `supabase/functions/order-api` (~1.240 dòng), `supabase/functions/order-login` (~170 dòng).
>
> Ký hiệu ưu tiên: 🔴 làm ngay (bug/ảnh hưởng lớn) · 🟠 nên làm sớm · 🟡 làm khi có thời gian.

## Trạng thái thực hiện

**✅ Đã làm (Đợt 1 + một phần Đợt 5):** 0.1, 0.2, 0.3, 1.2, 3.1, 1.6, 5.3, 5.4.
CORS thu hẹp về `https://vietmedical-vmed.github.io` (+ localhost khi dev) — xác nhận qua
AskUserQuestion vì repo không có file CNAME xác định domain. 5.1/5.2 (hash mật khẩu, rate-limit)
**chưa làm** vì ảnh hưởng bảng `users` dùng chung nhiều app khác, cần phối hợp trước.

**⏳ Chưa làm:** Đợt 2, 3, 4 và phần còn lại của Đợt 5 (5.1, 5.2) — xem chi tiết bên dưới.

---

## 0. Sửa bug phát hiện trong lúc khảo sát (làm trước tiên)

### 0.1 🔴 Logout gọi sai endpoint
- **Vị trí:** `index.html:961` — `fetchWithTimeout(API_BASE + '/api', ...)`.
- **Vấn đề:** function thật tên `order-api`, nên request logout luôn 404 → audit log không bao giờ ghi được LOGOUT.
- **Bước làm:** đổi `'/api'` → `'/order-api'`.

### 0.2 🔴 CSS sai cú pháp
- **Vị trí:** `index.html:70` — `.group-stat-label { ... uppercase; ... }`.
- **Vấn đề:** `uppercase;` đứng một mình không phải property hợp lệ (đã có `text-transform: uppercase` phía sau nên không lỗi hiển thị, nhưng là rác).
- **Bước làm:** xoá token `uppercase;` thừa.

### 0.3 🟠 Xoá code chết (dead code)
- **Vị trí:** `index.html:2554–2697` — cụm `filteredApprovalRows / renderApprovalBody / approvalRowHtml / bindApprovalInputs / updateApprovalStats / bulkApprove / saveApproval / closeSessionAction` tham chiếu các element `#aGrp`, `#approvalTableHost`, `#aSaveApproval`… **không tồn tại** trong bất kỳ template nào (màn duyệt kiểu cũ đã bỏ).
- **Vị trí:** `index.html:995–1009` — `bindMienToggle()` được định nghĩa nhưng không nơi nào gọi (initOrderView tự bind riêng).
- **Bước làm:** xoá toàn bộ (~160 dòng), chạy lại app xác nhận không vỡ gì.

### 0.4 🟡 Dọn console.log / thông báo debug
- Các chỗ `console.log('[loadOrderData] received:', data)`, `[renderAudit]`, thông báo lỗi còn nhắc "Apps Script Executions panel" (di sản từ Google Apps Script) — gây nhiễu và lộ dữ liệu trên console.
- **Bước làm:** xoá hoặc gói vào cờ `window.CTCH_CONFIG.debug`; sửa các message lỗi nhắc Apps Script thành nội dung đúng (Supabase Edge Function logs).

### 0.5 🟡 Dọn repo
- Thư mục `abc/` (rỗng?), `scereen/` (typo của "screen") — đổi tên/xoá.
- `README.md` + `PROJECT_STRUCTURE.md` còn ghi `web/index.html`, function tên `login`/`api` — cập nhật đúng thực tế (`index.html` ở root, `order-login`/`order-api`).

---

## 1. Hiệu năng — Frontend

### 1.1 🔴 Bỏ Tailwind Play CDN, build CSS tĩnh
- **Hiện trạng:** `<script src="https://cdn.tailwindcss.com">` — bản Play CDN (~350KB JS) biên dịch CSS **lúc runtime mỗi lần tải trang**; chính Tailwind cảnh báo không dùng cho production. Đây là thứ chậm nhất khi mở app.
- **Bước làm:**
  1. Cài Tailwind CLI (`npm i -D tailwindcss`), tạo `tailwind.config.js` với đúng bảng màu custom đang khai báo inline (slate/emerald/blue/sky/red).
  2. Tách phần `<style>` hiện tại ra `styles.css`, thêm `@tailwind base/components/utilities` (hoặc dùng `@apply` dần dần).
  3. Build ra `dist/app.css` (minify, purge theo `index.html`) — kết quả thường chỉ ~15–30KB.
  4. Thay thẻ script CDN bằng `<link rel="stylesheet" href="app.css">`.
  5. Thêm bước build vào workflow deploy GitHub Pages.
- **Lợi ích:** giảm ~300KB JS + bỏ hẳn công đoạn JIT runtime → First Paint nhanh hơn rõ rệt, hết nháy màn hình lúc boot.

### 1.2 🔴 Debounce ô tìm kiếm màn đặt hàng
- **Hiện trạng:** `index.html:1065` — `fSearch` gọi `renderOrderBody()` **mỗi phím gõ**, mỗi lần render dựng lại toàn bộ HTML bảng (hàng nghìn dòng × ~24 cột) rồi bind lại toàn bộ listener + đo lại cột. Màn Cấu hình danh mục đã có `debounce(…, 200)` nhưng màn đặt hàng thì chưa.
- **Bước làm:** bọc handler bằng `debounce(…, 250)` (hàm `debounce` đã có sẵn ở dòng 2716).

### 1.3 🟠 Event delegation thay cho bind từng input
- **Hiện trạng:** `bindOrderInputs()` gắn listener cho **từng** input (hàng nghìn listener); trong handler lại `state.rows.find(...)` O(n) mỗi phím gõ.
- **Bước làm:**
  1. Gắn **1 listener** `input` trên `#orderTableHost`, đọc `e.target.dataset.id/field`.
  2. Xây `Map` index `ma_bravo → row` một lần sau khi load (`state.rowIndex`), thay mọi chỗ `state.rows.find(...)`.
  3. Áp dụng tương tự cho `bindCatalogInputs`, nút trong `renderManageList`.

### 1.4 🟠 Giới hạn/ảo hoá số dòng render màn đặt hàng
- **Hiện trạng:** màn Cấu hình danh mục có `CAT_RENDER_CAP = 600` nhưng màn đặt hàng render **toàn bộ** SKU. Với danh mục >2.300 vật tư, chuỗi HTML rất lớn, thao tác lọc/mở nhóm bị khựng.
- **Bước làm (chọn 1, theo thứ tự ưu tiên):
  1. **Render lười theo nhóm:** chỉ render tbody của group-card đang mở (mặc định chỉ nhóm đầu mở — đúng hành vi hiện tại); nhóm đóng chỉ render header, khi bấm mở mới dựng tbody. Cách này khớp UI sẵn có, ít rủi ro nhất.
  2. Hoặc virtual scrolling (clusterize.js / tự viết windowing) nếu (1) chưa đủ.
- **Lưu ý:** khi render lười phải đảm bảo `placeOrder()` không phụ thuộc DOM — xem mục 3.4 (hiện `placeOrder` gom items **từ input trên DOM**, nhóm chưa render sẽ bị bỏ sót → phải chuyển sang gom từ `state`).

### 1.5 🟠 Thay cơ chế floating thead + đo cột bằng giải pháp CSS
- **Hiện trạng:** `lockColumnWidths()` ép `tableLayout=auto` → đo từng ô (`getBoundingClientRect`) → dựng `<colgroup>` → `fixed` (layout thrash); `buildFloatingHeaders()` clone thead + lắng nghe `window.scroll` gọi `getBoundingClientRect` cho **mọi** card mỗi tick cuộn.
- **Bước làm:**
  1. Thử bỏ clone thead: dùng `position: sticky; top: <header-height>` trực tiếp trên `thead th` (bảng đã `border-collapse: separate` nên sticky hoạt động) — sticky dọc trong khung cuộn dọc của trang cần container cuộn phù hợp; nếu giữ cuộn theo `window` thì cân nhắc chuyển `.group-body` thành khung cuộn dọc riêng (max-height) để sticky thead + sticky 4 cột trái đều thuần CSS, xoá được ~150 dòng JS đo đạc.
  2. Nếu vẫn giữ floating clone: chuyển phát hiện "card đang cắt viewport" sang `IntersectionObserver`, và cache `bodyRect` (chỉ tính lại khi resize), trong scroll handler chỉ đổi `display`/`transform`.
- **Lợi ích:** cuộn mượt hơn hẳn trên bảng dài; bớt code khó bảo trì.

### 1.6 🟡 Tối ưu tải trang lần đầu
- Preconnect: thêm `<link rel="preconnect" href="https://nrfxymnfmjhbsgpipvkb.supabase.co">` để tiết kiệm 1 vòng DNS+TLS trước call đầu tiên.
- Thêm favicon (hiện 404 mỗi lần tải) + `<meta name="description">`.
- SheetJS đã lazy-load tốt — giữ nguyên; có thể chuyển sang bản `xlsx.mini.min.js` nhẹ hơn nếu chỉ cần aoa_to_sheet/writeFile.

### 1.7 🟡 Giảm gọi API trùng
- Sau `placeOrder()` gọi `loadSessions()` **rồi** `loadOrderData()` (loadOrderScreen bên trong lại đọc session) — 2 round-trip nối tiếp. Tương tự sau tạo đợt.
- **Bước làm:** cho `loadOrderScreen` trả kèm danh sách sessions (hoặc chấp nhận 1 round-trip: chạy 2 call song song bằng `Promise.all` vì không phụ thuộc nhau).

---

## 2. Hiệu năng — Backend (Edge Functions / DB)

### 2.1 🔴 `listSessions` quét toàn bộ `order_items`
- **Vị trí:** `order-api/index.ts:699` — `supa.from("order_items").select("session_id, sl_dat, sl_duyet, sl_dat_hang")` **không filter, không phân trang**.
- **Vấn đề kép:**
  1. PostgREST cắt 1000 dòng → khi tổng items vượt 1000, **thống kê SKU/SL trên màn Quản lý sẽ sai** (chính là lỗi đã từng gặp và fix ở RPC aggregate — commit `4bc0008`).
  2. Càng nhiều đợt càng chậm, mà `listSessions` được gọi rất thường xuyên (boot, đổi miền, sau mỗi lần lưu...).
- **Bước làm:**
  1. Tạo RPC SQL `session_stats()`: `SELECT session_id, count(*) sku, sum(sl_dat)..., count(sl_duyet) approved_sku... FROM order_items GROUP BY session_id` (thêm vào `sql/03_rpc_aggregates.sql`).
  2. `listSessions` gọi RPC này (qua `rpcAll` sẵn có) thay cho scan bảng; hoặc tối thiểu `.in("session_id", ids)` theo danh sách đợt đã lọc + phân trang.

### 2.2 🟠 `fetchProducts` dùng `select("*")`
- **Vị trí:** `order-api/index.ts:270`.
- **Bước làm:** liệt kê đúng ~14 cột đang dùng (như `listCatalog` đã làm) → giảm payload từ DB về function, nhanh hơn với >2.300 dòng.

### 2.3 🟠 Ghim version thư viện trong Edge Function
- **Vị trí:** cả 2 function `import ... from "https://esm.sh/@supabase/supabase-js@2"`.
- **Vấn đề:** `@2` là range trôi nổi — bản mới của supabase-js có thể đổi hành vi âm thầm; esm.sh resolve range cũng chậm hơn khi cold start.
- **Bước làm:** ghim cụ thể, vd `@supabase/supabase-js@2.45.4` (hoặc dùng `npm:` specifier của Deno), cả 2 function dùng cùng version.

### 2.4 🟡 Gộp/cache dữ liệu ít đổi
- `loadSpBoMap`, `listOrderGroups` đọc lại toàn bộ mapping mỗi request trong khi dữ liệu danh mục đổi rất hiếm.
- **Bước làm:** cache trong biến module-level của Edge Function với TTL ~60s (function instance sống qua nhiều request) — không đổi hành vi, giảm 2–3 query mỗi lần mở màn đặt hàng.

### 2.5 🟡 `getConfig` chạy tuần tự
- `getKConfig` rồi `listOrderGroups` — 2 await nối tiếp → chuyển `Promise.all`.

---

## 3. Trải nghiệm người dùng (UX)

### 3.1 🔴 Chặn mất dữ liệu khi đóng tab
- **Hiện trạng:** có confirm khi đổi miền/đăng xuất, nhưng **đóng tab/refresh khi đang có thay đổi chưa lưu thì mất trắng**, không cảnh báo.
- **Bước làm:** thêm `window.addEventListener('beforeunload', e => { if (state.changes.size || state.catalogDirty?.size) { e.preventDefault(); e.returnValue = ''; } })`.

### 3.2 🟠 Tự lưu nháp (draft) vào localStorage
- **Bước làm:** mỗi khi `state.changes` đổi (debounce 1s), ghi `{sessionId, changes}` vào localStorage; khi mở lại đúng đợt đó, hỏi "Khôi phục N thay đổi chưa gửi?" → giảm hẳn thiệt hại khi token hết hạn/mất mạng giữa chừng.

### 3.3 🟠 Cảnh báo token sắp hết hạn (8h)
- **Hiện trạng:** token 8h, hết hạn giữa chừng → call fail → đá về login, mất thay đổi đang nhập.
- **Bước làm:** payload token có `exp` — frontend decode được. Đặt timer: trước hạn 15 phút hiện banner "Phiên sắp hết hạn — lưu lại và đăng nhập lại". (Xa hơn: endpoint `refreshToken` trong `order-login`.)

### 3.4 🟠 `placeOrder` gom dữ liệu từ DOM → chuyển sang gom từ state
- **Hiện trạng:** `index.html:2004–2016` đọc mọi `input.qty-input` trên DOM. Hệ quả: (a) chặn đường tối ưu render lười (1.4); (b) nhóm/phân loại đang **collapse vẫn có input trong DOM** thì OK hiện tại, nhưng bất kỳ thay đổi render nào cũng dễ gây sót dòng âm thầm.
- **Bước làm:** tính items từ `state.rows` + `state.changes` + `qtyEffective()` (logic đã có sẵn) — DOM chỉ để hiển thị.

### 3.5 🟠 Thay `prompt()/confirm()/alert()` bằng modal thống nhất
- Từ chối đợt dùng `prompt()` (không style, không validate tốt, mobile xấu); duyệt/chốt dùng `confirm()`; audit ping dùng `alert()`.
- **Bước làm:** làm 1 modal generic (confirm + textarea lý do) tái sử dụng — repo đã có sẵn 2 modal mẫu (`modalCreateSession`, `modalPurchase`) để nhân bản.

### 3.6 🟠 Bàn phím & nhập liệu nhanh trên bảng
- Enter/↓ ở ô số lượng → nhảy xuống ô cùng cột dòng dưới (như Excel); Esc → bỏ focus.
- Focus vào ô số → tự select toàn bộ (`onfocus="this.select()"`), gõ đè ngay không phải xoá.
- Chặn scroll-wheel đổi giá trị `input[type=number]` ngoài ý muốn: `addEventListener('wheel', e => document.activeElement === e.target && e.target.blur(), {passive:true})`.

### 3.7 🟡 Sắp xếp cột + đếm kết quả lọc
- Click header để sort theo cột (tồn, gợi ý, SL đặt...) trong từng phân loại.
- Hiện "Đang hiện X/Y SKU" cạnh ô tìm kiếm khi có filter.

### 3.8 🟡 Loading skeleton thay chữ "Đang tải…"
- Skeleton bảng (vài dòng xám nhấp nháy) cho `orderTableHost`, `manageHost` — cảm giác nhanh hơn.

### 3.9 🟡 Toast xếp chồng + phân loại
- Toast hiện tại 1 instance, message sau đè message trước (3.2s). Chuyển sang stack tối đa 3, màu theo loại (success/error/info), có nút đóng.

### 3.10 🟡 Nút "Thử lại" khi lỗi tải
- Các khối lỗi (`Lỗi tải dữ liệu: ...`) chỉ hiện text — thêm nút Thử lại gọi lại đúng loader.

---

## 4. Giao diện (UI)

### 4.1 🟠 Dọn hệ màu — bỏ hack remap Tailwind
- **Hiện trạng:** config remap `emerald`, `blue`, `sky` **cùng về 1 dải xanh Facebook** — class tên `emerald` nhưng render xanh dương, gây khó bảo trì (login button `bg-emerald-600` thực chất là xanh dương).
- **Bước làm (kết hợp với 1.1):** định nghĩa palette ngữ nghĩa: `primary` (xanh dương chính), `danger`, `warning`, `surface`… rồi tìm-thay các class emerald/sky/blue về đúng tên. Kết quả: 1 nguồn màu duy nhất, đổi brand sau này chỉ sửa 1 chỗ.

### 4.2 🟠 Responsive cho mobile/tablet
- Bảng 24 cột trên mobile gần như không dùng được; thanh filter tràn dòng.
- **Bước làm:**
  1. Header: co cụm user + nút thành icon-only dưới `md:`.
  2. Thanh filter: cho phép cuộn ngang (`overflow-x-auto`) hoặc collapse thành nút "Bộ lọc" mở panel.
  3. Bảng: mobile ưu tiên giữ 4 cột đông cứng + cột nhập của bước hiện tại; các cột phụ ẩn dưới breakpoint (`hidden lg:table-cell`) hoặc gom vào hàng chi tiết mở rộng.
  4. Stat cards: hiện tại đã grid responsive — kiểm tra lại 7 thẻ trên màn nhỏ (2 cột là ổn).

### 4.3 🟡 Khả năng truy cập (a11y)
- Nút icon (đăng xuất, đóng modal ×) thêm `aria-label`.
- Modal: đóng bằng phím Esc, focus trap, trả focus về nút mở.
- Dropdown lọc (PL, mức độ): điều hướng bằng phím ↑↓ + Enter, `role="menu"`.
- Kiểm tra contrast các chữ `text-[10.5px] text-slate-400/500` trên nền trắng (nhiều chỗ dưới chuẩn WCAG AA với cỡ chữ nhỏ).

### 4.4 🟡 Chi tiết hoàn thiện
- Trạng thái đợt: pill + progress steps đã tốt — thêm tooltip giải thích từng bước cho user mới.
- Ô nhập bị disable ngoài scope PM đã có `title` — đổi thành icon khoá nhỏ dễ thấy hơn.
- Empty state thêm hình minh hoạ SVG nhẹ (inline) thay vì chỉ text.

---

## 5. Bảo mật (ghi nhận — cần cân nhắc vì bảng `users` dùng chung)

### 5.1 🟠 Băm mật khẩu yếu (SHA-256, có thể không salt)
- SHA-256 đơn (không salt với user cũ) dò được rất nhanh nếu lộ DB. Vì `users` dùng chung nhiều app nên **không đổi đơn phương được**.
- **Bước làm:** lên kế hoạch chung toàn công ty: thêm cột `password_hash_v2` (bcrypt/argon2), verify ưu tiên v2, tự nâng cấp hash khi user đăng nhập thành công (lazy migration); các app khác cập nhật cùng scheme.

### 5.2 🟠 Chống dò mật khẩu chỉ bằng sleep 400ms
- **Bước làm:** thêm rate-limit theo `username + IP` (bảng đếm trong DB hoặc KV) — khoá 15 phút sau 5 lần sai; ghi audit LOGIN_FAILED.

### 5.3 🟡 So sánh HMAC không constant-time
- `expect !== sig` trong `verifyToken` — về lý thuyết lộ timing. Dùng `crypto.subtle.verify` hoặc so sánh constant-time.

### 5.4 🟡 CORS `*`
- Thu hẹp `Access-Control-Allow-Origin` về đúng domain GitHub Pages (+ localhost khi dev).

---

## 6. Kiến trúc & bảo trì (nền tảng cho các mục trên)

### 6.1 🟠 Tách `index.html` monolith
- 2.900 dòng 1 file: CSS + config + 5 màn + utils trộn lẫn — mọi sửa đổi đều rủi ro đụng nhau.
- **Bước làm (không cần framework):**
  1. Giai đoạn 1 — tách file tĩnh: `styles.css`, `js/api.js` (rpc/fetch/token), `js/utils.js`, `js/views/order.js`, `js/views/manage.js`, `js/views/catalog.js`, `js/views/config.js`, `js/views/audit.js` — dùng ES modules (`<script type="module">`), GitHub Pages phục vụ bình thường, không cần bundler.
  2. Giai đoạn 2 (tuỳ chọn) — thêm Vite: bundle + minify + hash tên file (cache busting) + build Tailwind (mục 1.1) trong cùng pipeline.
- Tách `window.CTCH_CONFIG` ra `config.js` riêng để đổi môi trường không đụng code.

### 6.2 🟡 Thêm kiểm tra tự động tối thiểu
- ESLint + Prettier (hoặc Biome) cho JS/TS; `deno check` cho 2 Edge Functions trong CI.
- Smoke test Playwright: login → mở màn đặt hàng → lọc → nhập 1 ô → thấy nút Đặt hàng (chạy trên CI với account test).

### 6.3 🟡 Đồng bộ tài liệu
- Cập nhật README/PROJECT_STRUCTURE theo cấu trúc thật (mục 0.5); ghi chú quy trình build mới sau khi làm 1.1/6.1.

---

## Lộ trình đề xuất

| Đợt | Nội dung | Mục |
|---|---|---|
| **Đợt 1 — sửa nhanh** (vài giờ) | Fix endpoint logout, CSS typo, xoá dead code, debounce search, beforeunload, preconnect/favicon | 0.1, 0.2, 0.3, 1.2, 3.1, 1.6 |
| **Đợt 2 — hiệu năng lõi** (1–2 ngày) | Bỏ Tailwind CDN + build CSS, RPC `session_stats`, select cột cụ thể, pin version, event delegation | 1.1, 2.1, 2.2, 2.3, 1.3 |
| **Đợt 3 — UX** (2–3 ngày) | placeOrder từ state, render lười theo nhóm, autosave draft, cảnh báo hết hạn token, modal thay prompt/confirm, phím tắt bảng | 3.4, 1.4, 3.2, 3.3, 3.5, 3.6 |
| **Đợt 4 — UI & nền tảng** (dần dần) | Dọn palette, responsive mobile, sticky thead thuần CSS, tách module, a11y, toast stack, sort cột | 4.1, 4.2, 1.5, 6.1, 4.3, 3.9, 3.7 |
| **Đợt 5 — bảo mật** (phối hợp các app dùng chung `users`) | Nâng scheme hash mật khẩu, rate-limit login, CORS | 5.1, 5.2, 5.4 |

**Nguyên tắc khi thực hiện:** mỗi đợt là 1 nhánh/PR riêng; đo trước–sau (Lighthouse cho 1.1; thời gian render bảng qua `performance.now()` cho 1.3/1.4; thời gian phản hồi `listSessions` cho 2.1) để xác nhận cải thiện thật.
