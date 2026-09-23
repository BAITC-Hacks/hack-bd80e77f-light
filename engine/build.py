"""Сборка данных для веб-интерфейса и Excel-выгрузки.

    python -m engine.build            # web/data.js + output/Рекомендации_заказов.xlsx
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

from .forecast import (LEVEL_WINDOW, SERVICE_Z, Params, build_orders, run_supplier)
from .loaders import AS_OF, ROOT, load_all

WEB = ROOT / "web"
OUT = ROOT / "output"
RU_MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


def _r(x, nd=1):
    return [round(float(v), nd) for v in x]


def export_sku(code: str, res: dict) -> dict | None:
    a = res["analyses"][code]
    s = res["skus"].loc[code]
    tr = res["transit"].get(code, [])
    base = a.variants[(True, True, True)]
    stock = float(max(s["stock_now"] or 0, 0))
    if base["level"] <= 0 and stock <= 0 and not tr:
        return None
    oo = res["oneoffs"][res["oneoffs"]["code"] == code]
    hist = res["hist"]
    mi = {p: i for i, p in enumerate(hist)}
    d = {
        "id": code, "n": s["name"], "art": None if pd.isna(s["article"]) else s["article"],
        "g": s["group"], "abc": s["abc"], "moq": float(s["moq"]),
        "pr": None if pd.isna(s["price"]) else round(float(s["price"]), 2),
        "st": stock,
        "tr": [[t["doc"], t["qty"], t["eta"].isoformat() if t["eta"] else None] for t in tr],
        "raw": _r(a.raw, 0), "cln": _r(a.clean, 1), "rst": _r(a.restored, 1),
        "S": _r(a.S, 3), "sw": round(a.season_w, 2),
        "v": {f"{int(o)}{int(r)}{int(se)}": [round(e["level"], 2), round(e["growth"], 3), round(e["sd"], 2)]
              for (o, r, se), e in a.variants.items()},
        "oo": [[mi[row.month], str(row.doc), row.date.strftime("%d.%m.%Y"), float(row.qty), float(row.median)]
               for row in oo.itertuples() if row.month in mi],
    }
    if (a.avail < 1).any():
        d["av"] = _r(a.avail, 1)
    if a.capped.any():
        d["cap"] = [int(i) for i in np.flatnonzero(a.capped)]
    if s.get("partner_cat") and not pd.isna(s.get("partner_cat")):
        d["pc"] = str(s["partner_cat"])
    wh = res["supplier"].extra.get("warehouses")
    if wh is not None and code in wh.index:
        d["wh"] = {k.strip(): float(v) for k, v in wh.loc[code].items() if v}
    return d


def main():
    t0 = time.time()
    results = [run_supplier(sd) for sd in load_all()]
    hist = results[0]["hist"]
    last = hist[-1]
    data = {
        "meta": {
            "asOf": AS_OF.isoformat(),
            "months": [f"{RU_MON[p.month - 1]} {str(p.year)[2:]}" for p in hist],
            "monthNums": [p.month for p in hist],
            "anchor": last.year * 12 + last.month - 1 - (LEVEL_WINDOW - 1) / 2,
            "z": SERVICE_Z,
            "suppliers": {r["supplier"].key: {"name": r["supplier"].name, "lead": r["supplier"].lead_time,
                                              "S": _r(r["supplier"].season, 3)} for r in results},
        },
        "skus": [],
    }
    OUT.mkdir(exist_ok=True)
    frames = []
    for r in results:
        for code in r["analyses"]:
            d = export_sku(code, r)
            if d:
                d["sup"] = r["supplier"].key
                data["skus"].append(d)
        frames.append(build_orders(r, Params(lead_time=r["supplier"].lead_time)))

    WEB.mkdir(exist_ok=True)
    js = "window.DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    (WEB / "data.js").write_text(js, encoding="utf-8")

    orders = pd.concat(frames)
    orders = orders[orders["Рекомендуемый заказ"] > 0].sort_values(["Поставщик", "Срочность"])
    with pd.ExcelWriter(OUT / "Рекомендации_заказов.xlsx") as xw:
        for sup, g in orders.groupby("Поставщик"):
            g.to_excel(xw, sheet_name=sup[:31], index=False)
    print(f"SKU: {len(data['skus'])}, web/data.js: {len(js) / 1e6:.1f} МБ, "
          f"заказов: {len(orders)}, {time.time() - t0:.0f} с")


if __name__ == "__main__":
    main()
