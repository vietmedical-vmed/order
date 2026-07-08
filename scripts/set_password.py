#!/usr/bin/env python3
"""
set_password.py — Đặt / đổi mật khẩu 1 user trên bảng users DÙNG CHUNG.

Mặc định khớp scheme hiện tại của bảng (cột salt để TRỐNG):
    password_hash = SHA-256(password)          [--no-salt, mặc định]
Nếu muốn có salt (bảo mật hơn) thì thêm --with-salt:
    password_hash = SHA-256(salt + ":" + password)

  set -a; source .env; set +a
  python set_password.py --user ctch_north --password matkhau123
  # tạo mới kèm thông tin:
  python set_password.py --user admin --password ... --create \
      --ho-va-ten "Quản trị" --role admin --mien BOTH

LƯU Ý: đây là bảng DÙNG CHUNG nhiều app — giữ đúng scheme để không phá app khác.
"""
import os, argparse, hashlib, secrets
from supabase import create_client

def hash_no_salt(password):
    return hashlib.sha256(password.encode("utf-8")).hexdigest()

def hash_salted(password, salt):
    return hashlib.sha256((salt + ":" + password).encode("utf-8")).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--with-salt", action="store_true", help="dùng salt (mặc định salt trống)")
    ap.add_argument("--create", action="store_true")
    ap.add_argument("--ho-va-ten", default="")
    ap.add_argument("--role", default="area_manager",
                    choices=["admin", "manager", "product_manager", "area_manager", "ps"])
    ap.add_argument("--mien", default="MB", choices=["MB", "MN", "BOTH"])
    ap.add_argument("--scope", default="")
    args = ap.parse_args()
    if len(args.password) < 6:
        raise SystemExit("Mật khẩu tối thiểu 6 ký tự")

    supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])
    uname = args.user.strip().lower()

    if args.with_salt:
        salt = secrets.token_hex(16)
        h = hash_salted(args.password, salt)
    else:
        salt = ""
        h = hash_no_salt(args.password)

    existing = supa.table("users").select("username").eq("username", uname).execute().data
    if existing:
        supa.table("users").update({"password_hash": h, "salt": salt}).eq("username", uname).execute()
        print(f"✓ Đã đổi mật khẩu cho {uname} (salt={'có' if salt else 'trống'})")
    elif args.create:
        supa.table("users").insert({
            "username": uname, "ho_va_ten": args.ho_va_ten or uname,
            "password_hash": h, "salt": salt,
            "role": args.role, "mien": args.mien, "scope": args.scope, "active": True,
        }).execute()
        print(f"✓ Đã tạo user {uname} (role={args.role}, mien={args.mien})")
    else:
        raise SystemExit(f"Không tìm thấy user {uname}. Thêm --create để tạo mới.")

if __name__ == "__main__":
    main()
