"""Календарь остатка, последний безопасный день заказа, операционный статус и сценарии."""
from datetime import date

import pytest

from engine.forecast import Params, days_in_month, monthly_demand, plan

AS_OF = date(2026, 9, 22)
ANCHOR = 2026 * 12 + 7 - 2.5
FLAT = [1.0] * 12


def sku(level=120.0, st=140.0, tr=(), moq=1, abc="A", nh=24, season=FLAT, sd=0.0, growth=0.0):
    v = {f"{a}{b}{c}": [level, growth, sd] for a in (0, 1) for b in (0, 1) for c in (0, 1)}
    return {"v": v, "S": list(season), "st": st, "moq": moq, "abc": abc, "nh": nh, "tr": [list(t) for t in tr]}


def run(s, **kw):
    return plan(s, Params(**kw), ANCHOR, AS_OF)


def test_1_safe_day_for_stable_demand():
    # 120 шт/мес ≈ 4 шт/день, 140 шт хватит примерно на 35 дней
    r = run(sku())
    assert 33 <= r["stockout_day"] <= 37
    assert r["safe_day"] == r["stockout_day"] - 45 - 3          # срок поставки 45 дн + 3 дн согласования
    assert r["status"] == "overdue"                             # заказывать надо было раньше
    r2 = run(sku(st=500))                                        # ≈ 125 дней запаса
    assert r2["safe_day"] == r2["stockout_day"] - 48 and r2["status"] == "later"


def test_2_stockout_already_happened():
    r = run(sku(st=0))
    assert r["status"] == "now" and r["stockout_day"] == 0
    assert r["expected_deficit"] and r["deficit_lead"] > 0


def test_3_zero_demand_is_no_data():
    r = run(sku(level=0))
    assert r["status"] == "nodata" and r["stockout_day"] is None and r["safe_day"] is None
    assert run(sku(level=5, nh=2))["status"] == "nodata"      # истории меньше 3 месяцев


def test_4_arrival_before_stockout_moves_it():
    base = run(sku(st=60))
    later = run(sku(st=60, tr=[("ПП-1", 300, "2026-10-01")]))
    assert later["stockout_day"] > base["stockout_day"] + 60
    assert later["safe_day"] > base["safe_day"]


def test_5_arrival_after_stockout_does_not_mask_deficit():
    base = run(sku(st=60))
    late = run(sku(st=60, tr=[("ПП-2", 300, "2026-12-20")]))
    assert late["stockout_day"] == base["stockout_day"]        # дефицит начинается в тот же день
    assert late["deficit"] > 0


def test_6_transit_without_eta_is_not_counted():
    base = run(sku(st=60))
    r = run(sku(st=60, tr=[("СЭ", 300, None)]))
    assert r["transit"] == 0 and r["transit_no_eta"] == 300
    assert r["stockout_day"] == base["stockout_day"] and r["qty"] == base["qty"]


def test_7_moq_rounds_up():
    r = run(sku(moq=50))
    assert r["qty"] % 50 == 0 and r["qty"] >= r["need"] and r["qty"] - r["need"] < 50
    assert run(sku(st=1000))["stockout_day"] is None and run(sku(st=1000))["status"] == "later"  # > 6 мес


@pytest.mark.parametrize("st", [0, 140, 400, 2000])
def test_8_9_scenarios_are_ordered(st):
    s = sku(st=st, sd=30)
    econ, base, prot = (run(s, scenario=k)["qty"] for k in ("econ", "base", "protect"))
    assert prot >= base, "защитный сценарий не даёт меньший заказ"
    assert econ <= prot, "экономный не даёт больший заказ, чем защитный"
    assert econ <= base


def test_13_month_boundary_keeps_seasonal_volume():
    season = [0.5, 0.5, 0.7, 1.0, 1.2, 1.4, 1.6, 1.6, 1.3, 1.0, 0.7, 0.5]
    s = sku(season=season)
    p = Params()
    for am in (2026 * 12 + 9, 2026 * 12 + 10, 2027 * 12 + 1):   # октябрь, ноябрь, февраль
        month = monthly_demand(s, p, ANCHOR, am)
        daily_sum = sum(month / days_in_month(am) for _ in range(days_in_month(am)))
        assert abs(daily_sum - month) < 1e-9
    assert days_in_month(2027 * 12 + 1) == 28 and days_in_month(2026 * 12 + 9) == 31


def test_backtest_has_no_future_leakage():
    """Изменение продаж после даты отсечения не меняет прогноз, только факт."""
    import pandas as pd
    from engine.backtest import forecast_at, metrics
    from tests.test_requirements import BASE, MONTHS, make_supplier

    cut = pd.Period("2026-03", "M")
    sd = make_supplier({"X": BASE.copy()})
    f1 = forecast_at(sd, cut, 3).set_index("code").loc["X"]
    boosted = BASE.copy()
    boosted[MONTHS.index(cut):] *= 10                     # будущие продажи ×10
    sd2 = make_supplier({"X": boosted}, lines=None)
    sd2.lines = pd.concat([sd.lines, pd.DataFrame([{"doc": "F", "code": "X", "qty": 5000.0, "date": pd.Timestamp(2026, 4, 1)}])])
    f2 = forecast_at(sd2, cut, 3).set_index("code").loc["X"]
    assert f2["forecast"] == f1["forecast"]
    assert f2["fact"] > f1["fact"] * 5
    m = metrics(pd.DataFrame([{"forecast": 100, "fact": 80, "naive": 0}, {"forecast": 50, "fact": 70, "naive": 0}]))
    assert m["wape"] == round(40 / 150, 3) and m["bias"] == 0.0


def test_stockout_does_not_make_normal_month_a_spike():
    """Месяцы без товара не входят в «норму» фильтра выбросов: обычные продажи после дефицита
    не срезаются, а восстановленный спрос не ниже очищенного и не ниже факта в месяцах с товаром."""
    import numpy as np
    import pandas as pd
    from engine.forecast import analyze_sku

    months = list(pd.period_range("2024-01", "2026-08", freq="M"))
    raw = np.full(32, 100.0)
    stock = np.full(33, 500.0)
    raw[26:29] = 0
    stock[26:30] = 0                                   # три месяца без товара
    a = analyze_sku("X", raw.copy(), stock, np.zeros(32), months, np.ones(12))
    assert not a.capped.any(), "обычные месяцы после дефицита не должны считаться всплеском"
    assert (a.restored >= a.clean - 1e-9).all()
    ok = a.avail >= 1
    assert np.allclose(a.clean[ok], raw[ok])
    assert a.variants[(True, True, True)]["level"] > 90
