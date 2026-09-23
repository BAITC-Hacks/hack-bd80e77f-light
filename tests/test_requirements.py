"""Проверка пяти обязательных требований ТЗ (раздел 7 «Must have») на синтетических данных.

    pytest -q
"""
from datetime import date

import numpy as np
import pandas as pd

from engine.forecast import Params, build_orders, forecast_path, recommend, run_supplier, stock_projection
from engine.loaders import SupplierData

AS_OF = date(2026, 9, 22)
MONTHS = list(pd.period_range("2024-01", "2026-09", freq="M"))
FLAT_SEASON = np.ones(12)


def make_supplier(series: dict[str, np.ndarray], stock: dict[str, np.ndarray] | None = None,
                  lines: pd.DataFrame | None = None, transit: pd.DataFrame | None = None,
                  moq: dict | None = None, season=FLAT_SEASON, key="T") -> SupplierData:
    codes = list(series)
    sales = pd.DataFrame([series[c] for c in codes], index=codes, columns=MONTHS, dtype=float)
    st = pd.DataFrame([(stock or {}).get(c, np.full(len(MONTHS), 200.0)) for c in codes],
                      index=codes, columns=MONTHS, dtype=float)
    skus = pd.DataFrame({"name": [f"Товар {c}" for c in codes], "article": codes,
                         "moq": [(moq or {}).get(c, 1) for c in codes], "price": 100.0,
                         "partner_cat": None}, index=codes)
    if lines is None:
        lines = regular_lines(series)
    if transit is None:
        transit = pd.DataFrame(columns=["code", "doc", "qty", "eta"])
    return SupplierData(key, f"Поставщик {key}", 1.5, MONTHS, skus, sales, st, lines, transit,
                        np.asarray(season, dtype=float))


def regular_lines(series: dict[str, np.ndarray], per_doc: float = 10) -> pd.DataFrame:
    """Разбивает месячные продажи на накладные по ~per_doc шт (2025–2026, как у партнёра)."""
    rows, doc = [], 1
    for code, s in series.items():
        for p, q in zip(MONTHS, s):
            if p.year < 2025 or q <= 0:
                continue
            k = max(1, int(q // per_doc))
            for j in range(k):
                rows.append({"doc": str(doc), "code": code, "qty": q / k,
                             "date": pd.Timestamp(p.year, p.month, 1 + j % 27)})
                doc += 1
    return pd.DataFrame(rows)


def order(sd: SupplierData, code="X", p: Params | None = None) -> dict:
    res = run_supplier(sd, AS_OF)
    s = res["skus"].loc[code]
    return recommend(res["analyses"][code], {"moq": s["moq"], "stock": s["stock_now"], "abc": "B"},
                     res["transit"].get(code, []), res["hist"], p or Params(), AS_OF)


rng = np.random.default_rng(42)
BASE = np.round(100 + rng.normal(0, 8, len(MONTHS)))


# ---------------------------------------------------------------------------------------------
# 1. Учитываются все источники данных: изменение любого меняет результат
# ---------------------------------------------------------------------------------------------
def test_1_all_sources_affect_result():
    base = order(make_supplier({"X": BASE}))["qty"]
    assert base > 0

    transit = pd.DataFrame([{"code": "X", "doc": "ПП-1", "qty": 80.0, "eta": date(2026, 10, 1)}])
    assert order(make_supplier({"X": BASE}, transit=transit))["qty"] < base, "товар в пути"

    low_stock = np.full(len(MONTHS), 200.0); low_stock[-1] = 0
    assert order(make_supplier({"X": BASE}, stock={"X": low_stock}))["qty"] > base, "остатки"

    assert order(make_supplier({"X": BASE}), p=Params(growth=0.2))["qty"] > base, "прогноз прироста"

    season = np.array([.6, .6, .7, .8, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.0, .8])
    assert order(make_supplier({"X": BASE}, season=season))["qty"] != base, "сезонность"

    assert order(make_supplier({"X": BASE}, moq={"X": 500}))["qty"] % 500 == 0, "кратность (MOQ)"

    res = run_supplier(make_supplier({"X": BASE}), AS_OF)
    a, tr, h = res["analyses"]["X"], [], res["hist"]
    stock = res["skus"].loc["X", "stock_now"]
    q = {c: recommend(a, {"moq": 1, "stock": stock, "abc": c}, tr, h, Params(), AS_OF)["qty"] for c in "ABC"}
    assert q["A"] > q["B"] > q["C"], "категория товара (уровень сервиса)"


# ---------------------------------------------------------------------------------------------
# 2. Сезонность и устойчивый рост
# ---------------------------------------------------------------------------------------------
def test_2_seasonality_and_trend():
    pattern = np.array([.5, .5, .7, 1, 1.2, 1.4, 1.6, 1.6, 1.3, 1, .7, .5])
    series = np.array([200 * pattern[p.month - 1] for p in MONTHS])
    sd = make_supplier({"X": series}, season=pattern)
    res = run_supplier(sd, AS_OF)
    a = res["analyses"]["X"]
    # прогноз на лето выше, чем на зиму, — а не одно среднее значение
    assert a.S[6] / a.S[0] > 2.5
    p = Params()
    est = a.variants[(True, True, True)]
    anchor = MONTHS[-2].year * 12 + MONTHS[-2].month - 1 - 2.5
    path = forecast_path(est, a.S, anchor, date(2026, 12, 1), 12, p)
    by_month = {m % 12 + 1: q for m, _, q in path}
    assert by_month[7] > 2.5 * by_month[1], "июльский прогноз должен быть заметно выше январского"

    # устойчивый рост: +30 % за год повышает заказ
    growth = np.array([100 * (1.3 ** (i / 12)) for i in range(len(MONTHS))])
    flat = np.full(len(MONTHS), growth[-7:-1].mean())
    g_res = order(make_supplier({"X": growth}))
    f_res = order(make_supplier({"X": flat}))
    assert g_res["growth"] > 0.2
    assert g_res["qty"] > f_res["qty"]


# ---------------------------------------------------------------------------------------------
# 3. Упущенный спрос в периоды stockout
# ---------------------------------------------------------------------------------------------
def test_3_stockout_restores_demand():
    sales = BASE.copy()
    stock = np.full(len(MONTHS), 200.0)
    # последние месяцы товара не было: продажи упали почти до нуля
    for i in (-5, -4, -3):
        sales[i] = 5
        stock[i] = 0
    stock[-2] = 0
    sd = make_supplier({"X": sales}, stock={"X": stock})
    restored = order(sd)
    raw = order(sd, p=Params(use_restore=False))
    assert restored["level"] > raw["level"] * 1.3
    assert restored["qty"] > raw["qty"]


# ---------------------------------------------------------------------------------------------
# 4. Разовые крупные заказы не раздувают регулярную потребность
# ---------------------------------------------------------------------------------------------
def test_4_one_off_order_is_excluded():
    sales = BASE.copy()
    lines = regular_lines({"X": sales})
    base_qty = order(make_supplier({"X": sales}, lines=lines))["qty"]

    big = 3000.0   # один клиент купил 30 месячных объёмов одной накладной
    sales2 = sales.copy(); sales2[-3] += big
    lines2 = pd.concat([lines, pd.DataFrame([{"doc": "BIG-1", "code": "X", "qty": big,
                                               "date": pd.Timestamp(2026, 7, 15)}])])
    sd = make_supplier({"X": sales2}, lines=lines2)
    res = run_supplier(sd, AS_OF)
    assert "BIG-1" in set(res["oneoffs"]["doc"]), "крупный заказ должен быть найден"
    with_filter = order(sd)["qty"]
    without_filter = order(sd, p=Params(use_oneoff=False))["qty"]
    assert abs(with_filter - base_qty) <= 0.1 * base_qty, "рекомендация почти не изменилась"
    assert without_filter > 2 * base_qty, "без фильтра заказ был бы раздут"


def test_4b_recurring_wholesale_is_regular():
    """Если крупный клиент покупает каждый месяц — это регулярный спрос, а не разовый заказ."""
    sales = BASE.copy()
    lines = regular_lines({"X": sales})
    extra = []
    for p in MONTHS[12:-1]:
        extra.append({"doc": f"W-{p}", "code": "X", "qty": 2000.0, "date": pd.Timestamp(p.year, p.month, 10)})
    lines = pd.concat([lines, pd.DataFrame(extra)])
    sales2 = sales.copy(); sales2[12:-1] += 2000
    res = run_supplier(make_supplier({"X": sales2}, lines=lines), AS_OF)
    assert res["oneoffs"].empty


# ---------------------------------------------------------------------------------------------
# 5. Список сгруппирован по поставщикам, у каждой строки есть обоснование
# ---------------------------------------------------------------------------------------------
def test_5_grouped_by_supplier_with_explanation():
    frames = []
    for key in ("A", "B"):
        sd = make_supplier({"X": BASE, "Y": BASE * 2}, key=key)
        frames.append(build_orders(run_supplier(sd, AS_OF), Params()))
    out = pd.concat(frames)
    assert set(out["Поставщик"]) == {"Поставщик A", "Поставщик B"}
    assert out["Обоснование"].str.len().min() > 50
    assert out["Обоснование"].str.contains("остаток").all()
    assert {"Код 1С", "Рекомендуемый заказ", "Срочность"} <= set(out.columns)


def test_6_order_by_date():
    """Календарь остатка: дата «заказать до» = падение ниже страхового запаса − срок поставки."""
    stock = np.full(len(MONTHS), 200.0); stock[-1] = 400 + BASE[-1]   # сегодня ≈ 400 шт при спросе ~100/мес
    sd = make_supplier({"X": BASE}, stock={"X": stock})
    res = run_supplier(sd, AS_OF)
    a, h = res["analyses"]["X"], res["hist"]
    sku = {"moq": 1, "stock": res["skus"].loc["X", "stock_now"], "abc": "B"}
    p = Params()
    r = recommend(a, sku, [], h, p, AS_OF)
    proj = stock_projection(a, r, [], h, p)
    assert 90 <= proj["stockout_day"] <= 150, "400 шт при ~100 шт/мес хватит примерно на 4 месяца"
    assert proj["order_by_day"] < proj["stockout_day"] - 45, "заказать нужно раньше, чем за срок поставки"

    # приход товара в пути отодвигает и дефицит, и дату заказа
    tr = [{"qty": 200.0, "eta": date(2026, 10, 15), "doc": "ПП-1"}]
    r2 = recommend(a, sku, tr, h, p, AS_OF)
    proj2 = stock_projection(a, r2, tr, h, p)
    assert proj2["stockout_day"] > proj["stockout_day"]
    assert proj2["order_by_day"] > proj["order_by_day"]

    # без заказа при нулевом остатке — дефицит, дата заказа «вчера»
    zero = np.full(len(MONTHS), 200.0); zero[-1] = 0
    sd0 = make_supplier({"X": BASE}, stock={"X": zero})
    res0 = run_supplier(sd0, AS_OF)
    r0 = recommend(res0["analyses"]["X"], {"moq": 1, "stock": 0, "abc": "B"}, [], res0["hist"], p, AS_OF)
    proj0 = stock_projection(res0["analyses"]["X"], r0, [], res0["hist"], p)
    assert proj0["stockout_day"] == 0 and proj0["order_by_day"] < 0 and proj0["deficit"] > 400


def test_no_auto_send():
    """Сервис не отправляет заказ поставщику: в движке нет ни почты, ни HTTP."""
    import engine.forecast as f, engine.build as b
    src = open(f.__file__, encoding="utf-8").read() + open(b.__file__, encoding="utf-8").read()
    for bad in ("smtplib", "requests", "urllib", "http.client"):
        assert bad not in src
