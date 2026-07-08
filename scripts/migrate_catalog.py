#!/usr/bin/env python3
"""
migrate_catalog.py — Nạp DANH MỤC DÙNG CHUNG (dm_*) vào Supabase.

Tự dò sheet theo từ khoá tên; thiếu sheet nào thì BỎ QUA (không dừng).
Nhận 1 file hoặc cả thư mục:

  py scripts\\migrate_catalog.py --source "....\\Danh_mục_Sản_phẩm.xlsx"
  py scripts\\migrate_catalog.py --dir    "....\\Danh mục"

Cần biến môi trường: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
import os, glob, argparse, math
import pandas as pd
from supabase import create_client

# ---------------- helpers ----------------
def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v):
        return None
    if isinstance(v, str):
        v = v.strip()
        if v == "" or v.lower() == "null":
            return None
    return v

def numv(v):
    v = clean(v)
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace(" ", ""))
    except Exception:
        return None

def col(df, *cands):
    """Tìm tên cột khớp (không phân biệt hoa/thường, bỏ khoảng trắng)."""
    norm = {str(c).strip().lower(): c for c in df.columns}
    for c in cands:
        k = str(c).strip().lower()
        if k in norm:
            return norm[k]
    # thử 'contains'
    for c in cands:
        k = str(c).strip().lower()
        for nk, orig in norm.items():
            if k and k in nk:
                return orig
    return None

def cell(r, df, *cands):
    c = col(df, *cands)
    return clean(r[c]) if c is not None else None

# ---------------- sheet index ----------------
class Book:
    def __init__(self, files):
        self.sheets = []  # (norm_name, file, real_name)
        for f in files:
            try:
                xl = pd.ExcelFile(f)
            except Exception as e:
                print(f"  ⚠ không mở được {os.path.basename(f)}: {e}")
                continue
            for s in xl.sheet_names:
                self.sheets.append((s.strip().lower(), f, s))

    def find(self, *keywords):
        """Trả (file, sheet) cho sheet chứa TẤT CẢ keyword; None nếu không có."""
        kws = [k.lower() for k in keywords]
        for norm, f, real in self.sheets:
            if all(k in norm for k in kws):
                return f, real
        return None

    def read(self, *keywords):
        hit = self.find(*keywords)
        if not hit:
            print(f"  ⚠ không thấy sheet [{' '.join(keywords)}] → bỏ qua")
            return None
        f, real = hit
        df = pd.read_excel(f, sheet_name=real, dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        print(f"  · đọc sheet '{real}' ({len(df)} dòng)")
        return df

# ---------------- upsert ----------------
def push(supa, table, rows, on_conflict=None, chunk=500, replace=False):
    if not rows:
        print(f"  {table}: 0 dòng"); return
    if replace:
        try:
            supa.table(table).delete().neq(list(rows[0].keys())[0], "__x__zzz__").execute()
        except Exception:
            pass
    for i in range(0, len(rows), chunk):
        part = rows[i:i+chunk]
        if on_conflict:
            supa.table(table).upsert(part, on_conflict=on_conflict).execute()
        else:
            supa.table(table).insert(part).execute()
    print(f"  ✓ {table}: {len(rows)}")

def dedup(rows, keys):
    seen = set(); out = []
    for r in rows:
        k = tuple(r[k] for k in keys)
        if all(v is not None for v in k) and k not in seen:
            seen.add(k); out.append(r)
    return out

# ---------------- main ----------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="1 file .xlsx")
    ap.add_argument("--dir", help="thư mục chứa các file .xlsx")
    args = ap.parse_args()

    files = []
    if args.source:
        files.append(args.source)
    if args.dir:
        files += glob.glob(os.path.join(args.dir, "*.xlsx"))
    if not files:
        raise SystemExit("Cần --source <file> hoặc --dir <thư mục>")
    files = [f for f in dict.fromkeys(files)]  # unique, giữ thứ tự
    print("Quét file:", *[os.path.basename(f) for f in files])

    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    bk = Book(files)

    # ---- dm_bu (từ sheet 'Ngành hàng') ----
    print("dm_bu")
    df = bk.read("ngành hàng")
    if df is not None:
        rows = [{"bu": cell(r, df, "BU"), "ten_bu": cell(r, df, "Tên BU", "ten_bu")} for _, r in df.iterrows()]
        rows = dedup([x for x in rows if x["bu"]], ["bu"])
        push(supa, "dm_bu", rows, on_conflict="bu")

    # ---- dm_nhom_san_pham ----
    print("dm_nhom_san_pham")
    df = bk.read("nhóm sản phẩm")
    if df is not None:
        rows = [{"bu": cell(r, df, "BU"), "nhom_san_pham": cell(r, df, "Nhóm sản phẩm")} for _, r in df.iterrows()]
        rows = dedup([x for x in rows if x["bu"] and x["nhom_san_pham"]], ["bu", "nhom_san_pham"])
        push(supa, "dm_nhom_san_pham", rows, on_conflict="bu,nhom_san_pham")

    # ---- dm_san_pham (sheet 'Sản phẩm tổng') ----
    print("dm_san_pham")
    df = bk.read("sản phẩm tổng")
    if df is not None:
        rows = [{"bu": cell(r, df, "BU"), "nhom_san_pham": cell(r, df, "Nhóm sản phẩm"),
                 "san_pham": cell(r, df, "Sản phẩm")} for _, r in df.iterrows()]
        rows = dedup([x for x in rows if x["bu"] and x["nhom_san_pham"] and x["san_pham"]],
                     ["bu", "nhom_san_pham", "san_pham"])
        push(supa, "dm_san_pham", rows, on_conflict="bu,nhom_san_pham,san_pham")

    # ---- dm_vat_tu (sheet 'Vật tư') ----
    print("dm_vat_tu")
    df = bk.read("vật tư")
    if df is not None:
        rows = []
        for _, r in df.iterrows():
            ma = cell(r, df, "Mã vật tư (Bravo)", "ma_bravo", "Mã Bravo")
            if not ma:
                continue
            rows.append({
                "ma_bravo": str(ma).strip(),
                "ten_vat_tu": cell(r, df, "Tên vật tư (Bravo)", "ten_vat_tu"),
                "ma_ncc": cell(r, df, "Mã NCC", "ma_ncc"),
                "bu": cell(r, df, "BU"),
                "nhom_san_pham": cell(r, df, "Nhóm sản phẩm"),
                "san_pham": cell(r, df, "Sản phẩm"),
                "phan_loai_1": cell(r, df, "Phân loại 1"),
                "phan_loai_2": cell(r, df, "Phân loại 2"),
                "hang": cell(r, df, "Hãng"),
                "ma_hang": cell(r, df, "Mã hãng"),
                "don_gia_thau_cu": numv(cell(r, df, "Đơn giá Thầu cũ")),
                "don_gia_thau_moi": numv(cell(r, df, "Đơn giá Thầu mới")),
                "ma_pldt": cell(r, df, "Mã PLDT"),
                "ten_pldt": cell(r, df, "Tên PLDT"),
                "nhom_pldt": cell(r, df, "Nhóm PLDT"),
            })
        rows = dedup(rows, ["ma_bravo"])
        push(supa, "dm_vat_tu", rows, on_conflict="ma_bravo")

    # ---- dm_bo_vat_tu (sheet 'Bộ vật tư' — KHÔNG chứa 'mapping') ----
    print("dm_bo_vat_tu")
    hit = None
    for norm, f, real in bk.sheets:
        if "bộ vật tư" in norm and "mapping" not in norm:
            hit = (f, real); break
    if hit:
        df = pd.read_excel(hit[0], sheet_name=hit[1], dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        print(f"  · đọc sheet '{hit[1]}' ({len(df)} dòng)")
        rows = [{"bu": cell(r, df, "BU"), "nhom_san_pham": cell(r, df, "Nhóm sản phẩm"),
                 "bo_vat_tu": cell(r, df, "Bộ vật tư")} for _, r in df.iterrows()]
        rows = dedup([x for x in rows if x["bu"] and x["nhom_san_pham"] and x["bo_vat_tu"]],
                     ["bu", "nhom_san_pham", "bo_vat_tu"])
        push(supa, "dm_bo_vat_tu", rows, on_conflict="bu,nhom_san_pham,bo_vat_tu")
    else:
        print("  ⚠ không thấy sheet Bộ vật tư → bỏ qua")

    # ---- dm_bo_vat_tu_mapping (sheet 'Mapping Bộ vật tư') ----
    print("dm_bo_vat_tu_mapping")
    df = bk.read("mapping")
    if df is not None:
        rows = []
        for _, r in df.iterrows():
            if cell(r, df, "Bộ vật tư") and cell(r, df, "Sản phẩm"):
                rows.append({"bu": cell(r, df, "BU"), "nhom_san_pham": cell(r, df, "Nhóm sản phẩm"),
                             "bo_vat_tu": cell(r, df, "Bộ vật tư"), "san_pham": cell(r, df, "Sản phẩm"),
                             "so_luong_dinh_muc": numv(cell(r, df, "Số lượng định mức"))})
        push(supa, "dm_bo_vat_tu_mapping", rows, replace=True)

    # ---- dm_ps (sheet 'PS') ----
    print("dm_ps")
    df = bk.read("ps")
    if df is not None:
        rows = [{"bu": cell(r, df, "BU"), "area": cell(r, df, "Area"), "team": cell(r, df, "Team"),
                 "ps": cell(r, df, "PS"), "ten_ps": cell(r, df, "Tên PS"),
                 "trang_thai": cell(r, df, "Trạng thái")} for _, r in df.iterrows()]
        rows = dedup([x for x in rows if x["bu"] and x["ps"]], ["bu", "ps"])
        push(supa, "dm_ps", rows, on_conflict="bu,ps")

    # ---- dm_dia_ban (sheet 'Địa bàn') ----
    print("dm_dia_ban")
    df = bk.read("địa bàn")
    if df is not None:
        rows = [{"bu": cell(r, df, "BU"), "ten_ps": cell(r, df, "Tên PS"),
                 "ten_ma_pldt": cell(r, df, "Tên mã PLDT"),
                 "ten_doi_tuong": cell(r, df, "Tên đối tượng")} for _, r in df.iterrows()]
        rows = [x for x in rows if x["ten_doi_tuong"]]
        push(supa, "dm_dia_ban", rows, replace=True)

    # ---- dm_khach_hang (sheet 'Khách hàng') ----
    print("dm_khach_hang")
    df = bk.read("khách hàng")
    if df is not None:
        rows = []
        for _, r in df.iterrows():
            cid = cell(r, df, "Customer_id", "customer_id")
            if not cid:
                continue
            rows.append({"customer_id": str(cid), "customer_name": cell(r, df, "Customer_name"),
                         "group_id": cell(r, df, "Group_id"), "area_id": cell(r, df, "Area_id"),
                         "type_lvl1": cell(r, df, "Type_lvl1"), "type_lvl2": cell(r, df, "Type_lvl2"),
                         "address": cell(r, df, "Address")})
        rows = dedup(rows, ["customer_id"])
        push(supa, "dm_khach_hang", rows, on_conflict="customer_id", chunk=1000)

    print("\n✓ HOÀN TẤT (đã bỏ qua các sheet không có).")

if __name__ == "__main__":
    main()
