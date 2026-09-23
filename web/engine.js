/* Расчёт заказа в браузере — точная копия engine/forecast.py::plan (проверяется tests/test_parity.py).
 * Шаги 1–5 (разовые заказы, stockout, сезонность, уровень, тренд) рассчитаны в Python и приходят
 * в data.js; здесь — мгновенный пересчёт при смене параметров и сценария, календарь остатка,
 * бюджетный режим, качество данных и подготовка строк для Excel. Без DOM — работает и в Node. */
const Engine = (() => {
  const META = (typeof window !== "undefined" ? window : globalThis).DATA.meta;
  const SC = META.scenarios;
  const [Y, M, D] = META.asOf.split("-").map(Number);
  const DAY = 86400000;
  const T0 = Date.UTC(Y, M - 1, D);
  const PROJ = META.projectionDays;
  const MIN_H = META.minHistory;

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const variantKey = (p) => `${+p.oneoff}${+p.restore}${+p.season}`;
  const dayOf = (iso) => Math.round((Date.parse(iso) - T0) / DAY);
  const dateOf = (i) => new Date(T0 + i * DAY);
  const daysInMonth = (am) => new Date(Date.UTC(Math.floor(am / 12), (am % 12) + 1, 0)).getUTCDate();
  const leadDaysOf = (sku, p) => Math.round(p.lead[sku.sup] * 30) + SC[p.scenario].lead_add_days;

  function horizon(H) {
    const out = [];
    let left = H, y = Y, m = M;
    let frac = Math.min(1 - (D - 1) / 30, left);
    while (left > 1e-9) {
      out.push([y * 12 + m - 1, frac]);
      left -= frac;
      m += 1;
      if (m > 12) { y += 1; m = 1; }
      frac = Math.min(1, left);
    }
    return out;
  }

  /** Прогноз на календарный месяц, шт/мес: сезонность, тренд, прирост, сценарий. */
  function monthlyDemand(sku, p, am) {
    const [level, growth] = sku.v[variantKey(p)];
    const g = p.trend ? growth : 0;
    const r = Math.pow(1 + g, 1 / 12) - 1;
    const s = p.season ? sku.S[am % 12] : 1;
    return level * s * Math.pow(1 + r, am - META.anchor) * (1 + p.growth) * (1 + SC[p.scenario].demand);
  }

  /** Спрос в день i: месячный прогноз / число дней месяца (месячный объём сохраняется). */
  function dailyCache(sku, p, level) {
    const byMonth = {};
    return (i) => {
      if (!(level > 0)) return 0;
      const dt = dateOf(i);
      const am = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      if (!(am in byMonth)) byMonth[am] = monthlyDemand(sku, p, am) / daysInMonth(am);
      return byMonth[am];
    };
  }

  /** Товар в пути: с датой прихода в пределах горизонта — подтверждён; без даты — не считается прибывшим. */
  function splitTransit(tr, horizonDays) {
    const byDay = {};
    let confirmed = 0, late = 0, noEta = 0;
    tr.forEach(([, qty, eta]) => {
      if (!eta) { noEta += qty; return; }
      const d = Math.max(0, dayOf(eta));
      if (d <= horizonDays) confirmed += qty; else late += qty;
      byDay[d] = (byDay[d] || 0) + qty;
    });
    return { byDay, confirmed, late, noEta };
  }

  function plan(sku, p) {
    const sc = SC[p.scenario];
    const [level, , sd] = sku.v[variantKey(p)];
    const leadDays = leadDaysOf(sku, p);
    const L = leadDays / 30;
    const H = L + p.review;
    const path = horizon(H).map(([am, f]) => ({ am, f, q: monthlyDemand(sku, p, am) * f }));
    const demandH = sum(path.map((x) => x.q));
    const demandL = sum(horizon(L).map(([am, f]) => monthlyDemand(sku, p, am) * f));
    const avgS = p.season ? sum(path.map((x) => sku.S[x.am % 12])) / path.length : 1;
    const z = sc.z[sku.abc] ?? 0.84;
    const safety = z * sd * (1 + sc.demand) * avgS * Math.sqrt(H);
    const stock = Math.max(sku.st || 0, 0);
    const tr = splitTransit(p.transit ? sku.tr : [], Math.round(H * 30));
    const need = demandH + safety - stock - tr.confirmed;
    const moq = Math.max(sku.moq || 1, 1);
    const qty = need > 0.5 ? Math.ceil(need / moq - 1e-9) * moq : 0;
    const monthly = H ? demandH / H : 0;

    const arrivalDay = p.buffer + leadDays;
    let s0 = stock, stockout = null, deficit = 0, deficitLead = 0;
    const dailyOf = dailyCache(sku, p, level);
    for (let i = 0; i <= PROJ; i++) {
      const daily = dailyOf(i);
      s0 += tr.byDay[i] || 0;
      const short = Math.max(0, daily - s0);
      deficit += short;
      if (i < arrivalDay) deficitLead += short;
      s0 = Math.max(s0 - daily, 0);
      if (stockout == null && daily > 0 && s0 <= 0) stockout = i;
    }
    const enough = level > 0 && (sku.nh ?? MIN_H) >= MIN_H;
    const safeDay = stockout == null || !enough ? null : stockout - leadDays - p.buffer;
    let status;
    if (!enough) status = "nodata";
    else if (stock <= 0) status = "now";
    else if (safeDay == null) status = "later";
    else if (safeDay < 0) status = "overdue";
    else if (safeDay === 0) status = "today";
    else if (safeDay <= 7) status = "week";
    else status = "later";

    const inPipe = stock + tr.confirmed;
    let urgency = "ok";
    if (qty > 0 && inPipe < demandL && demandL >= 1) urgency = "critical";
    else if (qty > 0 && inPipe < demandL + safety) urgency = "soon";
    else if (qty > 0) urgency = "planned";
    return {
      qty, need, demandH, demandL, safety, stock, transit: tr.confirmed, transitNoEta: tr.noEta,
      transitLate: tr.late, urgency, status, level, growth: p.trend ? sku.v[variantKey(p)][1] : 0, sd, z,
      monthly, leadDays, L, H, moq, stockoutDay: enough ? stockout : null, safeDay, arrivalDay,
      deficit, deficitLead, expectedDeficit: enough && stockout != null && stockout < arrivalDay,
      excess: Math.max(0, inPipe - (6 * monthly + safety)),
    };
  }

  /** plan() + поля для интерфейса. */
  function calc(sku, p) {
    const r = plan(sku, p);
    r.orderByDay = r.safeDay;
    r.coverDays = r.stockoutDay;
    r.lost = p.restore ? sum(sku.rst.slice(-12)) - sum(sku.cln.slice(-12)) : 0;
    r.oneoffQty = sum(sku.oo.map((o) => o[3]));
    r.seasonMult = r.level > 0 ? r.demandH / (r.level * r.H * (1 + p.growth) * (1 + SC[p.scenario].demand)) : 1;
    r.forecast = horizon(6).map(([am, f]) => ({ am, f, q: monthlyDemand(sku, p, am) * f }));
    return r;
  }

  /** Календарь остатка для графика: без заказа (s0) и с заказом orderQty, размещённым сегодня (s1). */
  function projection(sku, p, orderQty, r = plan(sku, p)) {
    const tr = splitTransit(p.transit ? sku.tr : [], Math.round(r.H * 30));
    const arrivals = (p.transit ? sku.tr : []).filter((t) => t[2]).map((t) => ({ day: Math.max(0, dayOf(t[2])), qty: t[1], doc: t[0] }));
    let s0 = r.stock, s1 = r.stock, out1 = null, below1 = null;
    const pts = [];
    const dailyOf = dailyCache(sku, p, r.level);
    for (let i = 0; i <= PROJ; i++) {
      const daily = dailyOf(i);
      s0 += tr.byDay[i] || 0; s1 += tr.byDay[i] || 0;
      if (i === r.arrivalDay) s1 += orderQty;
      s0 = Math.max(s0 - daily, 0);
      s1 = Math.max(s1 - daily, 0);
      if (daily > 0 && i >= r.arrivalDay) {
        if (out1 == null && s1 <= 0) out1 = i;
        if (below1 == null && s1 < Math.max(r.safety, daily)) below1 = i;
      }
      pts.push([i, s0, s1, daily]);
    }
    return {
      pts, arrivals, leadDays: r.leadDays, arrivalDay: r.arrivalDay, stockoutDay: r.stockoutDay,
      safeDay: r.safeDay, stockoutWithOrder: out1, deficit: r.deficit, deficitLead: r.deficitLead,
      nextOrderByDay: below1 == null ? null : below1 - r.leadDays - p.buffer,
    };
  }

  /** Вклад фактора: насколько изменится заказ, если фактор выключить. */
  function sensitivity(sku, p) {
    const base = plan(sku, p).qty;
    const flip = (k) => plan(sku, { ...p, [k]: !p[k] }).qty - base;
    return { oneoff: flip("oneoff"), restore: flip("restore"), season: flip("season"), trend: flip("trend"), transit: flip("transit") };
  }

  // ---------------- даты и тексты ----------------
  const MON_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const fmtDay = (i) => { if (i == null) return "Нет данных"; const d = dateOf(i); return `${d.getUTCDate()} ${MON_GEN[d.getUTCMonth()]}`; };
  const isoDay = (i) => (i == null ? "" : dateOf(i).toISOString().slice(0, 10).split("-").reverse().join("."));
  const f0 = (x) => Math.round(x).toLocaleString("ru-RU");

  function explain(sku, r, p) {
    if (r.status === "nodata") return `Недостаточно истории продаж для прогноза (меньше ${MIN_H} мес. или нулевой спрос).`;
    let t = `При спросе ${f0(r.monthly)} шт./мес. и остатке ${f0(r.stock)} шт.`;
    if (r.transit) t += ` (+${f0(r.transit)} в пути)`;
    t += r.stockoutDay != null ? ` товар закончится примерно ${fmtDay(r.stockoutDay)}.` : ` запаса хватит больше чем на ${Math.round(PROJ / 30)} мес.`;
    if (r.safeDay != null) {
      t += ` Поставка ${r.leadDays} дн. + ${p.buffer} дн. на согласование`;
      t += r.safeDay < 0
        ? `: последний безопасный день был ${fmtDay(r.safeDay)} (${-r.safeDay} дн. назад) — заказывать нужно немедленно.`
        : `: заказ нужно разместить не позднее ${fmtDay(r.safeDay)}.`;
    }
    t += r.qty > 0
      ? ` Рекомендуется ${f0(r.qty)} шт.: прогноз ${f0(r.demandH)} + страховой ${f0(r.safety)} − остаток ${f0(r.stock)} − в пути ${f0(r.transit)} = ${f0(r.need)}, округлено до кратности ${f0(r.moq)}.`
      : " Заказ сейчас не нужен.";
    if (r.transitNoEta) t += ` В пути без даты прихода ${f0(r.transitNoEta)} шт. — в расчёте не учтены, уточните ETA.`;
    return t;
  }

  // ---------------- статусы ----------------
  const STATUS = {
    now: { label: "Дефицит сейчас", rank: 0, tone: "crit" },
    overdue: { label: "Просрочено", rank: 1, tone: "crit" },
    today: { label: "Сегодня", rank: 2, tone: "warn" },
    week: { label: "На этой неделе", rank: 3, tone: "warn" },
    later: { label: "Позже", rank: 4, tone: "good" },
    nodata: { label: "Недостаточно данных", rank: 5, tone: "none" },
  };
  const ABC_RANK = { A: 0, B: 1, C: 2 };

  /** Порядок действий: просрочено → ранний stockout → категория A → больший дефицит до прихода. */
  function actionCompare(a, b) {
    const ra = STATUS[a.r.status].rank <= 1 ? 0 : 1, rb = STATUS[b.r.status].rank <= 1 ? 0 : 1;
    return ra - rb
      || (a.r.stockoutDay ?? 1e6) - (b.r.stockoutDay ?? 1e6)
      || ABC_RANK[a.s.abc] - ABC_RANK[b.s.abc]
      || b.r.deficitLead - a.r.deficitLead
      || (a.s.id < b.s.id ? -1 : 1);
  }

  // ---------------- деньги: только известные цены ----------------
  const hasPrice = (s) => typeof s.pr === "number" && isFinite(s.pr) && s.pr > 0;
  /** Стоимость и покрытие ценами по строкам к заказу. Нет цены ≠ 0 ₸. */
  function priceCoverage(rows) {
    const lines = rows.filter((x) => x.final > 0);
    const priced = lines.filter((x) => hasPrice(x.s));
    return {
      lines: lines.length, priced: priced.length, missing: lines.length - priced.length,
      share: lines.length ? priced.length / lines.length : null,
      value: sum(priced.map((x) => x.final * x.s.pr)),
    };
  }

  /** Приоритизация заказа при ограниченном бюджете. Позиции без цены не оптимизируются
   *  и не считаются бесплатными — они возвращаются отдельно, критичные остаются в предупреждениях. */
  function allocateBudget(rows, budget) {
    if (!(budget > 0)) return null;
    const res = { mark: {}, spent: 0, included: [], skipped: [], noPrice: [], criticalNoPrice: [] };
    const lines = rows.filter((x) => x.final > 0).slice().sort(actionCompare);
    lines.forEach((x) => {
      if (!hasPrice(x.s)) {
        res.mark[x.s.id] = "noprice"; res.noPrice.push(x);
        if (x.r.urgency === "critical" || STATUS[x.r.status].rank <= 1) res.criticalNoPrice.push(x);
        return;
      }
      const cost = x.final * x.s.pr;
      if (res.spent + cost <= budget + 1e-6) { res.spent += cost; res.mark[x.s.id] = "in"; res.included.push(x); }
      else { res.mark[x.s.id] = "out"; res.skipped.push(x); }
    });
    return res;
  }

  // ---------------- качество данных ----------------
  function dataQuality(rows) {
    const n = rows.length;
    const pct = (k) => (n ? k / n : null);
    const trAll = rows.flatMap((x) => x.s.tr);
    const trQty = sum(trAll.map((t) => t[1]));
    const trEta = sum(trAll.filter((t) => t[2]).map((t) => t[1]));
    const badCode = (id) => !/^[0-9A-Za-z]+_?$/.test(id);
    return {
      n,
      priceShare: pct(rows.filter((x) => hasPrice(x.s)).length),
      moqShare: pct(rows.filter((x) => x.s.mq).length),
      etaShare: trQty ? trEta / trQty : null, transitNoEta: trQty - trEta,
      returns: rows.filter((x) => x.s.rt > 0).length,
      noHistory: rows.filter((x) => x.r.status === "nodata").length,
      zeroStock: rows.filter((x) => x.r.stock <= 0).length,
      badCodes: rows.filter((x) => badCode(x.s.id)).map((x) => x.s.id),
    };
  }

  // ---------------- строки для Excel ----------------
  const clean = (v) => (v == null || (typeof v === "number" && !isFinite(v)) ? "" : v);
  const round1 = (x) => Math.round(x * 10) / 10;
  function exportRows(rows, p, ctx) {
    return rows.map(({ s, r, final }) => {
      const priced = hasPrice(s);
      const o = {
        "Поставщик": ctx.supName(s.sup), "Код 1С": String(s.id), "Артикул": s.art == null ? "" : String(s.art),
        "Наименование": s.n, "ABC": s.abc, "Остаток": r.stock, "В пути (с датой)": r.transit,
        "В пути без даты": r.transitNoEta || "", "Прогноз спроса, шт/мес": round1(r.monthly),
        "Закончится": r.stockoutDay == null ? (r.status === "nodata" ? "Нет данных" : `> ${Math.round(PROJ / 30)} мес`) : isoDay(r.stockoutDay),
        "Заказать до": r.safeDay == null ? "Нет данных" : isoDay(Math.max(r.safeDay, 0)),
        "Статус": STATUS[r.status].label, "Срочность": ctx.urgLabel(r.urgency),
        "Рекомендуемое кол-во": r.qty, "Кол-во менеджера": final, "Кратность (MOQ)": r.moq,
        "Цена (себест.)": priced ? s.pr : "Нет данных", "Стоимость строки": priced ? Math.round(final * s.pr * 100) / 100 : "Нет данных",
        "Сценарий": SC[p.scenario].label, "Обоснование": explain(s, r, p), "Статус заказа": ctx.approval(s.sup),
      };
      Object.keys(o).forEach((k) => (o[k] = clean(o[k])));
      return o;
    });
  }

  return {
    plan, calc, projection, sensitivity, explain, horizon, dateOf, dayOf, fmtDay, isoDay, T0,
    STATUS, actionCompare, priceCoverage, allocateBudget, dataQuality, exportRows, hasPrice, SC,
  };
})();
if (typeof module !== "undefined") module.exports = Engine;
