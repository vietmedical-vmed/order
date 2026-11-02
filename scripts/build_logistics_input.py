#!/usr/bin/env python3
"""
build_logistics_input.py — Sinh "Hàng đi đường" từ các file theo dõi mua hàng
hằng tuần (Mua hàng_<NCC>_dd.mm.yyyy.xlsx) thay cho việc copy tay vào template,
và (tuỳ chọn) ghi thành snapshot của app_order.logistics_input.

File đầu vào GIỮ NGUYÊN như bộ phận mua hàng gửi. Script đọc theo TIÊU ĐỀ CỘT
(không theo tên sheet / vị trí cột), bỏ sheet ẩn, chỉ lấy các file có cùng ngày
trong tên (mặc định: ngày mới nhất trong thư mục).

Quy tắc "đang đi đường":
  - Sheet có cột B'LANCE (CTCH1 "chi tiết"): chỉ NCC Ulrich / UOC / Biopsybell;
    B'LANCE < 0 -> đi đường SL = -B'LANCE (phần chưa về); = 0 -> đã về.
  - Sheet khác: theo cột Tình trạng/Status (xem STATUS_TRANSIT / STATUS_CLOSED).
    Arrived vẫn tính đi đường (đã về nhưng chưa nhập kho).
  - Miền: HN/KHOHN/DN/KHODN -> MB; HCM/SG/KHOSG/KHOHCM -> MN.

Ký gửi chưa có nguồn: sheet "ký gửi" của file output copy từ template gần nhất.

--upload ghi ĐÚNG nội dung file output (đi đường + ký gửi) thành snapshot
snapshot_date = ngày dữ liệu (sql/23_logistics_snapshot_date.sql). Snapshot cũ
giữ nguyên: mỗi đợt đặt hàng đọc snapshot mới nhất <= ngày mở đợt. Upload lại
cùng ngày thì thay snapshot ngày đó. --load-template nạp 1 file template có sẵn
(vd sau khi sửa tay) thành snapshot theo ngày trong tên file.

Chạy:
  pip install pandas openpyxl
  python scripts/build_logistics_input.py --dir "D:/.../Hàng đi đường"
  python scripts/build_logistics_input.py --dir "..." --date 2026-11-02 --upload
  python scripts/build_logistics_input.py --load-template ".../Hàng đi đường + ký gửi_2026-10-26.xlsx"

Ghi DB qua Supabase CLI đã link (`supabase db query --linked`), chạy trong 1
transaction: lỗi giữa chừng thì không đổi gì.
"""
import argparse, glob, json, math, os, re, subprocess, sys, tempfile
from collections import defaultdict
from datetime import date, datetime

import openpyxl
import pandas as pd

# ---------------------------------------------------------------- cấu hình ---
STATUS_TRANSIT = {"on the way", "not yet", "ready", "backorder", "back order",
                  "on hold", "hold", "arrived", "not ready"}
STATUS_CLOSED = {"done", "cancel", "cancelled", "canceled", "hủy", "huỷ"}
MIEN_OF_KHO = {
    "HN": "MB", "KHOHN": "MB", "DN": "MB", "KHODN": "MB",
    "HCM": "MN", "SG": "MN", "KHOSG": "MN", "KHOHCM": "MN",
}
MIEN_LABEL = {"MB": "Miền Bắc", "MN": "Miền Nam"}
MIEN_ALIAS = {"MIỀN BẮC": "MB", "MB": "MB", "MIỀN NAM": "MN", "MN": "MN"}
KHO_LABEL = {"MB": "HN", "MN": "HCM"}
BALANCE_NCC = ("ulrich", "uoc", "biopsybell")   # CTCH1: chỉ lấy các NCC này

# Tên cột chấp nhận (đã chuẩn hoá: UPPER, gộp khoảng trắng)
C_BRAVO = ("CODE BRAVO", "MÃ BRAVO", "BRAVO")
C_STATUS = ("TÌNH TRẠNG", "STATUS")
C_QTY = ("SL", "SL (PCS)", "SL PCS", "QUANTITY (PCS)")
C_LOC = ("PORT", "KHO VỀ", "KHO-DM", "KHO", "DES")
C_PO = ("SỐ PO", "PO", "PO VMD")
C_DM = ("ĐNMH", "DM", "DNMH")
C_NCC = ("NCC",)
C_ETA = ("ETA",)
C_IO = ("SỐ IO", "IO")
C_BAL = ("B'LANCE",)

FILE_RE = re.compile(r"^Mua hàng_(?P<ncc>.+?)_(?P<d>\d{1,2})\.(?P<m>\d{1,2})\.(?P<y>\d{4})\.xlsx$",
                     re.IGNORECASE)
TPL_RE = re.compile(r"Hàng đi đường \+ ký gửi_(\d{4}-\d{2}-\d{2})\.xlsx$", re.IGNORECASE)
MAX_COL = 60
HEADER_SCAN_ROWS = 10
EMPTY_STOP = 200        # dừng đọc sau ngần này dòng trống liên tiếp (used range bị phình)


# ----------------------------------------------------------------- tiện ích ---
def norm_header(v):
    return re.sub(r"\s+", " ", str(v)).strip().upper() if v is not None else ""

def txt(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return ""
    return str(v).strip()

def num(v):
    if v is None or isinstance(v, (datetime, date)):
        return None
    try:
        f = float(str(v).replace(",", "").strip())
        return None if math.isnan(f) else f
    except ValueError:
        return None

def find_col(headers, names):
    for n in names:
        if n in headers:
            return headers.index(n)
    return None

def mien_of(v):
    return MIEN_OF_KHO.get(re.sub(r"\s+", "", txt(v)).upper())


# ------------------------------------------------------------ chọn file vào ---
def pick_files(folder, run_date=None):
    found = []
    for p in glob.glob(os.path.join(folder, "*.xlsx")):
        name = os.path.basename(p)
        if name.startswith("~$"):
            continue
        m = FILE_RE.match(name)
        if not m:
            continue
        d = date(int(m["y"]), int(m["m"]), int(m["d"]))
        found.append((d, m["ncc"], p))
    if not found:
        raise SystemExit(f"Không thấy file 'Mua hàng_<NCC>_dd.mm.yyyy.xlsx' trong {folder}")
    run_date = run_date or max(d for d, _, _ in found)
    files = sorted([(ncc, p) for d, ncc, p in found if d == run_date], key=lambda x: x[0].lower())
    if not files:
        raise SystemExit(f"Không có file nào ngày {run_date:%d.%m.%Y}")
    return run_date, files


# -------------------------------------------------------------- đọc 1 sheet ---
def read_rows(ws):
    """Đọc giá trị, bỏ qua used range phình to (dừng sau EMPTY_STOP dòng trống)."""
    rows, empty = [], 0
    for r in ws.iter_rows(max_col=MAX_COL, values_only=True):
        if all(c is None or (isinstance(c, str) and not c.strip()) for c in r):
            empty += 1
            if empty >= EMPTY_STOP:
                break
            rows.append(None)
            continue
        empty = 0
        rows.append(r)
    return rows

def detect_header(rows):
    """Dòng tiêu đề = dòng đầu (trong HEADER_SCAN_ROWS) có cột Mã Bravo + SL/B'LANCE."""
    for i, r in enumerate(rows[:HEADER_SCAN_ROWS]):
        if r is None:
            continue
        h = [norm_header(c) for c in r]
        if find_col(h, C_BRAVO) is not None and (
                find_col(h, C_BAL) is not None or find_col(h, C_QTY) is not None):
            return i, h
    return None, None


def parse_sheet(ncc_file, path, ws, warn):
    """Trả list dòng PO (dict) của 1 sheet; sheet không đủ cột -> bỏ qua."""
    rows = read_rows(ws)
    hi, h = detect_header(rows)
    src = f"{os.path.basename(path)} / {ws.title}"
    if hi is None:
        return [], f"bỏ qua (không có cột Mã Bravo + SL)"
    ci = {k: find_col(h, names) for k, names in {
        "bravo": C_BRAVO, "status": C_STATUS, "qty": C_QTY, "loc": C_LOC, "po": C_PO,
        "dm": C_DM, "ncc": C_NCC, "eta": C_ETA, "io": C_IO, "bal": C_BAL}.items()}
    mode = "balance" if ci["bal"] is not None else "status"
    missing = [k for k in (("loc", "bal") if mode == "balance" else ("loc", "status", "qty"))
               if ci[k] is None]
    if missing:
        return [], f"bỏ qua (thiếu cột {', '.join(missing)})"

    def g(r, k):
        j = ci[k]
        return r[j] if j is not None and j < len(r) else None

    out, n_closed = [], 0
    for ri, r in enumerate(rows[hi + 1:], start=hi + 2):
        if r is None:
            continue
        ma = txt(g(r, "bravo"))
        ncc = txt(g(r, "ncc")) or ncc_file
        status = txt(g(r, "status"))
        if mode == "balance":
            if not any(k in ncc.lower() for k in BALANCE_NCC):
                continue
            bal = num(g(r, "bal"))
            if bal is None:
                if ma and ma.upper() != "HỦY":
                    warn(src, ri, ma, f"B'LANCE không phải số: {g(r, 'bal')!r}")
                continue
            if bal > 0:
                warn(src, ri, ma, f"B'LANCE dương ({bal:g}) = về thừa, không tính")
                continue
            if bal == 0:
                n_closed += 1
                continue
            qty = -bal
        else:
            st = status.lower()
            if st in STATUS_CLOSED:
                n_closed += 1
                continue
            if st not in STATUS_TRANSIT:
                if ma or st:
                    warn(src, ri, ma, f"Tình trạng chưa ánh xạ: {status!r} (không tính)")
                continue
            qty = num(g(r, "qty"))
            if qty is None or qty <= 0:
                warn(src, ri, ma, f"SL không hợp lệ: {g(r, 'qty')!r}")
                continue
        if not ma:
            warn(src, ri, ma, f"thiếu Mã Bravo (SL {qty:g}, PO {txt(g(r, 'po'))})")
            continue
        if not txt(g(r, "po")):
            warn(src, ri, ma, f"đang tính đi đường nhưng không có số PO (SL {qty:g})")
        mien = mien_of(g(r, "loc"))
        if not mien:
            warn(src, ri, ma, f"Kho/Port không xác định miền: {txt(g(r, 'loc'))!r}")
            continue
        eta = g(r, "eta")
        out.append({
            "file": os.path.basename(path), "sheet": ws.title, "dong": ri,
            "ncc": ncc, "dnmh": txt(g(r, "dm")), "so_po": txt(g(r, "po")),
            "ma_bravo": ma, "kho": txt(g(r, "loc")), "mien": mien,
            "tinh_trang": status if mode == "status" else "B'LANCE<0",
            "sl_di_duong": qty, "so_io": txt(g(r, "io")),
            "eta": eta.date() if isinstance(eta, datetime) else txt(eta),
        })
    return out, f"{len(out)} dòng đi đường, {n_closed} dòng đã về/huỷ ({mode})"


# ------------------------------------------------------------- tổng hợp ---
def build(folder, run_date=None):
    run_date, files = pick_files(folder, run_date)
    print(f"Ngày dữ liệu: {run_date:%d.%m.%Y} — {len(files)} file")
    warnings, lines = [], []

    def warn(src, row, ma, msg):
        warnings.append({"nguon": src, "dong": row, "ma_bravo": ma, "canh_bao": msg})

    for ncc, path in files:
        print(f"  {os.path.basename(path)}")
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            if ws.sheet_state != "visible":
                continue
            got, note = parse_sheet(ncc, path, ws, warn)
            print(f"    - {ws.title}: {note}")
            lines.extend(got)
        wb.close()

    # Cùng 1 dòng PO xuất hiện ở 2 file khác nhau (vd file tổng CTCH2 chứa lại
    # sheet Arthrex/Zimmer) -> chỉ giữ 1 lần.
    seen, dedup, n_dup = {}, [], 0
    for ln in lines:
        k = (ln["so_po"], ln["ma_bravo"], ln["mien"], ln["sl_di_duong"], ln["tinh_trang"])
        if ln["so_po"] and k in seen and seen[k] != ln["file"]:
            n_dup += 1
            continue
        seen.setdefault(k, ln["file"])
        dedup.append(ln)
    if n_dup:
        print(f"  Bỏ {n_dup} dòng trùng giữa các file")

    agg = defaultdict(float)
    for ln in dedup:
        agg[(ln["mien"], ln["ma_bravo"])] += ln["sl_di_duong"]
    return run_date, dedup, agg, warnings


def latest_template(out_dir, before):
    best = None
    for p in glob.glob(os.path.join(out_dir, "*.xlsx")):
        m = TPL_RE.search(os.path.basename(p))
        if m and not os.path.basename(p).startswith("~$"):
            d = date.fromisoformat(m[1])
            if d < before and (best is None or d > best[0]):
                best = (d, p)
    return best


def write_excel(out_path, run_date, lines, agg, warnings, tpl_dir):
    dd = pd.DataFrame(
        [{"KHO-DM": KHO_LABEL[m], "MÃ BRAVO": ma, "SL DM": q, "Miền": MIEN_LABEL[m]}
         for (m, ma), q in sorted(agg.items())],
        columns=["KHO-DM", "MÃ BRAVO", "SL DM", "Miền"])

    prev = latest_template(tpl_dir, run_date)
    kg = pd.DataFrame(columns=["Miền", "MÃ BRAVO", "SL ký gửi"])
    cmp = pd.DataFrame()
    if prev:
        print(f"  Template trước: {os.path.basename(prev[1])}")
        sheets = pd.read_excel(prev[1], sheet_name=None)
        kg = sheets.get("ký gửi", kg)
        old = sheets.get("đi đường")
        if old is not None:
            old = old.assign(**{"MÃ BRAVO": old["MÃ BRAVO"].astype(str).str.strip()})
            o = old.groupby(["Miền", "MÃ BRAVO"])["SL DM"].sum().rename("SL tuần trước")
            n = dd.groupby(["Miền", "MÃ BRAVO"])["SL DM"].sum().rename("SL tuần này")
            cmp = pd.concat([o, n], axis=1).fillna(0).reset_index()
            cmp["Chênh lệch"] = cmp["SL tuần này"] - cmp["SL tuần trước"]
            cmp = cmp[cmp["Chênh lệch"] != 0].sort_values("Chênh lệch")
    else:
        print("  Không thấy template trước -> sheet ký gửi để trống")

    with pd.ExcelWriter(out_path, engine="openpyxl") as xw:
        dd.to_excel(xw, sheet_name="đi đường", index=False)
        kg.to_excel(xw, sheet_name="ký gửi", index=False)
        pd.DataFrame(lines).to_excel(xw, sheet_name="chi tiết PO", index=False)
        pd.DataFrame(warnings, columns=["nguon", "dong", "ma_bravo", "canh_bao"]) \
            .to_excel(xw, sheet_name="cảnh báo", index=False)
        if not cmp.empty:
            cmp.to_excel(xw, sheet_name="so với tuần trước", index=False)
    return dd, prev


# ------------------------------------------------------------------ upload ---
UPLOAD_SQL = """
begin;
create temp table _s on commit drop as
  select x.ma_bravo, x.mien, x.dd, x.kg
    from jsonb_to_recordset($json${payload}$json$::jsonb) as x(ma_bravo text, mien text, dd numeric, kg numeric);
-- snapshot = đúng nội dung file; upload lại cùng ngày thì thay snapshot đó
delete from app_order.logistics_input where snapshot_date = date '{snap}';
insert into app_order.logistics_input (snapshot_date, ma_bravo, mien, hang_di_duong, hang_ktv_bv)
select date '{snap}', ma_bravo, mien, dd, kg from _s;
-- trạng thái sau khi ghi (dry-run: trước khi rollback)
select snapshot_date::text as snapshot, mien, count(*) as so_ma,
       sum(hang_di_duong) as di_duong, sum(hang_ktv_bv) as ky_gui
  from app_order.logistics_input
 where snapshot_date >= (select coalesce(max(snapshot_date), date '{snap}') from app_order.logistics_input
                          where snapshot_date < date '{snap}')
 group by 1, 2 order by 1, 2;
{finish};
"""

def snapshot_rows(xlsx_path):
    """Đọc file 'Hàng đi đường + ký gửi' (output hoặc template tay) -> {(mien, ma): [dd, kg]}."""
    sheets = pd.read_excel(xlsx_path, sheet_name=None)
    rows = defaultdict(lambda: [0.0, 0.0])
    for sheet, qcol, k in (("đi đường", "SL DM", 0), ("ký gửi", "SL ký gửi", 1)):
        df = sheets.get(sheet)
        if df is None or df.empty:
            continue
        for _, r in df.iterrows():
            mien = MIEN_ALIAS.get(txt(r.get("Miền")).upper())
            ma, q = txt(r.get("MÃ BRAVO")), num(r.get(qcol))
            if not mien or not ma or not q:
                if ma or q:
                    print(f"  ! {sheet}: bỏ dòng {ma!r} miền {r.get('Miền')!r} SL {r.get(qcol)!r}")
                continue
            rows[(mien, ma)][k] += q
    return rows

def upload(xlsx_path, snap, dry_run=False):
    rows = snapshot_rows(xlsx_path)
    payload = json.dumps([{"ma_bravo": ma, "mien": m, "dd": v[0], "kg": v[1]}
                          for (m, ma), v in rows.items()], ensure_ascii=False)
    sql = UPLOAD_SQL.format(payload=payload, snap=snap.isoformat(),
                            finish="rollback" if dry_run else "commit")
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        tmp = f.name
    try:
        r = subprocess.run(["supabase", "db", "query", "--linked", "-f", tmp],
                           capture_output=True, text=True, encoding="utf-8",
                           cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    finally:
        os.unlink(tmp)
    if r.returncode != 0:
        raise SystemExit(f"Upload lỗi:\n{r.stderr or r.stdout}")
    print(r.stdout[-1500:])


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", help="thư mục chứa các file 'Mua hàng_<NCC>_dd.mm.yyyy.xlsx'")
    ap.add_argument("--date", help="ngày trong tên file, YYYY-MM-DD (mặc định: mới nhất)")
    ap.add_argument("--out-dir", help="nơi ghi file output (mặc định: <dir>/Đi đường + Ký gửi)")
    ap.add_argument("--upload", action="store_true",
                    help="ghi file output thành snapshot <ngày> trong app_order.logistics_input")
    ap.add_argument("--load-template", metavar="XLSX",
                    help="chỉ upload 1 file 'Hàng đi đường + ký gửi_YYYY-MM-DD.xlsx' có sẵn (ngày lấy từ tên)")
    ap.add_argument("--dry-run", action="store_true", help="với --upload/--load-template: chạy SQL rồi rollback")
    args = ap.parse_args()
    tag = " (dry-run, rollback)" if args.dry_run else ""

    if args.load_template:
        m = TPL_RE.search(os.path.basename(args.load_template))
        if not m:
            raise SystemExit("Tên file phải dạng 'Hàng đi đường + ký gửi_YYYY-MM-DD.xlsx'")
        print(f"Ghi snapshot {m[1]} từ {os.path.basename(args.load_template)}{tag}...")
        upload(args.load_template, date.fromisoformat(m[1]), dry_run=args.dry_run)
        return
    if not args.dir:
        ap.error("cần --dir (hoặc --load-template)")

    run_date = date.fromisoformat(args.date) if args.date else None
    run_date, lines, agg, warnings = build(args.dir, run_date)
    tpl_dir = os.path.join(args.dir, "Đi đường + Ký gửi")
    out_dir = args.out_dir or tpl_dir
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"Hàng đi đường + ký gửi_{run_date.isoformat()}.xlsx")
    dd, _ = write_excel(out_path, run_date, lines, agg, warnings, tpl_dir)

    by_mien = dd.groupby("Miền")["SL DM"].agg(["count", "sum"])
    print(f"\n✓ {out_path}")
    for m, r in by_mien.iterrows():
        print(f"  {m}: {int(r['count'])} mã, SL {r['sum']:g}")
    print(f"  Cảnh báo: {len(warnings)} (xem sheet 'cảnh báo')")

    if args.upload:
        print(f"\nGhi snapshot {run_date.isoformat()} vào app_order.logistics_input{tag}...")
        upload(out_path, run_date, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
