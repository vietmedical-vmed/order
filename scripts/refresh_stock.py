#!/usr/bin/env python3
"""
refresh_stock.py — Aggregate tồn kho ("Chi tiết") + usage ("SDVT") rồi nạp vào
Supabase (bảng stock, usage_stat). Thay cho việc Apps Script đọc live 26K dòng.

Chạy định kỳ (vd hằng ngày / trước mỗi đợt đặt hàng):
  pip install pandas openpyxl supabase
  python refresh_stock.py --stock ./chi_tiet.xlsx --usage ./sdvt.xlsx

Logic aggregate GIỮ NGUYÊN như _getStock/_getUsage cũ:
  Tồn tổng = DA(ton_kho) + KG(hang_ktv_bv) + đi đường − GU(hang_vet_thau)
  Miền suy từ cột "Miền", nếu trống thì từ prefix WarehouseCode (HN/DN→MB, SG→MN)
"""
import os, argparse, math
import pandas as pd
from supabase import create_client

REGION_PREFIX = {"HN": "MB", "SG": "MN", "DN": "MB"}
WAREHOUSE_TYPE_MAP = {"DA": "ton_kho", "GU": "hang_vet_thau", "KG": "hang_ktv_bv"}
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

def aggregate_stock(path, tab="Chi tiết"):
    df = pd.read_excel(path, sheet_name=tab, dtype=object)
    df.columns = [str(c).strip() for c in df.columns]
    c_item = col(df, "Itemcode")
    c_type = col(df, "WarehouseType")
    c_code = col(df, "WarehouseCode")
    c_mien = col(df, "Miền", "Mien")
    c_qty = col(df, "Chenh_Lech", "So_Luong")
    if not c_item or not c_type:
        raise SystemExit("Thiếu cột Itemcode hoặc WarehouseType trong tab tồn kho")

    agg = {}  # (ma, mien) -> dict fields
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
        wht = str(r.get(c_type) or "").strip().upper()
        field = WAREHOUSE_TYPE_MAP.get(wht)
        if not field:
            continue
        qty = round(num(r.get(c_qty)) if c_qty else 1)
        if not qty:
            continue
        key = (ma, mien)
        if key not in agg:
            agg[key] = {"ton_kho": 0, "hang_ktv_bv": 0, "hang_vet_thau": 0, "hang_di_duong": 0}
        agg[key][field] += qty

    rows = []
    for (ma, mien), f in agg.items():
        tong = f["ton_kho"] + f["hang_ktv_bv"] + f["hang_di_duong"] - f["hang_vet_thau"]
        rows.append({"ma_bravo": ma, "mien": mien, **f, "tong_ton": tong})
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

def replace_table(supa, table, rows):
    # xoá sạch rồi nạp lại (dữ liệu tổng hợp — an toàn khi refresh)
    supa.table(table).delete().neq("mien", "__none__").execute()
    for i in range(0, len(rows), 500):
        supa.table(table).insert(rows[i:i+500]).execute()
        print(f"  {table}: +{min(i+500, len(rows))}/{len(rows)}")
    print(f"  ✓ {table}: {len(rows)} dòng")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stock", required=True, help="file .xlsx chứa tab 'Chi tiết'")
    ap.add_argument("--usage", help="file .xlsx chứa tab 'SDVT' (tuỳ chọn)")
    ap.add_argument("--stock-tab", default="Chi tiết")
    ap.add_argument("--usage-tab", default="SDVT")
    args = ap.parse_args()

    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    print("Aggregate tồn kho...")
    stock_rows = aggregate_stock(args.stock, args.stock_tab)
    print(f"  {len(stock_rows)} dòng (ma_bravo × miền)")
    replace_table(supa, "stock", stock_rows)

    if args.usage:
        print("Aggregate usage...")
        usage_rows = aggregate_usage(args.usage, args.usage_tab)
        print(f"  {len(usage_rows)} dòng")
        replace_table(supa, "usage_stat", usage_rows)

    print("\n✓ HOÀN TẤT refresh tồn kho/usage.")

if __name__ == "__main__":
    main()
