"""Алгоритм расчёта рекомендованного заказа.

Шаги (для каждого артикула):
  1. Разовые крупные заказы — поиск по накладным (медиана + MAD), исключение из регулярного спроса.
  2. Всплески в месячном ряду — фильтр Хампеля (для периода без накладных).
  3. Stockout — месяцы без остатка; упущенный спрос восстанавливается по ожидаемому уровню.
  4. Сезонность — коэффициенты поставщика, уточнённые по собственной истории артикула.
  5. Уровень и тренд — среднее по последним 6 мес. без сезонности, рост год к году (ограничен).
  6. Заказ — прогноз на срок поставки + период пересмотра + страховой запас − остаток − в пути,
     округление до кратности (MOQ).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from .loaders import AS_OF, SupplierData

# --- настройки алгоритма (все параметры в одном месте) ---------------------------------
ONEOFF_MIN_DOCS = 8          # минимум накладных по артикулу, чтобы судить о «типичном» заказе
ONEOFF_MAD_K = 6.0           # порог: медиана + K × MAD
ONEOFF_MEDIAN_X = 5.0        # и не меньше X медиан
ONEOFF_MONTH_SHARE = 0.25    # и накладная — заметная доля продаж месяца
ONEOFF_RECURRING = 0.20      # если крупные заказы идут в > 20 % месяцев
ONEOFF_RECURRING_MONTHS = 4  # или в 4+ разных месяцах — это регулярный оптовый спрос
HAMPEL_K = 3.0               # фильтр Хампеля для месячного ряда
LEVEL_WINDOW = 6             # мес. для базового уровня
TREND_CLIP = (-0.30, 0.50)   # ограничение роста год к году
SERVICE_Z = {"A": 1.65, "B": 1.28, "C": 0.84}   # 95 % / 90 % / 80 % уровень сервиса
MAD_SCALE = 1.4826
APPROVAL_BUFFER_DAYS = 3     # дней на согласование заказа внутри компании
PROJECTION_DAYS = 180        # горизонт календаря остатка
MIN_HISTORY_MONTHS = 3       # меньше — «Недостаточно данных»

# Сценарии — демонстрационные допущения (не вероятности). Меняются в одном месте;
# web/engine.js получает их из data.js, поэтому Python и браузер считают одинаково.
SCENARIOS = {
    "econ": {"label": "Экономный", "demand": -0.10, "lead_add_days": 0,
             "z": {"A": 1.28, "B": 0.84, "C": 0.52},
             "note": "спрос −10 %, срок поставки без изменений, уровень сервиса ниже: A 90 % · B 80 % · C 70 %"},
    "base": {"label": "Базовый", "demand": 0.0, "lead_add_days": 0,
             "z": dict(SERVICE_Z),
             "note": "текущий прогноз, текущий срок, уровень сервиса по ABC: A 95 % · B 90 % · C 80 %"},
    "protect": {"label": "Защитный", "demand": 0.20, "lead_add_days": 15,
                "z": {"A": 2.05, "B": 1.65, "C": 1.28},
                "note": "спрос +20 %, поставка на 15 дней дольше, уровень сервиса выше: A 98 % · B 95 % · C 90 %"},
}


@dataclass
class Params:
    lead_time: float = 1.5       # срок поставки, мес.
    review: float = 1.0          # период пересмотра заказа, мес.
    growth: float = 0.0          # ручной прогноз прироста (0.1 = +10 %)
    use_oneoff: bool = True      # исключать разовые крупные заказы
    use_restore: bool = True     # восстанавливать спрос в периоды stockout
    use_season: bool = True      # учитывать сезонность
    use_trend: bool = True       # учитывать тренд
    use_transit: bool = True     # учитывать товар в пути
    scenario: str = "base"       # econ / base / protect
    approval_buffer: int = APPROVAL_BUFFER_DAYS


# ------------------------------------------------------------------------------------------
# 1. Разовые крупные заказы
# ------------------------------------------------------------------------------------------
def detect_oneoffs(lines: pd.DataFrame, sales: pd.DataFrame) -> pd.DataFrame:
    """Возвращает строки накладных, признанные разовыми крупными заказами.

    Используются устойчивые к выбросам статистики: медиана и MAD размера отгрузки по артикулу.
    Заказ считается разовым, если он одновременно:
      • больше медиана + 6·MAD (и больше Q3 + 3·IQR),
      • больше 5 медиан,
      • составляет ≥ 25 % продаж артикула за месяц.
    Если такие крупные заказы повторяются (в 4+ месяцах или в > 20 % месяцев продаж артикула),
    это постоянный оптовый клиент — такой спрос регулярный и не исключается.
    """
    if lines.empty:
        return lines.assign(month=pd.Series(dtype="period[M]"), threshold=[], median=[])
    df = lines.copy()
    df["month"] = df["date"].dt.to_period("M")
    g = df.groupby("code")["qty"]
    stats = pd.DataFrame({
        "n": g.size(),
        "median": g.median(),
        "mad": g.apply(lambda s: np.median(np.abs(s - s.median()))) * MAD_SCALE,
        "q3": g.quantile(0.75),
        "iqr": g.quantile(0.75) - g.quantile(0.25),
    })
    stats["threshold"] = np.maximum.reduce([
        stats["median"] + ONEOFF_MAD_K * stats["mad"],
        stats["q3"] + 3 * stats["iqr"],
        stats["median"] * ONEOFF_MEDIAN_X,
    ])
    df = df.join(stats, on="code")
    month_total = df.groupby(["code", "month"])["qty"].transform("sum")
    # сверяем с месячным отчётом (там могут быть продажи, которых нет в накладных)
    monthly = sales.stack().rename("m_sales")
    monthly.index.names = ["code", "month"]
    df = df.join(monthly, on=["code", "month"])
    df["m_sales"] = np.fmax(df["m_sales"].fillna(0), month_total)
    mask = ((df["n"] >= ONEOFF_MIN_DOCS)
            & (df["qty"] > df["threshold"])
            & (df["qty"] >= ONEOFF_MONTH_SHARE * df["m_sales"]))
    flagged = df.loc[mask]
    big_months = flagged.groupby("code")["month"].nunique()
    sale_months = df.groupby("code")["month"].nunique()
    recurring = (((big_months / sale_months.reindex(big_months.index)) > ONEOFF_RECURRING)
                 | (big_months >= ONEOFF_RECURRING_MONTHS))
    flagged = flagged[~flagged["code"].isin(recurring[recurring].index)]
    return flagged[["code", "doc", "date", "month", "qty", "threshold", "median"]]


# ------------------------------------------------------------------------------------------
# 2. Фильтр Хампеля
# ------------------------------------------------------------------------------------------
def hampel_cap(x: np.ndarray, active: np.ndarray, window: int = 3) -> tuple[np.ndarray, np.ndarray]:
    """Срезает резкие одиночные всплески вверх до медиана + 3·MAD окна ±window мес."""
    y = x.copy()
    capped = np.zeros(len(x), dtype=bool)
    for i in np.flatnonzero(active):
        lo, hi = max(0, i - window), min(len(x), i + window + 1)
        w = x[lo:hi][active[lo:hi]]
        if len(w) < 5:
            continue
        med = np.median(w)
        mad = np.median(np.abs(w - med)) * MAD_SCALE
        lim = med + HAMPEL_K * max(mad, 0.25 * med, 1.0)
        if x[i] > lim and x[i] > 2 * med:
            y[i] = lim
            capped[i] = True
    return y, capped


# ------------------------------------------------------------------------------------------
# 3. Stockout
# ------------------------------------------------------------------------------------------
def availability(stock_start: np.ndarray, sales: np.ndarray, n_hist: int) -> np.ndarray:
    """Доля месяца, когда товар был в наличии (1 — весь месяц, 0 — не было совсем).

    Остаток известен на начало каждого месяца; конец месяца = начало следующего.
    """
    s = np.nan_to_num(stock_start, nan=0.0)
    a = np.ones(n_hist)
    for m in range(n_hist):
        start, end = s[m], s[m + 1] if m + 1 < len(s) else s[m]
        if start <= 0 and end <= 0:
            # весь месяц без остатка; если продажи всё же были — был приход в середине месяца
            a[m] = 0.1 if sales[m] <= 0 else 0.4
        elif start <= 0 or end <= 0:
            a[m] = 0.6
    return a


# ------------------------------------------------------------------------------------------
# 4. Сезонность
# ------------------------------------------------------------------------------------------
def sku_season(series: np.ndarray, months: list[pd.Period], supplier_s: np.ndarray,
               active: np.ndarray) -> tuple[np.ndarray, float]:
    """Индекс сезонности артикула: собственный профиль, «стянутый» к профилю поставщика.

    Вес собственного профиля растёт с количеством полных лет истории (до 0.6).
    """
    ratios = [[] for _ in range(12)]
    years = sorted({p.year for p in months})
    for y in years:
        idx = [i for i, p in enumerate(months) if p.year == y and i < len(series)]
        if len(idx) < 12 or not active[idx].all():
            continue
        mean = series[idx].mean()
        if mean <= 0:
            continue
        for i in idx:
            ratios[months[i].month - 1].append(series[i] / mean)
    full_years = min(len(r) for r in ratios)
    if full_years == 0:
        return supplier_s.copy(), 0.0
    own = np.array([np.mean(r) for r in ratios])
    nonzero = (series[active] > 0).mean() if active.any() else 0
    w = min(0.6, 0.3 * full_years) * nonzero
    s = w * own + (1 - w) * supplier_s
    s = np.clip(s, 0.3, 3.0)
    return s / s.mean(), float(w)


# ------------------------------------------------------------------------------------------
# 5. Уровень / тренд / разброс
# ------------------------------------------------------------------------------------------
def estimate(series: np.ndarray, months: list[pd.Period], S: np.ndarray,
             active: np.ndarray) -> dict:
    """Базовый уровень (без сезонности), рост г/г и стандартное отклонение спроса."""
    n = len(series)
    idx = np.flatnonzero(active[:n])
    if len(idx) == 0:
        return {"level": 0.0, "growth": 0.0, "sd": 0.0, "n": 0}
    seas = np.array([S[p.month - 1] for p in months[:n]])
    des = series / seas
    last = idx[-LEVEL_WINDOW:]
    level = float(des[last].mean())
    # рост год к году: последние 6 мес. против тех же месяцев год назад
    prev = last - 12
    growth = 0.0
    if prev.min() >= 0 and active[prev].all():
        base = des[prev].sum()
        if base > 0:
            growth = float(np.clip(des[last].sum() / base - 1, *TREND_CLIP))
    tail = idx[-12:]
    sd = float(np.std(des[tail], ddof=1)) if len(tail) >= 3 else level
    sd = min(sd, 1.5 * level) if level > 0 else sd
    return {"level": level, "growth": growth, "sd": sd, "n": int(len(idx))}


# ------------------------------------------------------------------------------------------
# Анализ артикула
# ------------------------------------------------------------------------------------------
@dataclass
class SkuAnalysis:
    code: str
    raw: np.ndarray            # фактические продажи по месяцам
    clean: np.ndarray          # без разовых заказов и всплесков
    restored: np.ndarray       # + восстановленный упущенный спрос
    avail: np.ndarray          # доля месяца в наличии
    active: np.ndarray         # месяцы, когда артикул уже продавался
    oneoff_by_month: np.ndarray
    capped: np.ndarray
    S: np.ndarray
    season_w: float
    variants: dict             # (oneoff, restore, season) -> estimate


def analyze_sku(code: str, raw: np.ndarray, stock: np.ndarray, oneoff_by_month: np.ndarray,
                months: list[pd.Period], supplier_s: np.ndarray) -> SkuAnalysis:
    n = len(raw)
    raw = np.nan_to_num(raw, nan=0.0)
    sold = np.flatnonzero(raw > 0)
    has_stock = np.flatnonzero(np.nan_to_num(stock[:n + 1], nan=0) > 0)
    first = min(sold[0] if len(sold) else n, has_stock[0] if len(has_stock) else n)
    active = np.arange(n) >= first

    no_oneoff = np.maximum(raw - oneoff_by_month, 0)
    ones = np.ones(12)
    variants, series = {}, {}
    avail = availability(stock, raw, n)
    avail[~active] = 1.0
    for use_oneoff in (True, False):
        base = no_oneoff if use_oneoff else raw
        capped_series, capped = hampel_cap(base, active) if use_oneoff else (base, np.zeros(n, bool))
        S, w = sku_season(capped_series, months, supplier_s, active)
        for use_restore in (True, False):
            x = capped_series.copy()
            if use_restore and (avail < 1).any():
                # ожидаемый спрос оцениваем по месяцам, когда товар был в наличии
                ok = active & (avail >= 1)
                est = estimate(x, months, S, ok if ok.any() else active)
                for m in np.flatnonzero(avail < 1):
                    expected = est["level"] * S[months[m].month - 1]
                    x[m] = max(x[m], min(expected, x[m] + (1 - avail[m]) * expected))
            series[(use_oneoff, use_restore)] = (x, capped, S, w)
            for use_season in (True, False):
                variants[(use_oneoff, use_restore, use_season)] = estimate(
                    x, months, S if use_season else ones, active)
    clean, capped, S, w = series[(True, False)]
    restored = series[(True, True)][0]
    return SkuAnalysis(code, raw, clean, restored, avail, active, oneoff_by_month, capped, S, w, variants)


# ------------------------------------------------------------------------------------------
# 6. Рекомендация
# ------------------------------------------------------------------------------------------
def horizon_months(as_of: date, horizon: float) -> list[tuple[int, float]]:
    """[(абс. номер месяца, доля месяца)] на горизонт `horizon` мес. начиная с as_of."""
    out, left = [], horizon
    y, m = as_of.year, as_of.month
    frac = 1 - (as_of.day - 1) / 30.0
    frac = min(frac, left)
    while left > 1e-9:
        out.append((y * 12 + m - 1, frac))
        left -= frac
        m += 1
        if m > 12:
            y, m = y + 1, 1
        frac = min(1.0, left)
    return out


def variant_key(p: Params) -> str:
    return f"{int(p.use_oneoff)}{int(p.use_restore)}{int(p.use_season)}"


def monthly_demand(sku: dict, p: Params, anchor: float, abs_month: int) -> float:
    """Прогноз спроса на календарный месяц (шт/мес) с сезонностью, трендом, приростом и сценарием."""
    level, growth, _sd = sku["v"][variant_key(p)][:3]
    g = growth if p.use_trend else 0.0
    r = (1 + g) ** (1 / 12) - 1
    s = sku["S"][abs_month % 12] if p.use_season else 1.0
    sc = SCENARIOS[p.scenario]
    return level * s * (1 + r) ** (abs_month - anchor) * (1 + p.growth) * (1 + sc["demand"])


def days_in_month(abs_month: int) -> int:
    y, m = divmod(abs_month, 12)
    return (date(y + (m + 1) // 12, (m + 1) % 12 + 1, 1) - date(y, m + 1, 1)).days


def split_transit(tr: list, as_of: date, horizon_days: int) -> dict:
    """Товар в пути: подтверждённый (есть ETA в пределах горизонта), поздний и без даты.

    Без даты прихода товар НЕ считается прибывшим вовремя — он показывается отдельно.
    """
    by_day, confirmed, late, no_eta = {}, 0.0, 0.0, 0.0
    for doc, qty, eta in tr:
        if not eta:
            no_eta += qty
            continue
        d = max(0, (date.fromisoformat(eta) - as_of).days)
        if d <= horizon_days:
            confirmed += qty
        else:
            late += qty
        by_day[d] = by_day.get(d, 0.0) + qty
    return {"by_day": by_day, "confirmed": confirmed, "late": late, "no_eta": no_eta}


def plan(sku: dict, p: Params, anchor: float, as_of: date = AS_OF) -> dict:
    """Полный расчёт по артикулу: количество, календарь остатка, дата окончания и безопасный день заказа.

    `sku` — словарь в формате web/data.js (v, S, st, tr, moq, abc, nh). Та же функция
    реализована в web/engine.js; согласованность проверяет tests/test_parity.py.
    """
    sc = SCENARIOS[p.scenario]
    level, _g, sd = sku["v"][variant_key(p)][:3]
    lead_days = round(p.lead_time * 30) + sc["lead_add_days"]
    L = lead_days / 30
    H = L + p.review
    path = [(am, f, monthly_demand(sku, p, anchor, am) * f) for am, f in horizon_months(as_of, H)]
    demand_h = sum(q for *_, q in path)
    demand_l = sum(monthly_demand(sku, p, anchor, am) * f for am, f in horizon_months(as_of, L))
    avg_s = float(np.mean([sku["S"][am % 12] for am, *_ in path])) if p.use_season else 1.0
    z = sc["z"].get(sku.get("abc", "C"), 0.84)
    safety = z * sd * (1 + sc["demand"]) * avg_s * math.sqrt(H)
    stock = max(float(sku.get("st") or 0), 0.0)
    tr = split_transit(sku.get("tr", []) if p.use_transit else [], as_of, round(H * 30))
    need = demand_h + safety - stock - tr["confirmed"]
    moq = max(float(sku.get("moq") or 1), 1.0)
    qty = math.ceil(need / moq - 1e-9) * moq if need > 0.5 else 0
    monthly = demand_h / H if H else 0.0

    # календарь остатка по дням
    arrival_day = p.approval_buffer + lead_days          # заказ, размещённый сегодня, придёт
    s0 = stock
    stockout = None
    deficit = deficit_lead = 0.0
    for i in range(PROJECTION_DAYS + 1):
        day = date.fromordinal(as_of.toordinal() + i)
        am = day.year * 12 + day.month - 1
        daily = monthly_demand(sku, p, anchor, am) / days_in_month(am) if level > 0 else 0.0
        s0 += tr["by_day"].get(i, 0.0)
        short = max(0.0, daily - s0)
        deficit += short
        if i < arrival_day:
            deficit_lead += short
        s0 = max(s0 - daily, 0.0)
        if stockout is None and daily > 0 and s0 <= 0:
            stockout = i

    enough_history = level > 0 and sku.get("nh", MIN_HISTORY_MONTHS) >= MIN_HISTORY_MONTHS
    safe_day = None if stockout is None or not enough_history else stockout - lead_days - p.approval_buffer
    if not enough_history:
        status = "nodata"
    elif stock <= 0:
        status = "now"
    elif safe_day is None:
        status = "later"
    elif safe_day < 0:
        status = "overdue"
    elif safe_day == 0:
        status = "today"
    elif safe_day <= 7:
        status = "week"
    else:
        status = "later"

    in_pipe = stock + tr["confirmed"]
    if qty > 0 and in_pipe < demand_l and demand_l >= 1:
        urgency = "critical"
    elif qty > 0 and in_pipe < demand_l + safety:
        urgency = "soon"
    elif qty > 0:
        urgency = "planned"
    else:
        urgency = "ok"
    return {
        "qty": int(qty), "need": need, "demand_h": demand_h, "demand_lt": demand_l, "safety": safety,
        "stock": stock, "transit": tr["confirmed"], "transit_no_eta": tr["no_eta"], "transit_late": tr["late"],
        "urgency": urgency, "status": status, "level": level, "growth": sku["v"][variant_key(p)][1] if p.use_trend else 0.0,
        "sd": sd, "z": z, "monthly": monthly, "lead_days": lead_days, "H": H, "moq": moq,
        "stockout_day": stockout if enough_history else None, "safe_day": safe_day,
        "arrival_day": arrival_day, "deficit": deficit, "deficit_lead": deficit_lead,
        "expected_deficit": enough_history and stockout is not None and stockout < arrival_day,
        "excess": max(0.0, stock + tr["confirmed"] - (6 * monthly + safety)),
    }


def sku_payload(a: "SkuAnalysis", moq: float, stock: float, abc: str, transit: list[dict]) -> dict:
    """Минимальный словарь артикула для plan() — тот же формат, что в web/data.js."""
    return {
        "v": {f"{int(o)}{int(r)}{int(se)}": [e["level"], e["growth"], e["sd"]]
              for (o, r, se), e in a.variants.items()},
        "S": [float(x) for x in a.S], "st": float(stock or 0), "moq": float(moq or 1), "abc": abc,
        "nh": int(a.active.sum()),
        "tr": [[t.get("doc", ""), float(t["qty"]), t["eta"].isoformat() if t.get("eta") else None] for t in transit],
    }


def anchor_for(months: list[pd.Period], n: int) -> float:
    last = months[n - 1]
    return last.year * 12 + last.month - 1 - (LEVEL_WINDOW - 1) / 2


def recommend(a: SkuAnalysis, sku: dict, transit: list[dict], months: list[pd.Period],
              p: Params, as_of: date = AS_OF) -> dict:
    payload = sku_payload(a, sku.get("moq"), sku.get("stock"), sku.get("abc", "C"), transit)
    return plan(payload, p, anchor_for(months, len(a.raw)), as_of)


def stock_projection(a: SkuAnalysis, r: dict, transit: list[dict], months: list[pd.Period], p: Params,
                     order_qty: float = 0, days: int = PROJECTION_DAYS, as_of: date = AS_OF) -> dict:
    """Совместимость: день окончания запаса и безопасный день заказа из plan()."""
    return {"stockout_day": r["stockout_day"], "order_by_day": r["safe_day"], "deficit": r["deficit"]}


def forecast_path(est: dict, S, anchor_abs: float, as_of: date, horizon: float,
                  p: Params) -> list[tuple[int, float, float]]:
    """Прогноз спроса по месяцам горизонта: [(абс. номер месяца, доля, спрос за долю)]."""
    sku = {"v": {variant_key(p): [est["level"], est["growth"], est["sd"]]}, "S": list(S)}
    return [(am, f, monthly_demand(sku, p, anchor_abs, am) * f) for am, f in horizon_months(as_of, horizon)]


STATUS_LABEL = {"now": "Дефицит сейчас", "overdue": "Просрочено", "today": "Сегодня",
                "week": "На этой неделе", "later": "Позже", "nodata": "Недостаточно данных"}


def fmt_day(as_of: date, d: int | None) -> str:
    return "Нет данных" if d is None else date.fromordinal(as_of.toordinal() + d).strftime("%d.%m.%Y")


def explain(r: dict, a: SkuAnalysis, sku: dict, p: Params, months: list[pd.Period], as_of: date = AS_OF) -> str:
    """Короткое объяснение рекомендации простыми словами и числами."""
    if r["status"] == "nodata":
        return "Недостаточно истории продаж для прогноза (меньше 3 месяцев или нулевой спрос)."
    f = lambda x: f"{x:,.0f}".replace(",", " ")
    t = f"При спросе {f(r['monthly'])} шт./мес. и остатке {f(r['stock'])} шт."
    if r["transit"]:
        t += f" (+{f(r['transit'])} в пути)"
    t += (f" товар закончится примерно {fmt_day(as_of, r['stockout_day'])}." if r["stockout_day"] is not None
          else f" запаса хватит больше чем на {PROJECTION_DAYS // 30} мес.")
    if r["safe_day"] is not None:
        t += f" Поставка {r['lead_days']} дн. + {p.approval_buffer} дн. на согласование"
        t += (f": последний безопасный день был {fmt_day(as_of, r['safe_day'])} ({-r['safe_day']} дн. назад) — "
              "заказывать нужно немедленно." if r["safe_day"] < 0
              else f": заказ нужно разместить не позднее {fmt_day(as_of, r['safe_day'])}.")
    if r["qty"] > 0:
        t += (f" Рекомендуется {f(r['qty'])} шт.: прогноз {f(r['demand_h'])} + страховой {f(r['safety'])} − остаток "
              f"{f(r['stock'])} − в пути {f(r['transit'])} = {f(r['need'])}, округлено до кратности {f(r['moq'])}.")
    else:
        t += " Заказ сейчас не нужен."
    if r["transit_no_eta"]:
        t += f" В пути без даты прихода {f(r['transit_no_eta'])} шт. — в расчёте не учтены, уточните ETA."
    return t


# ------------------------------------------------------------------------------------------
# Запуск по поставщику
# ------------------------------------------------------------------------------------------
PRODUCT_GROUPS = [
    ("Автоматы и защита", ["ва47", "ва88", "ва99", "ва63", "ва 47", "автомат", "c60", "armat", "расцепит",
                           "предохранит", "уздп", "зни", "опн", "узо", "авдт", "ад12", "ад 12", "ад14", "вд1", "диф"]),
    ("Контакторы и пускатели", ["контактор", "кми", "кти", "пускател", "мки", "реле", "кнопк", "пост кноп"]),
    ("Кабель и провод", ["кабель ", "utp", "ftp", "провод", "ввг", "пвс"]),
    ("Щиты и корпуса", ["щрн", "щрв", "щмп", "щит", "бокс", "корпус", "кмпн", "city 9", "ящик", "шкаф"]),
    ("Кабеленесущие системы", ["труб", "гофр", "кабель-канал", "лоток", "канал", "угол", "поворот",
                               "заглушк", "хомут", "кронштейн", "соединитель", "держател"]),
    ("Монтаж и клеммы", ["колодк", "клемм", "наконечник", "изолятор", "шина", "перемычк", "зажим",
                         "маркер", "сжим", "сальник", "тут ", "коробк", "распределительн", "установочн"]),
    ("Светотехника", ["светильник", "лампа", "прожектор", "led", "дпа", "дба", "батарейк"]),
    ("Приборы и автоматика", ["трансформ", "датчик", "амперметр", "вольтметр", "мультиметр", "преобраз",
                              "стабилизатор", "микр. конц", "электропривод", "счетчик", "счётчик", "таймер", "блок", "обогреват", "вентилят"]),
    ("Розетки и выключатели", ["роз", "выкл", "переключ", "рамка", "atlas", "brite", "glossa", "wessen",
                               "этюд", "artgallery", "прима", "1кл", "2кл", "o/у", "с/у", "механизм", "накладка", "usb"]),
]


def product_group(name: str) -> str:
    s = " ".join(str(name).lower().split()) + " "
    first = s.split(" ", 1)[0]
    if first in ("ва", "ba", "вa"):
        return "Автоматы и защита"
    for g, keys in PRODUCT_GROUPS:
        if any(k in s for k in keys):
            return g
    return "Прочее"


def abc_by_frequency(lines: pd.DataFrame, codes: pd.Index, as_of: date = AS_OF) -> pd.Series:
    """ABC по частоте заказов за 12 мес.: A — 80 % накладных, B — следующие 15 %, C — остальное."""
    recent = lines[lines["date"] >= pd.Timestamp(as_of) - pd.DateOffset(months=12)]
    cnt = recent.groupby("code").size().reindex(codes).fillna(0).sort_values(ascending=False)
    share = cnt.cumsum() / max(cnt.sum(), 1)
    abc = pd.Series("C", index=cnt.index)
    abc[share <= 0.80] = "A"
    abc[(share > 0.80) & (share <= 0.95)] = "B"
    abc[cnt == 0] = "C"
    return abc


def run_supplier(sd: SupplierData, as_of: date = AS_OF) -> dict:
    """Полный анализ поставщика: артикулы, разовые заказы, анализ рядов."""
    hist = [m for m in sd.months if m < pd.Period(as_of, "M")]
    n = len(hist)
    oneoffs = detect_oneoffs(sd.lines, sd.sales[hist])
    oo = (oneoffs.groupby(["code", "month"])["qty"].sum().unstack()
          .reindex(columns=hist).fillna(0))

    cur = pd.Period(as_of, "M")
    skus = sd.skus.copy()
    if "stock_now" not in skus or skus["stock_now"].isna().all():
        skus["stock_now"] = np.nan
    # IEK: текущий остаток = остаток на начало месяца − продажи с начала месяца
    fallback = (sd.stock[cur].fillna(0) - sd.sales[cur].fillna(0)).clip(lower=0) if cur in sd.stock else 0
    skus["stock_now"] = skus["stock_now"].fillna(fallback)
    skus["abc"] = abc_by_frequency(sd.lines, skus.index, as_of)
    skus["group"] = skus["name"].map(product_group)
    skus["price"] = skus["price"].where(skus["price"] > 0)   # цена 0 — это «нет цены», а не бесплатный товар
    transit = {c: g.to_dict("records") for c, g in sd.transit.groupby("code")}

    analyses = {}
    raw_m = sd.sales[hist].to_numpy(dtype=float)
    stock_m = sd.stock.to_numpy(dtype=float)
    oo_m = oo.reindex(sd.sales.index).fillna(0).to_numpy(dtype=float)
    for i, code in enumerate(sd.sales.index):
        analyses[code] = analyze_sku(code, raw_m[i], stock_m[i], oo_m[i], hist, sd.season)
    return {"supplier": sd, "hist": hist, "oneoffs": oneoffs, "skus": skus, "transit": transit,
            "analyses": analyses}


def build_orders(res: dict, p: Params | None = None, as_of: date = AS_OF) -> pd.DataFrame:
    """Таблица рекомендаций по поставщику."""
    sd: SupplierData = res["supplier"]
    p = p or Params(lead_time=sd.lead_time)
    rows = []
    for code, a in res["analyses"].items():
        s = res["skus"].loc[code]
        sku = {"moq": s["moq"], "stock": s["stock_now"], "abc": s["abc"]}
        tr = res["transit"].get(code, [])
        r = recommend(a, sku, tr, res["hist"], p, as_of)
        if r["level"] <= 0 and r["stock"] <= 0 and not tr:
            continue
        rows.append({
            "Поставщик": sd.name, "Код 1С": code, "Артикул": s["article"], "Наименование": s["name"],
            "Группа": s["group"], "ABC": s["abc"], "Остаток": r["stock"], "В пути": r["transit"],
            "Спрос/мес": round(r["monthly"], 1), "Страховой запас": round(r["safety"], 1),
            "Кратность": s["moq"], "Рекомендуемый заказ": r["qty"], "Срочность": r["urgency"],
            "Статус": STATUS_LABEL[r["status"]], "Закончится": fmt_day(as_of, r["stockout_day"]),
            "Заказать до": fmt_day(as_of, r["safe_day"]),
            "Цена": s["price"] if s["price"] and s["price"] > 0 else None,
            "Обоснование": explain(r, a, {"moq": s["moq"]}, p, res["hist"], as_of),
        })
    return pd.DataFrame(rows)
