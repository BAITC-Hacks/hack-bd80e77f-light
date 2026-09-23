"""Охват каталога и причины исключения SKU (engine/coverage.py)."""
import json
from datetime import date

import numpy as np

from engine.build import export_sku
from engine.coverage import coverage_stats
from engine.forecast import run_supplier
from tests.test_requirements import BASE, MONTHS, make_supplier

AS_OF = date(2026, 9, 22)


def build(series, stock):
    res = run_supplier(make_supplier(series, stock=stock), AS_OF)
    published = {c for c in res["analyses"] if export_sku(c, res)}
    return res, published


def test_reasons_and_funnel():
    zeros = np.zeros(len(MONTHS))
    only2024 = np.array([100.0 if p.year == 2024 else 0.0 for p in MONTHS])
    res, published = build(
        {"KEEP_1": BASE, "EMPTY_2": zeros, "OLD_3": only2024},
        {"KEEP_1": np.full(len(MONTHS), 200.0), "EMPTY_2": zeros, "OLD_3": zeros},
    )
    cov = coverage_stats([res], published, recommended=1)
    reasons = {r["code"]: r["count"] for r in cov["reasons"]}
    assert published == {"KEEP_1"}
    assert reasons == {"no_data": 1, "inactive": 1, "other": 0}
    assert cov["catalog"] == cov["published"] + cov["excluded"] == 3
    assert sum(reasons.values()) == cov["excluded"]
    assert cov["withData"] == 2 and cov["forecastable"] == 1 and cov["recommended"] == 1
    assert cov["bySupplier"]["T"] == {"catalog": 3, "published": 1, "excluded": 2}


def test_no_product_codes_in_output():
    res, published = build({"SECRET_A1": BASE, "SECRET_B2": np.zeros(len(MONTHS))},
                           {"SECRET_A1": np.full(len(MONTHS), 200.0), "SECRET_B2": np.zeros(len(MONTHS))})
    text = json.dumps(coverage_stats([res], published), ensure_ascii=False)
    assert "SECRET" not in text and "Товар" not in text
