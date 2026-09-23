/* Шаг 6 алгоритма (прогноз → заказ) в браузере — зеркало engine/forecast.py::recommend.
 * Шаги 1–5 (разовые заказы, stockout, сезонность, уровень, тренд) рассчитаны в Python
 * и приходят в data.js; здесь — только быстрый пересчёт при изменении параметров. */
const Engine = (() => {
  const META = window.DATA.meta;
  const [Y, M, D] = META.asOf.split("-").map(Number);

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

  function path(est, S, H, p) {
    const g = p.trend ? est[1] : 0;
    const r = Math.pow(1 + g, 1 / 12) - 1;
    return horizon(H).map(([am, f]) => {
      const s = p.season ? S[am % 12] : 1;
      return { am, f, q: est[0] * s * Math.pow(1 + r, am - META.anchor) * (1 + p.growth) * f };
    });
  }

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const variantKey = (p) => `${+p.oneoff}${+p.restore}${+p.season}`;

  function calcCore(sku, p) {
    const est = sku.v[variantKey(p)];
    const L = p.lead[sku.sup];
    const H = L + p.review;
    const ph = path(est, sku.S, H, p);
    const demandH = sum(ph.map((x) => x.q));
    const demandL = sum(path(est, sku.S, L, p).map((x) => x.q));
    const avgS = p.season ? sum(ph.map((x) => sku.S[x.am % 12])) / ph.length : 1;
    const z = META.z[sku.abc] ?? 0.84;
    const safety = z * est[2] * avgS * Math.sqrt(H);
    const stock = Math.max(sku.st || 0, 0);
    const transit = p.transit ? sum(sku.tr.map((t) => t[1])) : 0;
    const need = demandH + safety - stock - transit;
    const moq = Math.max(sku.moq || 1, 1);
    const qty = need > 0.5 ? Math.ceil(need / moq - 1e-9) * moq : 0;
    const monthly = H ? demandH / H : 0;
    let urgency = "ok";
    if (qty > 0 && stock + transit < demandL && demandL >= 1) urgency = "critical";
    else if (qty > 0 && stock + transit < demandL + safety) urgency = "soon";
    else if (qty > 0) urgency = "planned";
    const excess = Math.max(0, stock + transit - (6 * monthly + safety));
    const lost = p.restore ? sum(sku.rst.slice(-12)) - sum(sku.cln.slice(-12)) : 0;
    const oneoffQty = sum(sku.oo.map((o) => o[3]));
    return {
      qty, need, demandH, demandL, safety, stock, transit, urgency, monthly, excess, lost, oneoffQty,
      level: est[0], growth: p.trend ? est[1] : 0, sd: est[2], z, L, H, moq,
      seasonMult: est[0] > 0 ? demandH / (est[0] * H * (1 + p.growth)) : 1,
      coverDays: monthly > 0 ? (stock / monthly) * 30 : null,
      forecast: path(est, sku.S, 6, p),
    };
  }

  // ---------------- календарь остатка ----------------
  const DAY = 86400000;
  const T0 = Date.UTC(Y, M - 1, D);
  const dayOf = (iso) => Math.round((Date.parse(iso) - T0) / DAY);
  const dateOf = (i) => new Date(T0 + i * DAY);
  const daysIn = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

  /** Остаток по дням на `days` дней вперёд.
   *  s0 — без нового заказа, s1 — если разместить заказ `orderQty` сегодня (придёт через срок поставки).
   *  Товар в пути приходит в дату из файла поставщика; если даты нет — в середине срока поставки. */
  function projection(sku, p, orderQty, days = 180, r = calcCore(sku, p)) {
    const est = sku.v[variantKey(p)];
    const g = p.trend ? est[1] : 0;
    const rr = Math.pow(1 + g, 1 / 12) - 1;
    const leadDays = Math.round(r.L * 30);
    const arrivals = [];
    if (p.transit) sku.tr.forEach((t) => {
      const d = t[2] ? Math.max(0, dayOf(t[2])) : Math.round(leadDays / 2);
      arrivals.push({ day: d, qty: t[1], doc: t[0], eta: !!t[2] });
    });
    const inbound = {};
    arrivals.forEach((a) => (inbound[a.day] = (inbound[a.day] || 0) + a.qty));
    let s0 = r.stock, s1 = r.stock;
    let out0 = null, out1 = null, belowSS = null, belowSS1 = null, deficit0 = 0, deficit1 = 0;
    const pts = [];
    for (let i = 0; i <= days; i++) {
      const dt = dateOf(i);
      const am = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
      const s = p.season ? sku.S[am % 12] : 1;
      const daily = (est[0] * s * Math.pow(1 + rr, am - META.anchor) * (1 + p.growth)) / daysIn(dt.getUTCFullYear(), dt.getUTCMonth());
      if (inbound[i]) { s0 += inbound[i]; s1 += inbound[i]; }
      if (i === leadDays) s1 += orderQty;
      // продать можно только то, что есть; нехватка = упущенные продажи
      deficit0 += Math.max(0, daily - Math.max(s0, 0));
      deficit1 += Math.max(0, daily - Math.max(s1, 0));
      s0 = Math.max(s0 - daily, 0);
      s1 = Math.max(s1 - daily, 0);
      if (daily > 0) {
        if (out0 == null && s0 <= 0) out0 = i;
        if (out1 == null && s1 <= 0 && i >= leadDays) out1 = i;
        if (belowSS == null && s0 < Math.max(r.safety, daily)) belowSS = i;
        if (belowSS1 == null && i > leadDays && s1 < Math.max(r.safety, daily)) belowSS1 = i;
      }
      pts.push([i, s0, s1, daily]);
    }
    return {
      pts, arrivals, leadDays,
      stockoutDay: out0,              // закончится без нового заказа
      stockoutWithOrder: out1,        // закончится после прихода заказа, размещённого сегодня
      orderByDay: belowSS == null ? null : belowSS - leadDays,   // последний день, чтобы успеть
      nextOrderByDay: belowSS1 == null ? null : belowSS1 - leadDays, // следующий заказ после сегодняшнего
      deficit: deficit0, deficitWithOrder: deficit1,
    };
  }

  function calc(sku, p) {
    const r = calcCore(sku, p);
    const pr = projection(sku, p, r.qty, 180, r);
    r.stockoutDay = pr.stockoutDay;
    r.orderByDay = r.level > 0 ? pr.orderByDay : null;
    r.deficit = pr.deficit;
    return r;
  }

  /** Вклад каждого фактора: заказ, если этот фактор выключить. */
  function sensitivity(sku, p) {
    const base = calc(sku, p).qty;
    const flip = (k) => calc(sku, { ...p, [k]: !p[k] }).qty - base;
    return {
      oneoff: flip("oneoff"), restore: flip("restore"), season: flip("season"),
      trend: flip("trend"), transit: flip("transit"),
    };
  }

  function explain(sku, r, p) {
    const f = (x) => Math.round(x).toLocaleString("ru-RU");
    const parts = [`Регулярный спрос ≈ ${f(r.level)} шт/мес`];
    if (p.oneoff && sku.oo.length) parts.push(`исключено ${sku.oo.length} разовых заказов (${f(r.oneoffQty)} шт)`);
    if (p.restore && r.lost > 0.5) parts.push(`восстановлен упущенный спрос +${f(r.lost)} шт за 12 мес.`);
    if (p.trend && Math.abs(r.growth) >= 0.05) parts.push(`тренд ${r.growth > 0 ? "+" : ""}${Math.round(r.growth * 100)}% г/г`);
    if (p.growth) parts.push(`прогноз прироста ${p.growth > 0 ? "+" : ""}${Math.round(p.growth * 100)}%`);
    if (p.season && r.level > 0) parts.push(`сезонность ×${r.seasonMult.toFixed(2)}`);
    let t = parts.join("; ") + `. Потребность на ${r.H.toLocaleString("ru-RU")} мес.: ${f(r.demandH)} + страховой ${f(r.safety)} − остаток ${f(r.stock)} − в пути ${f(r.transit)} = ${f(r.need)}`;
    t += r.qty > 0 ? ` → кратность ${f(r.moq)} → заказ ${f(r.qty)}.` : " → заказ не нужен.";
    return t;
  }

  return { calc, sensitivity, explain, horizon, projection, dateOf, T0 };
})();
