#!/usr/bin/env python3
"""
migrate.py — Nạp dữ liệu nghiệp vụ từ export Google Sheets vào Supabase.

Chuẩn bị: từ Google Sheet đang chạy, export 5 tab ra .xlsx (File → Download → xlsx)
hoặc từng .csv. Đặt tên tab đúng như CONFIG.SHEETS cũ:
  Users, Products, OrderSessions, OrderItems, AuditLog
rồi trỏ SOURCE_XLSX vào file đó.

Chạy:
  pip install pandas openpyxl supabase python-dotenv
  # điền .env (xem .env.example), rồi:
  python migrate.py --source ./export.xlsx

Lưu ý: KHÔNG hardcode key. Đọc từ biến môi trường:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
"""
import os, sys, math, argparse
import pandas as pd
from supabase import create_client

def clean(v):
    """NaN / NaT -> None (fix lỗi serialize NaN từ CHCS FY26)."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if pd.isna(v):
        return None
    return v

def to_bool(v, default=True):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return default
    s = str(v).strip().upper()
    if s in ("FALSE", "0", "NO", "KHÔNG", "N"):
        return False
    if s in ("TRUE", "1", "YES", "CÓ", "Y"):
        return True
    return default

def read_tab(xlsx, name):
    try:
        df = pd.read_excel(xlsx, sheet_name=name, dtype=object)
        df.columns = [str(c).strip() for c in df.columns]
        return df
    except Exception as e:
        print(f"  ⚠ Không đọc được tab '{name}': {e}")
        return pd.DataFrame()

def rows_of(df, mapping, transforms=None):
    transforms = transforms or {}
    out = []
    for _, r in df.iterrows():
        rec = {}
        empty = True
        for col, key in mapping.items():
            val = clean(r.get(col))
            if key in transforms:
                val = transforms[key](val)
            rec[key] = val
            if val not in (None, ""):
                empty = False
        if not empty:
            out.append(rec)
    return out

def upsert(supa, table, records, chunk=500, on_conflict=None):
    if not records:
        print(f"  {table}: 0 dòng, bỏ qua")
        return
    total = 0
    for i in range(0, len(records), chunk):
        part = records[i:i+chunk]
        q = supa.table(table)
        if on_conflict:
            q.upsert(part, on_conflict=on_conflict).execute()
        else:
            q.insert(part).execute()
        total += len(part)
        print(f"  {table}: +{total}/{len(records)}")
    print(f"  ✓ {table}: {total} dòng")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="đường dẫn file .xlsx export từ Google Sheets")
    ap.add_argument("--wipe", action="store_true", help="xoá sạch bảng trước khi nạp")
    args = ap.parse_args()

    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    supa = create_client(url, key)
    xlsx = args.source

    if args.wipe:
        print("Xoá dữ liệu cũ...")
        for t in ("order_items", "order_sessions", "audit_log", "products", "users"):
            supa.table(t).delete().neq("__none__", "__none__").execute() if False else \
                supa.table(t).delete().gte("username" if t == "users" else "ma_bravo" if t == "products" else "log_id" if t == "audit_log" else "item_id" if t == "order_items" else "session_id", "").execute()

    # ---- USERS ----
    print("USERS")
    df = read_tab(xlsx, "Users")
    users = rows_of(df, {
        "username": "username", "ho_ten": "ho_ten",
        "password_hash": "password_hash", "salt": "salt",
        "role": "role", "mien": "mien", "active": "active",
    }, transforms={"active": lambda v: to_bool(v), "username": lambda v: str(v).strip().lower() if v else v})
    users = [u for u in users if u.get("username") and u.get("password_hash")]
    upsert(supa, "users", users, on_conflict="username")

    # ---- PRODUCTS ----
    print("PRODUCTS")
    df = read_tab(xlsx, "Products")
    prods = rows_of(df, {
        "ma_bravo": "ma_bravo", "code_ncc": "code_ncc", "ten_hang_hoa": "ten_hang_hoa",
        "nhom_hang": "nhom_hang", "phan_loai": "phan_loai", "muc_do_sd": "muc_do_sd",
        "don_vi": "don_vi", "gia": "gia", "leadtime_ngay": "leadtime_ngay",
        "tb_kh_3_thang": "tb_kh_3_thang", "so_thang_dat": "so_thang_dat", "active": "active",
    }, transforms={"active": lambda v: to_bool(v)})
    prods = [p for p in prods if p.get("ma_bravo")]
    upsert(supa, "products", prods, on_conflict="ma_bravo")

    # ---- ORDER SESSIONS ----
    print("ORDER SESSIONS")
    df = read_tab(xlsx, "OrderSessions")
    sess = rows_of(df, {
        "session_id": "session_id", "ten_dot": "ten_dot", "mien": "mien",
        "ngay_mo": "ngay_mo", "ngay_dong": "ngay_dong",
        "trang_thai": "trang_thai", "tao_boi": "tao_boi",
    })
    for s in sess:
        for f in ("ngay_mo", "ngay_dong"):
            if s.get(f) is not None:
                s[f] = pd.to_datetime(s[f]).isoformat()
    upsert(supa, "order_sessions", [s for s in sess if s.get("session_id")], on_conflict="session_id")

    # ---- ORDER ITEMS ----
    print("ORDER ITEMS")
    df = read_tab(xlsx, "OrderItems")
    items = rows_of(df, {
        "item_id": "item_id", "session_id": "session_id", "ma_bravo": "ma_bravo",
        "sl_dat": "sl_dat", "sl_duyet": "sl_duyet", "sl_dat_hang": "sl_dat_hang",
        "ghi_chu_dat": "ghi_chu_dat", "ghi_chu_duyet": "ghi_chu_duyet",
        "ghi_chu_dat_hang": "ghi_chu_dat_hang", "updated_at": "updated_at", "updated_by": "updated_by",
    })
    for it in items:
        if it.get("updated_at") is not None:
            it["updated_at"] = pd.to_datetime(it["updated_at"]).isoformat()
    upsert(supa, "order_items", [it for it in items if it.get("item_id") and it.get("session_id")],
           on_conflict="item_id")

    # ---- AUDIT LOG ----
    print("AUDIT LOG")
    df = read_tab(xlsx, "AuditLog")
    logs = rows_of(df, {
        "log_id": "log_id", "timestamp": "timestamp", "username": "username",
        "action": "action", "session_id": "session_id", "detail": "detail",
    })
    for l in logs:
        if l.get("timestamp") is not None:
            l["timestamp"] = pd.to_datetime(l["timestamp"]).isoformat()
    upsert(supa, "audit_log", [l for l in logs if l.get("log_id")], on_conflict="log_id")

    print("\n✓ HOÀN TẤT migrate dữ liệu nghiệp vụ.")
    print("  Tiếp theo: chạy refresh_stock.py để nạp tồn kho + usage.")

if __name__ == "__main__":
    main()
