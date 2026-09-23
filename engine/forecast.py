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
ONEOFF_RECURRING = 0.25      # если крупные заказы идут в > 25 % месяцев — это регулярный оптовый спрос
HAMPEL_K = 3.0               # фильтр Хампеля для месячного ряда
LEVEL_WINDOW = 6             # мес. для базового уровня
TREND_CLIP = (-0.30, 0.50)   # ограничение роста год к году
SERVICE_Z = {"A": 1.65, "B": 1.28, "C": 0.84}   # 95 % / 90 % / 80 % уровень сервиса
MAD_SCALE = 1.4826


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
    Если такие крупные заказы повторяются более чем в 25 % месяцев продаж артикула,
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
    recurring = (big_months / sale_months.reindex(big_months.index)) > ONEOFF_RECURRING
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
    """[(номер месяца 1..12, доля месяца)] на горизонт `horizon` мес. начиная с as_of."""
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


def forecast_path(est: dict, S: np.ndarray, anchor_abs: float, as_of: date, horizon: float,
                  p: Params) -> list[tuple[int, float, float]]:
    """Прогноз спроса по месяцам горизонта: [(абс. номер месяца, доля, спрос за долю)]."""
    g = est["growth"] if p.use_trend else 0.0
    r = (1 + g) ** (1 / 12) - 1
    out = []
    for abs_m, frac in horizon_months(as_of, horizon):
        s = S[abs_m % 12] if p.use_season else 1.0
        q = est["level"] * s * (1 + r) ** (abs_m - anchor_abs) * (1 + p.growth)
        out.append((abs_m, frac, q * frac))
    return out


def recommend(a: SkuAnalysis, sku: dict, transit: list[dict], months: list[pd.Period],
              p: Params, as_of: date = AS_OF) -> dict:
    est = a.variants[(p.use_oneoff, p.use_restore, p.use_season)]
    n = len(a.raw)
    last = months[n - 1]
    anchor = last.year * 12 + last.month - 1 - (LEVEL_WINDOW - 1) / 2
    H = p.lead_time + p.review
    path = forecast_path(est, a.S, anchor, as_of, H, p)
    demand_h = sum(q for *_, q in path)
    demand_lt = sum(q for *_, q in forecast_path(est, a.S, anchor, as_of, p.lead_time, p))
    avg_s = np.mean([a.S[m % 12] for m, *_ in path]) if p.use_season else 1.0
    z = SERVICE_Z.get(sku.get("abc", "C"), 0.84)
    safety = z * est["sd"] * avg_s * math.sqrt(H)
    stock = max(float(sku.get("stock") or 0), 0.0)
    in_transit = sum(t["qty"] for t in transit) if p.use_transit else 0.0
    need = demand_h + safety - stock - in_transit
    moq = max(float(sku.get("moq") or 1), 1.0)
    qty = math.ceil(need / moq - 1e-9) * moq if need > 0.5 else 0

    monthly_now = demand_h / H if H else 0
    if qty > 0 and stock + in_transit < demand_lt:
        urgency = "critical"
    elif qty > 0 and stock + in_transit < demand_lt + safety:
        urgency = "soon"
    elif qty > 0:
        urgency = "planned"
    else:
        urgency = "ok"
    excess = max(0.0, stock + in_transit - (6 * monthly_now + safety))
    return {
        "qty": int(qty), "need": need, "demand_h": demand_h, "demand_lt": demand_lt,
        "safety": safety, "stock": stock, "transit": in_transit, "urgency": urgency,
        "level": est["level"], "growth": est["growth"] if p.use_trend else 0.0, "sd": est["sd"],
        "monthly": monthly_now, "cover_months": (stock / monthly_now) if monthly_now > 0 else None,
        "excess": excess, "z": z,
    }


def explain(r: dict, a: SkuAnalysis, sku: dict, p: Params, months: list[pd.Period]) -> str:
    """Текстовое обоснование рекомендованного количества."""
    parts = [f"Регулярный спрос ≈ {r['level']:.0f} {sku.get('unit', 'шт')}/мес"]
    n_one = int((a.oneoff_by_month > 0).sum())
    if p.use_oneoff and n_one:
        parts.append(f"исключены разовые заказы ({a.oneoff_by_month.sum():.0f} шт в {n_one} мес.)")
    lost = float((a.restored - a.clean)[-12:].sum())
    if p.use_restore and lost > 0.5:
        parts.append(f"восстановлен упущенный спрос при отсутствии товара (+{lost:.0f} за 12 мес.)")
    if p.use_trend and abs(r["growth"]) >= 0.05:
        parts.append(f"тренд {r['growth']:+.0%} г/г")
    if p.growth:
        parts.append(f"прогноз прироста {p.growth:+.0%}")
    if p.use_season:
        parts.append(f"сезонность на горизонте ×{r['demand_h'] / max(r['level'] * (p.lead_time + p.review), 1e-9):.2f}"
                     if r["level"] > 0 else "сезонность учтена")
    head = "; ".join(parts) + "."
    calc = (f" Потребность на {p.lead_time + p.review:g} мес. = {r['demand_h']:.0f} + страховой запас "
            f"{r['safety']:.0f} − остаток {r['stock']:.0f} − в пути {r['transit']:.0f} = {r['need']:.0f}")
    if r["qty"] > 0:
        moq = sku.get("moq") or 1
        calc += f" → кратность {moq:g} → заказ {r['qty']}."
    else:
        calc += " → заказ не нужен."
    return head + calc


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
            "Цена": s["price"], "Обоснование": explain(r, a, {"moq": s["moq"]}, p, res["hist"]),
        })
    return pd.DataFrame(rows)
