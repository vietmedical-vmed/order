#!/usr/bin/env python3
"""
migrate_order.py — Nạp dữ liệu RIÊNG app Đặt hàng từ export Google Sheets cũ.
(users master coi như đã có sẵn trên cloud — KHÔNG nạp lại ở đây.)

Chuẩn bị: export Google Sheet cũ ra 1 file .xlsx giữ nguyên tên tab:
  Products     -> tạo order_catalog (thuộc tính riêng app)
  OrderSessions, OrderItems, AuditLog -> dữ liệu vận hành

  python migrate_order.py --source ./export_cu.xlsx

Role/mien nằm ở bảng users DÙNG CHUNG (cập nhật trực tiếp trên Supabase),
KHÔNG nạp ở script này.
Yêu cầu: đã chạy migrate_catalog.py trước (order_catalog tham chiếu dm_vat_tu).
"""
import os, argparse, math
import pandas as pd
from supabase import create_client

def clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)) or pd.isna(v):
        return None
    if isinstance(v, str):
        v = v.strip()
        if v == "":
            return None
    return v

def to_bool(v, default=True):
    if clean(v) is None:
        return default
    return str(v).strip().upper() not in ("FALSE", "0", "NO", "N")

def numv(v):
    v = clean(v)
    if v is None:
        return None
    try:
        return float(v)
    except Exception:
        return None

def read(xlsx, name):
    try:
        df = pd.read_excel(xlsx, sheet_name=name, dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        return df
    except Exception as e:
        print(f"  ⚠ bỏ qua tab {name}: {e}")
        return pd.DataFrame()

def get(r, *names):
    for n in names:
        if n in r and clean(r[n]) is not None:
            return clean(r[n])
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    args = ap.parse_args()
    xlsx = args.source
    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

    # danh sách ma_bravo hợp lệ trong master (order_catalog phải tham chiếu được)
    valid = set()
    off = 0
    while True:
        page = supa.table("dm_vat_tu").select("ma_bravo").range(off, off+999).execute().data
        if not page:
            break
        valid.update(str(x["ma_bravo"]) for x in page)
        off += 1000
    print(f"dm_vat_tu có {len(valid)} mã hợp lệ")

    # (role/mien nằm ở bảng users DÙNG CHUNG — cập nhật trực tiếp trên Supabase,
    #  không nạp ở đây.)

    # ---- order_catalog (từ Products cũ) ----
    print("order_catalog")
    df = read(xlsx, "Products")
    cat = []; skipped = 0
    for _, r in df.iterrows():
        ma = get(r, "ma_bravo", "Mã Bravo")
        if not ma:
            continue
        ma = str(ma).strip()
        if ma not in valid:
            skipped += 1
            continue
        cat.append({
            "ma_bravo": ma,
            "muc_do_sd": get(r, "muc_do_sd") or "",
            "don_vi": get(r, "don_vi") or "",
            "leadtime_ngay": numv(get(r, "leadtime_ngay")) or 0,
            "tb_kh_3_thang": numv(get(r, "tb_kh_3_thang")) or 0,
            "so_thang_dat": numv(get(r, "so_thang_dat")),
            "active": to_bool(get(r, "active")),
        })
    for i in range(0, len(cat), 500):
        supa.table("order_catalog").upsert(cat[i:i+500], on_conflict="ma_bravo").execute()
    print(f"  ✓ order_catalog: {len(cat)}  (bỏ {skipped} mã không có trong dm_vat_tu)")

    # ---- order_sessions ----
    print("order_sessions")
    df = read(xlsx, "OrderSessions")
    sess = []
    for _, r in df.iterrows():
        sid = get(r, "session_id")
        if not sid:
            continue
        row = {"session_id": str(sid), "ten_dot": get(r, "ten_dot"), "mien": get(r, "mien"),
               "trang_thai": get(r, "trang_thai") or "DRAFT", "tao_boi": get(r, "tao_boi")}
        for f in ("ngay_mo", "ngay_dong"):
            val = get(r, f)
            row[f] = pd.to_datetime(val).isoformat() if val is not None else None
        sess.append(row)
    if sess:
        supa.table("order_sessions").upsert(sess, on_conflict="session_id").execute()
    print(f"  ✓ {len(sess)}")

    # ---- order_items ----
    print("order_items")
    df = read(xlsx, "OrderItems")
    items = []
    for _, r in df.iterrows():
        iid = get(r, "item_id")
        if not iid or not get(r, "session_id"):
            continue
        ua = get(r, "updated_at")
        items.append({
            "item_id": str(iid), "session_id": str(get(r, "session_id")), "ma_bravo": get(r, "ma_bravo"),
            "sl_dat": numv(get(r, "sl_dat")), "sl_duyet": numv(get(r, "sl_duyet")),
            "sl_dat_hang": numv(get(r, "sl_dat_hang")),
            "ghi_chu_dat": get(r, "ghi_chu_dat") or "", "ghi_chu_duyet": get(r, "ghi_chu_duyet") or "",
            "ghi_chu_dat_hang": get(r, "ghi_chu_dat_hang") or "",
            "updated_at": pd.to_datetime(ua).isoformat() if ua is not None else None,
            "updated_by": get(r, "updated_by"),
        })
    for i in range(0, len(items), 500):
        supa.table("order_items").upsert(items[i:i+500], on_conflict="item_id").execute()
    print(f"  ✓ {len(items)}")

    # ---- audit_log ----
    print("audit_log")
    df = read(xlsx, "AuditLog")
    logs = []
    for _, r in df.iterrows():
        lid = get(r, "log_id")
        if not lid:
            continue
        ts = get(r, "timestamp")
        logs.append({"log_id": str(lid),
                     "timestamp": pd.to_datetime(ts).isoformat() if ts is not None else None,
                     "username": get(r, "username"), "action": get(r, "action"),
                     "session_id": get(r, "session_id") or "", "detail": get(r, "detail") or ""})
    for i in range(0, len(logs), 500):
        supa.table("audit_log").upsert(logs[i:i+500], on_conflict="log_id").execute()
    print(f"  ✓ {len(logs)}")

    print("\n✓ HOÀN TẤT. Tiếp theo: refresh_stock.py cho tồn kho/usage.")

if __name__ == "__main__":
    main()
