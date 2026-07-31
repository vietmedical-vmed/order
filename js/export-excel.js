// Xuất Excel — SheetJS nạp lười 1 lần khi cần (không ảnh hưởng tốc độ mở app).
import { $, num0 } from './utils.js';
import { rpc } from './api.js';
import { state } from './state.js';
import { toast } from './toast.js';

let _xlsxLoading = null;
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxLoading) return _xlsxLoading;
  _xlsxLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Không tải được thư viện xuất Excel (kiểm tra mạng)'));
    document.head.appendChild(s);
  });
  return _xlsxLoading;
}

// session tuỳ chọn — nếu không truyền thì dùng đợt đang xem. Backend chỉ cho Manager/Admin
// xuất khi đợt đã APPROVED/CLOSED, nên đây chỉ là lớp UX phía trước.
export async function exportToExcel(session) {
  const sess = session || state.currentSession;
  if (!sess || !sess.session_id) { toast('Chưa chọn đợt để xuất', 'error'); return; }
  const btn = $('#btnExport');
  if (btn) btn.disabled = true;
  try {
    const [data, XLSX] = await Promise.all([
      rpc('exportOrderData', sess.session_id),
      loadSheetJS(),
    ]);
    const rows = data.rows || [];
    if (!rows.length) { toast('Đợt này chưa có SKU nào', 'error'); return; }
    const header = ['STT','Mã Bravo','Mã NCC','Tên hàng','Nhóm hàng','Phân loại','Mức độ SD','Đơn vị','Đơn giá',
      'Tồn kho (DA)','Hàng ký gửi','Vét thầu (GU)','Hàng đi đường','Tổng tồn',
      '% SD','TB tháng TH','TB KH','Safety stock','MoI (tháng)','Số tháng đặt','Leadtime (tháng)','Gợi ý',
      'SL yêu cầu','SL PM duyệt','SL đặt hàng','DM','PO','Thành tiền','Ghi chú đặt','Ghi chú duyệt'];
    const pctInt = v => Math.round(Number(v) || 0);   // %SD: số nguyên
    // MoI = Tồn kho (DA) / TB tháng TH, làm tròn xuống. Không có mức dùng -> để TRỐNG
    // (số, không kèm chữ "tháng") để còn lọc/tính được trong Excel.
    const moi = r => {
      const th = Number(r.tb_th || 0);
      return th > 0 ? Math.floor(Number(r.ton_kho || 0) / th) : '';
    };
    const aoa = [header];
    rows.forEach((r, i) => {
      aoa.push([
        i + 1, r.ma_bravo, r.code_ncc, r.ten_hang, r.nhom_hang, r.phan_loai, r.muc_do_sd || '', r.don_vi, num0(r.gia),
        num0(r.ton_kho), num0(r.hang_ktv_bv), num0(r.hang_vet_thau), num0(r.hang_di_duong), num0(r.tong_ton),
        pctInt(r.ty_le_sd_pct), num0(r.tb_th), num0(r.tb_kh_3_thang), num0(r.safety_stock), moi(r),
        num0(r.so_thang_dat), num0(r.leadtime_thang), num0(r.goi_y_dat),
        num0(r.sl_yeu_cau), num0(r.sl_pm_duyet), num0(r.sl_dat_hang), r.de_nghi_mua_hang || '', r.po || '',
        num0(r.thanh_tien), r.ghi_chu_dat, r.ghi_chu_duyet,
      ]);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [
      { wch: 5 }, { wch: 14 }, { wch: 14 }, { wch: 34 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 8 }, { wch: 12 },
      { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
      { wch: 8 }, { wch: 13 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 9 },
      { wch: 11 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 24 }, { wch: 24 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Đặt hàng');
    const se = data.session || sess;
    const fname = `dat-hang_${String(se.ten_dot || 'dot').replace(/\s+/g,'-')}_${se.mien || ''}_${new Date().toISOString().slice(0,10)}.xlsx`;
    XLSX.writeFile(wb, fname);
    toast(`Đã xuất ${rows.length} dòng ra Excel (.xlsx)`);
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
