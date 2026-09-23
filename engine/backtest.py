"""Ретроспективная проверка прогноза (backtest) без утечки будущих данных.

На дату отсечения берутся только данные, известные к этому дню: месячные продажи и остатки
до отсечения, накладные до отсечения (для поиска разовых заказов), сезонность поставщика —
по полным годам до отсечения. Прогноз на следующие `horizon` месяцев сравнивается с фактом.

Метрики:
  WAPE = Σ|прогноз − факт| / Σ факт      — средняя ошибка в долях от продаж
  bias = Σ(прогноз − факт) / Σ факт       — систематическое завышение (+) или занижение (−)
Для сравнения считается «наивный» прогноз — среднее за 12 месяцев (как в ручном Excel).

Backtest измеряет точность прогноза спроса. Он НЕ доказывает предотвращённые дефициты:
для этого нужна точная история ежедневных остатков и поступлений.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .forecast import (Params, abc_by_frequency, analyze_sku, anchor_for, detect_oneoffs, monthly_demand,
                       sku_payload)
from .loaders import SupplierData


def season_before(sales: pd.DataFrame, cutoff: pd.Period) -> np.ndarray:
    """Сезонность поставщика по полным календарным годам до отсечения (в штуках)."""
    total = sales.sum()
    years = []
    for y in sorted({p.year for p in total.index}):
        idx = [pd.Period(year=y, month=m, freq="M") for m in range(1, 13)]
        if idx[-1] < cutoff and all(i in total.index for i in idx):
            v = total[idx].to_numpy(dtype=float)
            if v.mean() > 0:
                years.append(v / v.mean())
    s = np.mean(years, axis=0) if years else np.ones(12)
    return s / s.mean()


def forecast_at(sd: SupplierData, cutoff: pd.Period, horizon: int = 3) -> pd.DataFrame:
    """Прогноз по артикулам на `horizon` месяцев после отсечения + факт продаж."""
    hist = [m for m in sd.months if m < cutoff]
    future = [cutoff + i for i in range(horizon)]
    lines = sd.lines[sd.lines["date"] < cutoff.start_time]
    sales_hist = sd.sales[hist]
    oneoffs = detect_oneoffs(lines, sales_hist)
    oo = (oneoffs.groupby(["code", "month"])["qty"].sum().unstack().reindex(columns=hist).fillna(0)
          .reindex(sd.sales.index).fillna(0))
    season = season_before(sales_hist, cutoff)
    abc = abc_by_frequency(lines, sd.sales.index, cutoff.start_time.date())
    stock_known = sd.stock[[m for m in sd.months if m <= cutoff]]     # остаток на начало месяца отсечения известен
    anchor = anchor_for(hist, len(hist))
    p = Params()
    rows = []
    for code in sd.sales.index:
        raw = sales_hist.loc[code].to_numpy(dtype=float)
        a = analyze_sku(code, raw, stock_known.loc[code].to_numpy(dtype=float), oo.loc[code].to_numpy(dtype=float),
                        hist, season)
        if a.active.sum() < 3:
            continue
        sku = sku_payload(a, 1, 0, abc[code], [])
        fc = sum(monthly_demand(sku, p, anchor, m.year * 12 + m.month - 1) for m in future)
        naive = float(np.nan_to_num(raw[-12:]).mean()) * horizon
        fact = float(np.nan_to_num(sd.sales.loc[code, future].to_numpy(dtype=float)).sum())
        rows.append({"code": code, "sup": sd.name, "abc": abc[code], "forecast": fc, "naive": naive, "fact": fact})
    return pd.DataFrame(rows)


def metrics(df: pd.DataFrame, col: str = "forecast") -> dict:
    fact = df["fact"].sum()
    if fact <= 0:
        return {"n": int(len(df)), "wape": None, "bias": None, "under": None, "over": None}
    err = df[col] - df["fact"]
    moved = df[(df[col] > 0) | (df["fact"] > 0)]
    return {
        "n": int(len(df)),
        "wape": round(float(err.abs().sum() / fact), 3),
        "bias": round(float(err.sum() / fact), 3),
        "under": round(float((moved[col] < moved["fact"]).mean()), 3) if len(moved) else None,
        "over": round(float((moved[col] > moved["fact"]).mean()), 3) if len(moved) else None,
    }


def run_backtest(suppliers: list[SupplierData], cutoff: str = "2026-03", horizon: int = 3) -> dict:
    cut = pd.Period(cutoff, "M")
    df = pd.concat([forecast_at(sd, cut, horizon) for sd in suppliers], ignore_index=True)
    out = {
        "cutoff": cutoff, "horizon": horizon,
        "period": f"{cut.strftime('%m.%Y')} – {(cut + horizon - 1).strftime('%m.%Y')}",
        "overall": metrics(df), "naive": metrics(df, "naive"),
        "bySup": {s: metrics(g) for s, g in df.groupby("sup")},
        "byAbc": {a: metrics(g) for a, g in df.groupby("abc")},
        "naiveByAbc": {a: metrics(g, "naive") for a, g in df.groupby("abc")},
    }
    return out
