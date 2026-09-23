"""Охват каталога: сколько товаров из выгрузок дошло до прогноза и рекомендации, и почему остальные исключены.

Путь данных:
  catalog      — все уникальные коды 1С из файлов продаж и остатков;
  withData     — есть хотя бы одна продажа или ненулевой остаток за весь период;
  published    — попали в web/data.js (правило engine/build.py::export_sku);
  forecastable — опубликованы и имеют ≥ MIN_HISTORY_MONTHS месяцев истории и ненулевой уровень спроса;
  recommended  — получили рекомендацию к заказу (передаётся снаружи).

Причины исключения (взаимоисключающие, проверяются по порядку):
  no_data  — за весь период нет ни продаж, ни остатка, ни товара в пути;
  inactive — данные были, но спрос за последние 6 активных месяцев нулевой, остатка и товара в пути нет
             (выведенный из оборота или давно не продающийся товар — заказывать нечего);
  other    — остальные случаи (на текущих данных не встречаются).

В результат попадают только числа и тексты — без кодов, названий и номеров документов.
"""
from __future__ import annotations

import re

import numpy as np

from .forecast import MIN_HISTORY_MONTHS

CODE_RE = re.compile(r"^[0-9A-Za-z]+_?$")
REASONS = [
    ("no_data", "Нет продаж, остатков и товара в пути за весь период"),
    ("inactive", "Нет продаж за последние 6 месяцев, нет остатка и товара в пути"),
    ("other", "Другая причина"),
]


def coverage_stats(results: list[dict], published_ids: set[str], recommended: int | None = None) -> dict:
    """results — результаты engine.forecast.run_supplier по поставщикам; published_ids — коды в web/data.js."""
    total = {"catalog": 0, "withData": 0, "published": 0, "forecastable": 0}
    reasons = {k: 0 for k, _ in REASONS}
    short_history = nonstandard = 0
    by_sup = {}
    for res in results:
        sd = res["supplier"]
        codes = res["skus"].index
        sup = {"catalog": len(codes), "published": 0, "excluded": 0}
        for code in codes:
            a = res["analyses"].get(code)
            raw = np.nan_to_num(sd.sales.loc[code].to_numpy(dtype=float)) if code in sd.sales.index else np.zeros(1)
            stock_hist = np.nan_to_num(sd.stock.loc[code].to_numpy(dtype=float)) if code in sd.stock.index else np.zeros(1)
            stock_now = float(np.nan_to_num(res["skus"].loc[code].get("stock_now", 0)))
            has_transit = bool(res["transit"].get(code))
            has_data = (raw > 0).any() or (stock_hist > 0).any() or stock_now > 0 or has_transit
            total["withData"] += bool(has_data)
            if code in published_ids:
                sup["published"] += 1
                level = a.variants[(True, True, True)]["level"] if a is not None else 0.0
                months = int(a.active.sum()) if a is not None else 0
                if level > 0 and months >= MIN_HISTORY_MONTHS:
                    total["forecastable"] += 1
                else:
                    short_history += 1
                if not CODE_RE.match(str(code)):
                    nonstandard += 1
                continue
            sup["excluded"] += 1
            if not has_data:
                reasons["no_data"] += 1
            elif stock_now <= 0 and not has_transit:
                reasons["inactive"] += 1
            else:
                reasons["other"] += 1
        total["catalog"] += sup["catalog"]
        total["published"] += sup["published"]
        by_sup[sd.key] = sup
    excluded = total["catalog"] - total["published"]
    return {
        **total,
        "recommended": recommended,
        "excluded": excluded,
        "reasons": [{"code": k, "label": label, "count": reasons[k]} for k, label in REASONS],
        "notices": [
            {"code": "short_history", "label": "Опубликованы, но истории меньше 3 месяцев или спрос нулевой — статус «Недостаточно данных»",
             "count": short_history},
            {"code": "nonstandard_code", "label": "Код 1С в нестандартном формате (например, артикул вместо кода) — проверить при загрузке в 1С",
             "count": nonstandard},
        ],
        "bySupplier": by_sup,
    }
