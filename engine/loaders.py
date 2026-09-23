"""Загрузка и нормализация выгрузок 1С партнёра (IEK, Systeme Electric).

Все файлы приводятся к единому виду:
  * skus      — справочник артикулов (код 1С, наименование, артикул поставщика, MOQ, цена, остаток)
  * sales     — матрица «артикул × месяц» продаж в штуках
  * stock     — матрица «артикул × месяц» остатков на начало месяца
  * lines     — строки расходных накладных (документ, артикул, количество) для поиска разовых заказов
  * transit   — товар в пути (документ, количество, ожидаемая дата поступления)
  * season    — сезонные коэффициенты поставщика из файла «Сезонность»
"""
from __future__ import annotations

import re
import warnings
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")

ROOT = Path(__file__).resolve().parent.parent
AS_OF = date(2026, 9, 22)  # дата выгрузки данных партнёра

RU_MONTHS = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "май": 5, "мая": 5, "июн": 6,
             "июл": 7, "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}


@dataclass
class SupplierData:
    key: str
    name: str
    lead_time: float                 # срок поставки, мес.
    months: list[pd.Period]
    skus: pd.DataFrame
    sales: pd.DataFrame              # index=code, columns=months
    stock: pd.DataFrame              # index=code, columns=months (остаток на начало месяца)
    lines: pd.DataFrame              # date, doc, code, qty
    transit: pd.DataFrame            # code, doc, qty, eta
    season: np.ndarray               # 12 коэффициентов, среднее = 1
    extra: dict = field(default_factory=dict)


def _month_from_header(h) -> pd.Period | None:
    """'янв. 2024' / 'Январь 2024 г.' -> Period('2024-01')."""
    if not isinstance(h, str):
        return None
    m = re.match(r"\s*([А-Яа-яё]+)\.?\s+(\d{4})", h)
    if not m:
        return None
    mon = RU_MONTHS.get(m.group(1).lower()[:3])
    return pd.Period(year=int(m.group(2)), month=mon, freq="M") if mon else None


def _clean_code(x) -> str | None:
    if x is None or (isinstance(x, float) and np.isnan(x)):
        return None
    s = str(x).strip()
    return s or None


def _read_matrix(path: Path, code_col: str, first_data_row: int) -> tuple[pd.DataFrame, pd.Series]:
    """Читает отчёт 1С «Номенклатура × месяцы» в матрицу code × Period."""
    raw = pd.read_excel(path, header=None)
    header = list(raw.iloc[0])
    body = raw.iloc[first_data_row:].copy()
    body.columns = header
    body["code"] = body[code_col].map(_clean_code)
    body = body[body["code"].notna()]
    month_cols = {c: _month_from_header(c) for c in header}
    month_cols = {c: p for c, p in month_cols.items() if p is not None}
    mat = body.set_index("code")[list(month_cols)].rename(columns=month_cols)
    mat = mat.apply(pd.to_numeric, errors="coerce")
    mat = mat.groupby(level=0).sum(min_count=1)
    names = body.drop_duplicates("code").set_index("code")["Номенклатура"].astype(str).str.strip()
    return mat, names


def _read_lines(path: Path) -> pd.DataFrame:
    d = pd.read_excel(path)
    d = d[d["Дата"].astype(str) != "Итого"].copy()
    d = d[d["Документ"].astype(str).str.startswith("Расходная накладная")]
    d["date"] = pd.to_datetime(d["Дата"], dayfirst=True, format="mixed")
    d["code"] = d["Код"].map(_clean_code)
    d["Номер"] = d["Номер"].map(lambda x: str(int(x)) if isinstance(x, float) else str(x).strip())
    d["qty"] = pd.to_numeric(d["Количество"], errors="coerce").fillna(0)
    # одна накладная может содержать артикул несколькими строками → суммируем
    out = (d.groupby(["Номер", "code"], as_index=False)
             .agg(date=("date", "min"), qty=("qty", "sum"))
             .rename(columns={"Номер": "doc"}))
    return out[out["qty"] > 0]


def _read_season(path: Path, sheet=0) -> np.ndarray:
    """Коэффициенты сезонности поставщика из файла партнёра (по выручке)."""
    raw = pd.read_excel(path, header=None, sheet_name=sheet)
    # 1) итоговый коэффициент, который партнёр уже рассчитал («Норм. коэф.» / «СЕЗОННОСТЬ»)
    for label in ("Норм. коэф.", "СЕЗОННОСТЬ"):
        hits = np.argwhere(np.char.strip(raw.to_numpy().astype(str)) == label)
        if len(hits):
            r, c = hits[-1]
            v = pd.to_numeric(raw.iloc[r + 1:r + 13, c], errors="coerce").to_numpy(dtype=float)
            if len(v) == 12 and np.isfinite(v).all():
                return v / v.mean()
    # 2) запасной вариант: строки с годами (2024, 2025, …) и помесячной выручкой
    rows = raw[pd.to_numeric(raw[0], errors="coerce").between(2020, 2100)]
    years = []
    for _, r in rows.iterrows():
        v = pd.to_numeric(r.iloc[1:13], errors="coerce").to_numpy(dtype=float)
        if np.isfinite(v).all() and (v > 0).all():   # только полные годы
            years.append(v / v.mean())
    s = np.mean(years, axis=0)
    return s / s.mean()


def _period_range(cols) -> list[pd.Period]:
    return sorted(cols)


def _moq_map(path: Path, code_col: str, moq_col: str, header=0) -> pd.Series:
    m = pd.read_excel(path, header=header)
    m["code"] = m[code_col].map(_clean_code)
    m = m[m["code"].notna()]
    s = pd.to_numeric(m[moq_col], errors="coerce").fillna(1).clip(lower=1)
    return pd.Series(s.values, index=m["code"]).groupby(level=0).max()


def load_iek() -> SupplierData:
    base = ROOT / "IEK"
    sales, names = _read_matrix(base / "Ежемесячные продажи в количественном выражении за последние 2 года.xlsx",
                                "Номенклатура.Код", 2)
    stock, names2 = _read_matrix(base / "Ежемесячные остатки продукции за последние 2 года  ИЭК.xlsx",
                                 "Номенклатура.Код", 3)
    lines = _read_lines(base / "Динамика продаж_2025-2026.xlsx")
    moq = _moq_map(base / "MOQ  ИЭК.xlsx", "Код 1с", "Мин. разр. к отгр.")

    tr = pd.read_excel(base / "Путь ИЭК 22.09.2026.xlsx")
    tr["code"] = tr["Код 1с"].map(_clean_code)
    arts = tr.dropna(subset=["code"]).drop_duplicates("code").set_index("code")["Артикул ИЭК"].astype(str)
    recs = []
    for col in tr.columns[3:]:
        eta = re.search(r"до (\d{2}\.\d{2}\.\d{4})", col)
        doc = re.match(r"\s*(.+?)\s+от", col)
        for code, q in zip(tr["code"], pd.to_numeric(tr[col], errors="coerce")):
            if code and q and q > 0:
                recs.append({"code": code, "doc": doc.group(1) if doc else col, "qty": float(q),
                             "eta": pd.to_datetime(eta.group(1), dayfirst=True).date() if eta else None})
    transit = pd.DataFrame(recs, columns=["code", "doc", "qty", "eta"])

    codes = sales.index.union(stock.index)
    skus = pd.DataFrame(index=codes)
    skus["name"] = names.reindex(codes).fillna(names2.reindex(codes))
    skus["article"] = arts.reindex(codes)
    skus["moq"] = moq.reindex(codes).fillna(1)
    skus["price"] = np.nan                     # в выгрузке IEK нет себестоимости
    skus["partner_cat"] = None
    months = _period_range(set(sales.columns) | set(stock.columns))
    return SupplierData("IEK", "IEK", 1.5, months, skus,
                        sales.reindex(index=codes, columns=months),
                        stock.reindex(index=codes, columns=months),
                        lines, transit, _read_season(base / "Сезонность ИЭК.xlsx"))


def load_se() -> SupplierData:
    base = ROOT / "Systeme electric"
    sales, names = _read_matrix(base / "Ежемесячные продажи в кол-м выражении SystemElectric 2024-2026.xlsx",
                                "Номенклатура.Код", 2)
    stock, names2 = _read_matrix(base / "Ежемесячные остатки SystemElectric 2024-2026.xlsx",
                                 "Номенклатура.Код", 3)
    lines = _read_lines(base / "Динамика продаж_Syseme Electric_2025-2026.xlsx")
    moq = _moq_map(base / "MOQ SystemElectric.xlsx", "Номенклатура.Код", "Кратность")

    tr = pd.read_excel(base / "Товар в пути_SystemElectric на 22.09.2026.xlsx", header=1)
    tr["code"] = tr["Код 1с"].map(_clean_code)
    tr = tr[tr["code"].notna()].drop_duplicates("code").set_index("code")
    transit_col = next(c for c in tr.columns if "в пути" in str(c))
    q = pd.to_numeric(tr[transit_col], errors="coerce").fillna(0)
    transit = pd.DataFrame({"code": q[q > 0].index, "doc": transit_col.strip(), "qty": q[q > 0].values,
                            "eta": None})
    wh_cols = ["Витрина", "Остаток ТЗ", "РЦ ЕКТ  Рыскулова", "Розничный склад"]

    codes = sales.index.union(stock.index)
    skus = pd.DataFrame(index=codes)
    skus["name"] = names.reindex(codes).fillna(names2.reindex(codes))
    skus["article"] = tr["Артикул поставщика"].astype(str).reindex(codes)
    skus["moq"] = moq.reindex(codes).fillna(1)
    skus["price"] = pd.to_numeric(tr["СС реал"], errors="coerce").reindex(codes)
    skus["partner_cat"] = tr["Категория 2026"].astype(str).reindex(codes)
    skus["stock_now"] = pd.to_numeric(tr["Свободный остаток"], errors="coerce").reindex(codes)
    months = _period_range(set(sales.columns) | set(stock.columns))
    extra = {"warehouses": tr[wh_cols].apply(pd.to_numeric, errors="coerce").fillna(0).reindex(codes)}
    return SupplierData("SE", "Systeme Electric", 1.5, months, skus,
                        sales.reindex(index=codes, columns=months),
                        stock.reindex(index=codes, columns=months),
                        lines, transit, _read_season(base / "Сезонность SystemElectric 2024-2026.xlsx"),
                        extra)


def load_all() -> list[SupplierData]:
    return [load_iek(), load_se()]
