#!/usr/bin/env python3
"""
refresh_stock.py — Nạp tồn kho RAW ("Chi tiết") + usage ("SDVT") vào Supabase
(bảng stock, usage_stat).

QUAN TRỌNG: bảng `stock` là RAW ở mức LÔ (không aggregate). Mỗi dòng "Chi tiết"
được nạp thẳng thành 1 dòng stock; việc gộp DA/GU/KG và chốt cycledate hiệu lực
do RPC stock_agg (sql/03_rpc_aggregates.sql) làm lúc đọc. Vì vậy KHÔNG cộng dồn
tại đây nữa (bản cũ aggregate về (ma_bravo, mien) là sai với schema hiện tại).

Chạy định kỳ (vd hằng ngày / trước mỗi đợt đặt hàng):
  pip install pandas openpyxl supabase
  python refresh_stock.py --stock ./chi_tiet.xlsx --cycledate 2026-07-22 --usage ./sdvt.xlsx

--cycledate: ngày chốt snapshot; nếu tab "Chi tiết" có sẵn cột ngày thì để trống
để lấy theo cột đó, ngược lại truyền tay (mặc định = hôm nay).
Miền suy từ cột "Miền", nếu trống thì từ prefix WarehouseCode (HN/DN→MB, SG→MN).
"""
import os, argparse, math
from datetime import date
import pandas as pd
from supabase import create_client

REGION_PREFIX = {"HN": "MB", "SG": "MN", "DN": "MB"}
MIEN_ALIAS = {
    "MIỀN BẮC": "MB", "MIEN BAC": "MB", "BẮC": "MB", "MB": "MB",
    "MIỀN NAM": "MN", "MIEN NAM": "MN", "NAM": "MN", "MN": "MN",
}

def col(df, *names):
    for n in names:
        if n in df.columns:
            return n
    return None

def num(v):
    try:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return 0
        return float(v)
    except Exception:
        return 0

def to_iso_date(v):
    """Giá trị ngày bất kỳ -> 'YYYY-MM-DD' (hoặc None)."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    try:
        d = pd.to_datetime(v, errors="coerce")
        return None if pd.isna(d) else d.date().isoformat()
    except Exception:
        return None

def txt(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    s = str(v).strip()
    return s or None

def load_stock_raw(path, tab="Chi tiết", cycledate=None):
    """Nạp RAW lot-level: mỗi dòng "Chi tiết" -> 1 dòng stock (không aggregate)."""
    df = pd.read_excel(path, sheet_name=tab, dtype=object)
    df.columns = [str(c).strip() for c in df.columns]
    c_item = col(df, "Itemcode", "Ma_Bravo", "Mã Bravo")
    c_type = col(df, "WarehouseType")
    c_code = col(df, "WarehouseCode")
    c_mien = col(df, "Miền", "Mien")
    c_qty  = col(df, "Chenh_Lech", "So_Luong", "Quantity", "SL")
    # Cột phụ (tuỳ export). TODO: chỉnh tên cho khớp file "Chi tiết" thật nếu khác.
    c_item_ncc = col(df, "Itemcode_NCC", "ItemcodeNCC", "Mã NCC", "Ma_NCC")
    c_whname   = col(df, "WarehouseName", "Kho")
    c_serial   = col(df, "SerialCode", "Serial")
    c_solo     = col(df, "So_Lo", "SoLo", "Lot", "Batch")
    c_exp      = col(df, "ExpiryDate", "HSD", "Han_Su_Dung")
    c_mfg      = col(df, "MfgDate", "NSX", "Ngay_San_Xuat")
    c_note     = col(df, "Note", "Ghi_Chu", "Ghi chú")
    c_cycle    = col(df, "CycleDate", "Cycledate", "Ngay_Chot", "Ngày")
    if not c_item or not c_type:
        raise SystemExit("Thiếu cột Itemcode hoặc WarehouseType trong tab tồn kho")

    default_cd = cycledate or date.today().isoformat()
    rows = []
    for _, r in df.iterrows():
        ma = str(r.get(c_item) or "").strip()
        if not ma:
            continue
        mien = ""
        if c_mien:
            mien = MIEN_ALIAS.get(str(r.get(c_mien) or "").strip().upper(), "")
        if not mien and c_code:
            prefix = str(r.get(c_code) or "").split(".")[0].upper()
            mien = REGION_PREFIX.get(prefix, "")
        if mien not in ("MB", "MN"):
            continue
        # cycledate: ưu tiên cột trong file, nếu không có thì dùng --cycledate/hôm nay
        cd = (to_iso_date(r.get(c_cycle)) if c_cycle else None) or default_cd
        rows.append({
            "ma_bravo":      ma,
            "mien":          mien,
            "cycledate":     cd,
            "itemcode_ncc":  txt(r.get(c_item_ncc)) if c_item_ncc else None,
            "warehousetype": txt(r.get(c_type)),
            "warehousecode": txt(r.get(c_code)) if c_code else None,
            "warehousename": txt(r.get(c_whname)) if c_whname else None,
            "serialcode":    txt(r.get(c_serial)) if c_serial else None,
            "so_lo":         txt(r.get(c_solo)) if c_solo else None,
            "quantity":      num(r.get(c_qty)) if c_qty else 0,
            "expirydate":    to_iso_date(r.get(c_exp)) if c_exp else None,
            "mfgdate":       to_iso_date(r.get(c_mfg)) if c_mfg else None,
            "note":          txt(r.get(c_note)) if c_note else None,
        })
    return rows

def aggregate_usage(path, tab="SDVT"):
    """
    Aggregate usage theo năm. Cần các cột: ma_bravo, mien, ngay_su_dung, so_luong.
    Nếu cấu trúc SDVT khác, chỉnh mapping cột bên dưới cho khớp file thật.
    """
    df = pd.read_excel(path, sheet_name=tab, dtype=object)
    df.columns = [str(c).strip() for c in df.columns]
    c_ma = col(df, "ma_bravo", "Itemcode", "Mã Bravo")
    c_mien = col(df, "mien", "Miền", "Mien")
    c_date = col(df, "ngay_su_dung", "Ngày", "date")
    c_qty = col(df, "so_luong", "So_Luong", "SL")
    if not all([c_ma, c_date]):
        print("  ⚠ SDVT thiếu cột ma_bravo/ngay_su_dung — bỏ qua usage. Chỉnh mapping trong script nếu cần.")
        return []

    agg = {}
    total_lk = {"MB": 0, "MN": 0}
    for _, r in df.iterrows():
        ma = str(r.get(c_ma) or "").strip()
        if not ma:
            continue
        mien = MIEN_ALIAS.get(str(r.get(c_mien) or "").strip().upper(), "") if c_mien else ""
        if mien not in ("MB", "MN"):
            continue
        try:
            d = pd.to_datetime(r.get(c_date))
        except Exception:
            continue
        if pd.isna(d):
            continue
        y = d.year
        sl = num(r.get(c_qty)) if c_qty else 1
        key = (ma, mien)
        if key not in agg:
            agg[key] = {"xuat_2024": 0, "xuat_2025": 0, "xuat_lk_2026": 0}
        if y == 2024:
            agg[key]["xuat_2024"] += sl
        elif y == 2025:
            agg[key]["xuat_2025"] += sl
        elif y == 2026:
            agg[key]["xuat_lk_2026"] += sl
            total_lk[mien] += sl

    rows = []
    for (ma, mien), f in agg.items():
        pct = round(f["xuat_lk_2026"] / total_lk[mien] * 10000) / 100 if total_lk[mien] else 0
        rows.append({"ma_bravo": ma, "mien": mien, **f, "ty_le_sd_pct": pct})
    return rows

def _insert_batches(supa, table, rows):
    for i in range(0, len(rows), 500):
        supa.table(table).insert(rows[i:i+500]).execute()
        print(f"  {table}: +{min(i+500, len(rows))}/{len(rows)}")
    print(f"  ✓ {table}: {len(rows)} dòng")

def replace_table(supa, table, rows):
    # xoá sạch rồi nạp lại (dữ liệu tổng hợp — an toàn khi refresh)
    supa.table(table).delete().neq("mien", "__none__").execute()
    _insert_batches(supa, table, rows)

def refresh_stock_table(supa, rows):
    # RAW có lịch sử theo cycledate: CHỈ thay các cycledate đang nạp, giữ snapshot
    # cũ để RPC stock_agg còn chốt được tồn cho các đợt mở trước đó.
    cds = sorted({r["cycledate"] for r in rows if r.get("cycledate")})
    for cd in cds:
        supa.table("stock").delete().eq("cycledate", cd).execute()
        print(f"  stock: xoá cycledate={cd}")
    _insert_batches(supa, "stock", rows)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stock", required=True, help="file .xlsx chứa tab 'Chi tiết'")
    ap.add_argument("--usage", help="file .xlsx chứa tab 'SDVT' (tuỳ chọn)")
    ap.add_argument("--stock-tab", default="Chi tiết")
    ap.add_argument("--usage-tab", default="SDVT")
    ap.add_argument("--cycledate", help="ngày chốt snapshot YYYY-MM-DD (mặc định: hôm nay, hoặc theo cột trong file)")
    args = ap.parse_args()

    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    print("Nạp tồn kho RAW...")
    stock_rows = load_stock_raw(args.stock, args.stock_tab, args.cycledate)
    print(f"  {len(stock_rows)} dòng lô (raw)")
    refresh_stock_table(supa, stock_rows)

    if args.usage:
        print("Aggregate usage...")
        usage_rows = aggregate_usage(args.usage, args.usage_tab)
        print(f"  {len(usage_rows)} dòng")
        replace_table(supa, "usage_stat", usage_rows)

    print("\n✓ HOÀN TẤT refresh tồn kho/usage.")

if __name__ == "__main__":
    main()
