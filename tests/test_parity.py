"""Согласованность расчёта Python (engine/forecast.py::plan) и браузера (web/engine.js),
а также проверки функций интерфейса: покрытие ценами, бюджет, экспорт.

Требует Node.js; без него тесты пропускаются.
"""
import json
import math
import shutil
import subprocess
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

from engine.forecast import APPROVAL_BUFFER_DAYS, MIN_HISTORY_MONTHS, PROJECTION_DAYS, SCENARIOS, Params, plan

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="нужен Node.js")

META = {"asOf": "2026-09-22", "anchor": 2026 * 12 + 7 - 2.5, "scenarios": SCENARIOS, "buffer": APPROVAL_BUFFER_DAYS,
        "projectionDays": PROJECTION_DAYS, "minHistory": MIN_HISTORY_MONTHS, "z": SCENARIOS["base"]["z"]}
AS_OF = date(2026, 9, 22)
SEASON = [0.8, 0.8, 0.8, 0.9, 0.9, 1.1, 1.2, 1.2, 1.0, 1.2, 1.0, 1.0]


def js_params(p: Params, lead: float) -> dict:
    return {"lead": {"X": lead}, "review": p.review, "growth": p.growth, "oneoff": p.use_oneoff,
            "restore": p.use_restore, "season": p.use_season, "trend": p.use_trend, "transit": p.use_transit,
            "scenario": p.scenario, "buffer": p.approval_buffer}


def sku(level=120.0, growth=0.1, sd=30.0, st=140.0, tr=(), moq=1, abc="A", nh=24):
    v = {f"{a}{b}{c}": [level, growth, sd] for a in (0, 1) for b in (0, 1) for c in (0, 1)}
    return {"v": v, "S": SEASON, "st": st, "moq": moq, "abc": abc, "nh": nh, "tr": [list(t) for t in tr], "sup": "X"}


CASES = [
    sku(),
    sku(st=0),
    sku(level=0),
    sku(level=5, nh=2),
    sku(st=1000, moq=50),
    sku(st=60, tr=[("ПП-1", 300, "2026-10-01")]),
    sku(st=60, tr=[("ПП-2", 300, "2026-12-20")]),
    sku(st=60, tr=[("СЭ", 300, None)]),
    sku(level=3000, sd=900, st=5000, moq=12, abc="C", growth=-0.3),
]
PARAMS = [Params(), Params(scenario="protect"), Params(scenario="econ"),
          Params(use_season=False, use_trend=False), Params(lead_time=3, review=0.5, growth=0.2),
          Params(use_transit=False, approval_buffer=0)]


def run_node(payload: dict) -> dict:
    res = subprocess.run([NODE, str(ROOT / "tests/js/run_engine.js")], input=json.dumps(payload),
                         capture_output=True, text=True, check=True)
    return json.loads(res.stdout)


def test_python_and_js_give_same_plan():
    cases, expected = [], []
    for s in CASES:
        for p in PARAMS:
            cases.append({"sku": s, "p": js_params(p, p.lead_time)})
            expected.append(plan(s, replace(p), META["anchor"], AS_OF))
    got = run_node({"meta": META, "cases": cases})["out"]
    for e, g, c in zip(expected, got, cases):
        where = f"{c['p']['scenario']} st={c['sku']['st']} tr={c['sku']['tr']}"
        assert g["qty"] == e["qty"], where
        assert g["stockout"] == e["stockout_day"], where
        assert g["safe"] == e["safe_day"], where
        assert g["status"] == e["status"], where
        assert g["urgency"] == e["urgency"], where
        assert math.isclose(g["need"], e["need"], rel_tol=1e-9, abs_tol=1e-6), where
        assert math.isclose(g["deficit"], e["deficit"], rel_tol=1e-9, abs_tol=1e-6), where


@pytest.fixture(scope="module")
def unit():
    p = js_params(Params(), 1.5)
    return run_node({"meta": META, "cases": [], "unit": {"p": p}})["extra"]


def test_11_price_coverage(unit):
    cov = unit["coverage"]
    assert cov["lines"] == 4 and cov["priced"] == 2 and cov["missing"] == 2
    assert cov["share"] == 0.5
    assert cov["value"] == 100 * 10 + 200 * 20          # только известные цены


def test_10_missing_price_is_not_zero(unit):
    rows = {r["Код 1С"]: r for r in unit["exportRows"]}
    assert rows["0005678_"]["Цена (себест.)"] == "Нет данных"
    assert rows["0009999_"]["Стоимость строки"] == "Нет данных"   # цена 0 — это «нет цены»


def test_12_budget_keeps_critical_without_price(unit):
    b = unit["budget"]
    assert b["mark"]["0001234_"] == "in"          # 1 000 ₸ помещается в 1 500 ₸
    assert b["mark"]["0000042_"] == "out"         # 4 000 ₸ не помещается
    assert b["mark"]["0005678_"] == "noprice"
    assert set(b["criticalNoPrice"]) == {"0005678_", "0009999_"}
    assert b["spent"] == 1000
    assert unit["noBudget"] is None               # бюджет не задан — ничего не оптимизируем


def test_14_export_codes_are_text(unit):
    for r in unit["exportRows"]:
        assert isinstance(r["Код 1С"], str) and r["Код 1С"].startswith("000")
        assert isinstance(r["Артикул"], str) and r["Артикул"] == "0012"


def test_15_export_has_no_invalid_values(unit):
    for r in unit["exportRows"]:
        for k, v in r.items():
            assert v is not None, k
            assert not (isinstance(v, str) and v.lower() in ("nan", "infinity", "undefined", "null")), k
            assert not (isinstance(v, float) and not math.isfinite(v)), k
