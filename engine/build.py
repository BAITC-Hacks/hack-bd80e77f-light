"""Сборка данных для веб-интерфейса и Excel-выгрузки.

    python -m engine.build            # web/data.js + output/Рекомендации_заказов.xlsx

Короткие поля артикула в web/data.js:
  id  код 1С            n   наименование         art артикул поставщика    sup поставщик
  g   группа товаров    abc ABC по частоте       pc  категория партнёра    moq кратность
  mq  1 — кратность есть в файле MOQ, 0 — принята 1     pr  себестоимость, null если нет
  st  текущий остаток   wh  остатки по складам   tr  товар в пути [документ, шт, ETA|null]
  raw / cln / rst  продажи: факт / без разовых заказов / + восстановленный спрос (по месяцам)
  av  доля месяца в наличии (если был stockout)  cap месяцы, срезанные фильтром Хампеля
  oo  разовые заказы [месяц, накладная, дата, шт, медиана]
  S   сезонность (12)   sw  вес собственного профиля
  v   оценки по вариантам факторов "разовые|stockout|сезонность" → [уровень, тренд, σ]
  nh  месяцев истории   rt  число возвратов в накладных
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from .forecast import (APPROVAL_BUFFER_DAYS, LEVEL_WINDOW, MIN_HISTORY_MONTHS, PROJECTION_DAYS, SCENARIOS,
                       STATUS_LABEL, Params, anchor_for, explain, fmt_day, plan, run_supplier, sku_payload)
from .backtest import run_backtest
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
    d = sku_payload(a, s["moq"], stock, s["abc"], tr)
    d["v"] = {k: [round(v[0], 2), round(v[1], 3), round(v[2], 2)] for k, v in d["v"].items()}
    d["S"] = _r(d["S"], 3)
    d.update({
        "id": code, "n": s["name"], "art": None if pd.isna(s["article"]) else str(s["article"]),
        "g": s["group"], "mq": int(bool(s.get("moq_known", False))),
        "pr": None if pd.isna(s["price"]) or s["price"] <= 0 else round(float(s["price"]), 2),
        "raw": _r(a.raw, 0), "cln": _r(a.clean, 1), "rst": _r(a.restored, 1), "sw": round(a.season_w, 2),
        "oo": [[mi[row.month], str(row.doc), row.date.strftime("%d.%m.%Y"), float(row.qty), float(row.median)]
               for row in oo.itertuples() if row.month in mi],
    })
    rt = res["supplier"].lines.attrs.get("returns")
    if rt is not None and code in rt.index:
        d["rt"] = int(rt[code])
    if (a.avail < 1).any():
        d["av"] = _r(a.avail, 1)
    if a.capped.any():
        d["cap"] = [int(i) for i in np.flatnonzero(a.capped)]
    if s.get("partner_cat") and not pd.isna(s.get("partner_cat")):
        d["pc"] = str(s["partner_cat"])
    wh = res["supplier"].extra.get("warehouses")
    if wh is not None and code in wh.index:
        d["wh"] = {k.strip(): float(v) for k, v in wh.loc[code].items() if not pd.isna(v) and v}
    return d


def build_meta(results: list[dict]) -> dict:
    hist = results[0]["hist"]
    return {
        "asOf": AS_OF.isoformat(),
        "months": [f"{RU_MON[p.month - 1]} {str(p.year)[2:]}" for p in hist],
        "monthNums": [p.month for p in hist],
        "anchor": anchor_for(hist, len(hist)),
        "z": SCENARIOS["base"]["z"],
        "scenarios": SCENARIOS,
        "buffer": APPROVAL_BUFFER_DAYS,
        "projectionDays": PROJECTION_DAYS,
        "minHistory": MIN_HISTORY_MONTHS,
        "levelWindow": LEVEL_WINDOW,
        "suppliers": {r["supplier"].key: {"name": r["supplier"].name, "lead": r["supplier"].lead_time,
                                          "S": _r(r["supplier"].season, 3)} for r in results},
    }


def orders_table(data: dict) -> pd.DataFrame:
    """Excel строится из тех же данных, что видит браузер, — цифры совпадают с интерфейсом."""
    meta = data["meta"]
    rows = []
    for d in data["skus"]:
        sup = meta["suppliers"][d["sup"]]
        p = Params(lead_time=sup["lead"])
        r = plan(d, p, meta["anchor"], AS_OF)
        if r["qty"] <= 0:
            continue
        rows.append({
            "Поставщик": sup["name"], "Код 1С": d["id"], "Артикул": d["art"] or "", "Наименование": d["n"],
            "Группа": d["g"], "ABC": d["abc"], "Остаток": r["stock"], "В пути (с датой)": r["transit"],
            "В пути без даты": r["transit_no_eta"] or None, "Спрос/мес": round(r["monthly"], 1),
            "Закончится": fmt_day(AS_OF, r["stockout_day"]), "Заказать до": fmt_day(AS_OF, r["safe_day"]),
            "Статус": STATUS_LABEL[r["status"]], "Срочность": r["urgency"], "Страховой запас": round(r["safety"], 1),
            "Кратность": d["moq"], "Рекомендуемый заказ": r["qty"], "Цена": d["pr"],
            "Стоимость строки": round(r["qty"] * d["pr"], 2) if d["pr"] else None,
            "Сценарий": SCENARIOS["base"]["label"], "Обоснование": explain(r, None, d, p, [], AS_OF),
        })
    return pd.DataFrame(rows).sort_values(["Поставщик", "Статус"])


def main():
    t0 = time.time()
    suppliers = load_all()
    results = [run_supplier(sd) for sd in suppliers]
    data = {"meta": build_meta(results), "skus": []}
    data["meta"]["bt"] = run_backtest(suppliers)
    OUT.mkdir(exist_ok=True)
    for r in results:
        for code in r["analyses"]:
            d = export_sku(code, r)
            if d:
                d["sup"] = r["supplier"].key
                data["skus"].append(d)

    WEB.mkdir(exist_ok=True)
    js = "window.DATA = " + json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + ";\n"
    (WEB / "data.js").write_text(js, encoding="utf-8")

    orders = orders_table(data)
    with pd.ExcelWriter(OUT / "Рекомендации_заказов.xlsx") as xw:
        for sup, g in orders.groupby("Поставщик"):
            g.to_excel(xw, sheet_name=sup[:31], index=False)
    print(f"SKU: {len(data['skus'])}, web/data.js: {len(js) / 1e6:.1f} МБ, "
          f"заказов: {len(orders)}, {time.time() - t0:.0f} с")


if __name__ == "__main__":
    main()
