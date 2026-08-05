#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kiểm chứng cách tính TB KH mới (cửa sổ = các tháng HÀNG VỀ & ĐƯỢC DÙNG).

Tái hiện đúng logic của supabase/functions/order-api/index.ts:
  - Cửa sổ: `count` (số tháng đặt) tháng, bắt đầu lệch `offset` (leadtime) tháng
    so với tháng hiện tại (giờ VN, UTC+7).
    VD 2026-07, leadtime=3, số tháng đặt=3 -> [2026-10, 2026-11, 2026-12].
  - san_pham -> bộ vật tư (dm_bo_vat_tu_mapping): "vật tư riêng lẻ..." -> tra thẳng
    theo san_pham; ngược lại cộng dồn Σ các bộ chứa san_pham.
  - Mỗi khoá: Σ coalesce(sl_ke_hoach_update, sl_ke_hoach_dau_nam) qua các tháng cửa sổ.
  - TB KH = Σ / count.

Chạy:
  # cần biến môi trường (như các script migrate khác):
  #   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  python scripts/verify_tbkh.py --ten "bánh chè next gen" --mien ALL \
         --leadtime 3 --so-thang-dat 3 [--thang 2026-07]

Nếu bỏ --leadtime / --so-thang-dat, script sẽ đọc từ app_config (key 'goi_y');
--thang mặc định = tháng hiện tại theo giờ VN.
"""
import os
import re
import sys
import argparse
from datetime import datetime, timezone, timedelta

try:
    from supabase import create_client
except ImportError:
    sys.exit("Thiếu thư viện: pip install supabase")

VN = timezone(timedelta(hours=7))


def norm_key(s):
    s = (s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*-\s*", "-", s)
    return s


def is_vat_tu_le(bo):
    return norm_key(bo).startswith("vật tư riêng lẻ")


def norm_mien(m):
    m = (m or "").strip()
    if m in ("MB", "Miền Bắc"):
        return "MB"
    if m in ("MN", "Miền Nam"):
        return "MN"
    return m


def plan_months(count, offset, base):
    """count tháng 'yyyy-mm', bắt đầu lệch offset tháng so với `base` (datetime)."""
    m0 = base.year * 12 + (base.month - 1) + offset  # 0-based month index
    out = []
    for i in range(count):
        mi = m0 + i
        out.append(f"{mi // 12:04d}-{(mi % 12) + 1:02d}")
    return out


def fetch_all(q, page=1000):
    """Phân trang PostgREST."""
    rows, frm = [], 0
    while True:
        batch = q.range(frm, frm + page - 1).execute().data or []
        rows.extend(batch)
        if len(batch) < page:
            break
        frm += page
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ten", default="bánh chè next gen", help="tên san_pham (ilike)")
    ap.add_argument("--mien", default="ALL", choices=["ALL", "MB", "MN"])
    ap.add_argument("--leadtime", type=int, default=None, help="offset tháng (hàng về)")
    ap.add_argument("--so-thang-dat", type=int, default=None, help="độ rộng cửa sổ = số chia")
    ap.add_argument("--thang", default=None, help="tháng hiện tại yyyy-mm (mặc định: nay theo giờ VN)")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Cần đặt SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY trong môi trường.")
    supa = create_client(url, key)

    # --- Cấu hình (leadtime / số tháng đặt) ---
    cfg = {}
    try:
        r = supa.schema("app_order").table("app_config").select("value").eq("key", "goi_y").maybe_single().execute()
        cfg = (r.data or {}).get("value", {}) if r and r.data else {}
    except Exception:
        cfg = {}
    so_thang_dat = args.so_thang_dat
    if so_thang_dat is None:
        so_thang_dat = int(cfg.get("so_thang_dat_default") or 3)
    leadtime = args.leadtime
    if leadtime is None:
        leadtime = int(cfg.get("leadtime_thang_default") or so_thang_dat)
    count = max(1, so_thang_dat)
    offset = max(0, leadtime)

    if args.thang:
        y, m = args.thang.split("-")
        base = datetime(int(y), int(m), 1, tzinfo=VN)
    else:
        base = datetime.now(VN)

    months = plan_months(count, offset, base)

    print("=" * 68)
    print(f"Tháng hiện tại (VN) : {base:%Y-%m}")
    print(f"Leadtime (offset)   : {offset} tháng  (hàng bắt đầu về)")
    print(f"Số tháng đặt (rộng) : {count} tháng  (đồng thời là số chia)")
    print(f"Cửa sổ TB KH        : {', '.join(months)}")
    print(f"Miền                : {args.mien}")
    print("=" * 68)

    # --- Sản phẩm khớp tên ---
    prods = supa.schema("shared").table("dm_vat_tu").select(
        "ma_bravo, ten_vat_tu, san_pham, nhom_san_pham"
    ).ilike("san_pham", f"%{args.ten}%").eq("dat_hang", True).execute().data or []
    if not prods:
        # thử không lọc dat_hang (phòng khi cột chưa set)
        prods = supa.schema("shared").table("dm_vat_tu").select(
            "ma_bravo, ten_vat_tu, san_pham, nhom_san_pham"
        ).ilike("san_pham", f"%{args.ten}%").execute().data or []
    if not prods:
        sys.exit(f"Không tìm thấy dm_vat_tu nào có san_pham ~ '{args.ten}'.")

    san_phams = sorted({p["san_pham"] for p in prods if p.get("san_pham")})
    print(f"\nCÁC san_pham khớp ({len(san_phams)}):")
    for sp in san_phams:
        mabs_ = [p["ma_bravo"] for p in prods if p.get("san_pham") == sp]
        print(f"  • {sp}  — mã bravo: {', '.join(map(str, mabs_))}")

    # --- Mapping san_pham -> bộ vật tư ---
    mapping = fetch_all(supa.schema("shared").table("dm_bo_vat_tu_mapping").select("san_pham, bo_vat_tu"))
    sp_bo = {}  # norm(san_pham) -> {"le": bool, "bos": set}
    for r in mapping:
        sp = norm_key(r.get("san_pham"))
        if not sp:
            continue
        e = sp_bo.setdefault(sp, {"le": False, "bos": set()})
        if is_vat_tu_le(r.get("bo_vat_tu")):
            e["le"] = True
        else:
            e["bos"].add(norm_key(r.get("bo_vat_tu")))

    # --- sale_target trong cửa sổ, theo (san_pham, tháng) ---
    st = fetch_all(
        supa.schema("shared").table("sale_target")
        .select("mien, san_pham, thang_ke_hoach, sl_ke_hoach_dau_nam, sl_ke_hoach_update")
        .in_("thang_ke_hoach", months)
    )
    # key -> tháng -> tổng
    by_key_month = {}
    for r in st:
        if args.mien != "ALL" and norm_mien(r.get("mien")) != args.mien:
            continue
        key = norm_key(r.get("san_pham"))
        if not key:
            continue
        upd = r.get("sl_ke_hoach_update")
        val = float(upd) if upd is not None else float(r.get("sl_ke_hoach_dau_nam") or 0)
        d = by_key_month.setdefault(key, {})
        d[r["thang_ke_hoach"]] = d.get(r["thang_ke_hoach"], 0.0) + val

    sum_by_key = {k: sum(v.values()) for k, v in by_key_month.items()}

    # --- TB KH cho từng san_pham khớp ---
    for sp in san_phams:
        spk = norm_key(sp)
        m = sp_bo.get(spk)
        print("\n" + "-" * 68)
        print(f"san_pham: {sp}")
        if not m:
            print("  (không có trong dm_bo_vat_tu_mapping) -> tra thẳng theo san_pham")
            keys = [spk]
        elif m["le"] or not m["bos"]:
            print("  nhánh: VẬT TƯ LẺ -> tra thẳng theo san_pham")
            keys = [spk]
        else:
            print(f"  nhánh: BỘ -> cộng dồn {len(m['bos'])} bộ")
            keys = sorted(m["bos"])

        total = 0.0
        for k in keys:
            per_month = by_key_month.get(k, {})
            s = sum_by_key.get(k, 0.0)
            total += s
            detail = "  ".join(f"{mo}={per_month.get(mo, 0):g}" for mo in months)
            print(f"    [{k}] Σ={s:g}   ({detail})")

        tb = total / count
        print(f"  => Σ cửa sổ = {total:g} ;  TB KH = {total:g} / {count} = {tb:.2f}  (làm tròn: {round(tb)})")

    print("\n" + "=" * 68)
    print("Xong. Đối chiếu 'TB KH' ở trên với cột TB KH trên màn Chi tiết đặt hàng.")


if __name__ == "__main__":
    main()
