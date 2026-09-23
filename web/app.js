/* Умный Закуп — интерфейс менеджера по закупкам. */
(() => {
  const DATA = window.DATA;
  const META = DATA.meta;
  const SUPS = META.suppliers;
  const REAL_SUPS = { ...SUPS };
  const SB_ID = "__manual__";
  const supName = (k) => (SUPS[k] ? SUPS[k].name : "Ручная проверка");
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (x, d = 0) => (x == null || !isFinite(x) ? "—" : Number(x).toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const money = (x) => (x >= 1e6 ? `${fmt(x / 1e6, 1)} млн ₸` : x >= 1e3 ? `${fmt(x / 1e3, 0)} тыс ₸` : `${fmt(x)} ₸`);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const dayDate = (i) => { const d = Engine.dateOf(i); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const inDays = (i) => (i <= 0 ? "сегодня" : i === 1 ? "завтра" : `через ${fmt(i)} дн`);
  const WINDOWS = [
    { k: "now", label: "Сегодня", sub: "срок уже наступил", test: (d) => d != null && d <= 0 },   // вместе с final > 0 = Engine.isOrderToday
    { k: "w1", label: "Эта неделя", sub: "1–7 дней", test: (d) => d >= 1 && d <= 7 },
    { k: "w2", label: "Следующая неделя", sub: "8–14 дней", test: (d) => d >= 8 && d <= 14 },
    { k: "m1", label: "В этом месяце", sub: "15–30 дней", test: (d) => d >= 15 && d <= 30 },
    { k: "m2", label: "Через 1–2 месяца", sub: "31–60 дней", test: (d) => d >= 31 && d <= 60 },
    { k: "later", label: "Позже", sub: "больше 60 дней", test: (d) => d > 60 },
  ];

  const URG = {
    critical: { label: "Критично", hint: "закончится до прихода новой поставки", icon: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>' },
    soon: { label: "Скоро", hint: "запас ниже страхового уровня", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    planned: { label: "Планово", hint: "плановое пополнение", icon: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
    ok: { label: "Запас в норме", hint: "заказ не нужен", icon: '<path d="M5 12l5 5 9-10"/>' },
  };
  const URG_ORDER = { critical: 0, soon: 1, planned: 2, ok: 3 };
  const pill = (u) => `<span class="pill ${u}"><svg viewBox="0 0 24 24">${URG[u].icon}</svg>${URG[u].label}</span>`;
  const ST = Engine.STATUS;
  const ST_ICON = {
    crit: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    good: '<path d="M5 12l5 5 9-10"/>',
    none: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12h7"/>',
  };
  const statusPill = (st) => `<span class="pill st-${ST[st].tone}"><svg viewBox="0 0 24 24">${ST_ICON[ST[st].tone]}</svg>${ST[st].label}</span>`;
  const NA = '<span class="na">Нет данных</span>';
  const fDay = (i) => (i == null ? NA : Engine.fmtDay(i));
  const SCN = Engine.SC;
  const pct = (x) => (x == null ? "Нет данных" : `${fmt(x * 100, x < 0.1 && x > 0 ? 1 : 0)}%`);

  // ---------------- state ----------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("zakup:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("zakup:" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };
  const defaults = {
    lead: Object.fromEntries(Object.entries(SUPS).map(([k, v]) => [k, v.lead])),
    review: 1, growth: 0, oneoff: true, restore: true, season: true, trend: true, transit: true,
    scenario: "base", buffer: META.buffer,
  };
  const state = {
    sup: "all", q: "", urg: "all", st: "all", group: "all", abc: "all", sort: "action", onlyOrder: true, tab: "today", win: null,
    budget: store.get("budget", null), alloc: null,
    p: { ...defaults, ...store.get("params", {}) },
    overrides: store.get("overrides", {}),
    approved: store.get("approved", {}),
    limit: {},
  };
  let rows = [];
  // товары, добавленные менеджером вручную (вкладка «Проверить расчёт»), — хранятся в этом браузере
  state.custom = store.get("custom", []);
  const allSkus = () => DATA.skus.concat(state.custom);

  function recompute() {
    rows = allSkus().map((s) => {
      const r = Engine.calc(s, state.p);
      const ov = state.overrides[s.id];
      const final = ov != null ? ov : r.qty;
      return { s, r, final, value: Engine.hasPrice(s) ? final * s.pr : 0 };
    });
    state.alloc = state.budget > 0 ? Engine.allocateBudget(baseRows(), state.budget) : null;
  }
  // выбор поставщика и группы товаров (категории) пересчитывает весь дашборд — сценарий ТЗ «расчёт по складу или категории»
  const baseRows = () => rows.filter(({ s }) => (state.sup === "all" || s.sup === state.sup) && (state.group === "all" || s.g === state.group));

  // ---------------- params panel ----------------
  const TOGGLES = [
    ["oneoff", "Исключать разовые заказы", "крупные разовые накладные (поля клиента в выгрузке нет)"],
    ["restore", "Восстанавливать упущенный спрос", "месяцы, когда товара не было на складе"],
    ["season", "Сезонность", "профиль поставщика + история товара"],
    ["trend", "Тренд роста", "рост/падение спроса год к году"],
    ["transit", "Товар в пути", "уже заказанное вычитается из потребности"],
  ];

  function buildParams() {
    $("#leadFields").innerHTML = Object.entries(REAL_SUPS).map(([k, v]) => `
      <div class="field">
        <label for="leadNum-${k}">Срок поставки ${esc(v.name)} <span class="numin"><input type="number" id="leadNum-${k}" data-sup="${k}" min="1" max="365" step="1" inputmode="numeric"> дн</span></label>
        <input type="range" id="lead-${k}" data-sup="${k}" min="7" max="120" step="1" aria-label="Срок поставки ${esc(v.name)}, дни">
      </div>`).join("");
    // ползунок и поле ввода — одно значение в днях; в расчёте хранится в месяцах (дни / 30)
    bindNum("#lead-{k}", "#leadNum-{k}", (k) => Math.round(state.p.lead[k] * 30), (k, d) => { state.p.lead[k] = d / 30; }, 1, 365);
    $("#scenSeg").innerHTML = Object.entries(SCN).map(([k, v]) => `<button role="radio" aria-checked="${state.p.scenario === k}" class="${state.p.scenario === k ? "active" : ""}" data-sc="${k}">${v.label}</button>`).join("");
    $$("#scenSeg button").forEach((b) => (b.onclick = () => setScenario(b.dataset.sc)));
    bindPair("#buffer", "#bufferNum", () => state.p.buffer, (d) => { state.p.buffer = d; }, 0, 60);
    bindPair("#review", "#reviewNum", () => Math.round(state.p.review * 30), (d) => { state.p.review = d / 30; }, 7, 180);
    bindPair("#growth", "#growthNum", () => Math.round(state.p.growth * 100), (d) => { state.p.growth = d / 100; }, -90, 300);

    $("#toggles").innerHTML = TOGGLES.map(([k, t, sub]) => `
      <label class="toggle">
        <span class="t-text"><span class="t-title">${t}</span><br><span class="t-sub">${sub}</span></span>
        <span class="switch"><input type="checkbox" data-k="${k}" ${state.p[k] ? "checked" : ""}><span></span></span>
      </label>`).join("") + `<button class="btn sm ghost" id="resetParams" style="margin-top:8px">Сбросить параметры</button>`;
    $$("#toggles input").forEach((el) => el.addEventListener("change", () => { state.p[el.dataset.k] = el.checked; onParams(); }));
    $("#resetParams").addEventListener("click", () => {
      state.p = JSON.parse(JSON.stringify(defaults));
      pairs.length = 0;
      buildParams(); onParams();
    });
    paramLabels();
  }
  const months = (x) => { const d = Math.round(x * 30); return d % 30 ? `${fmt(d)} дн` : `${fmt(d / 30, 1)} мес`; };
  /** Ползунок + поле точного ввода: одно значение, синхронизируются в обе стороны. */
  const pairs = [];
  function bindPair(rangeSel, numSel, get, set, min, max) {
    const r = $(rangeSel), n = $(numSel);
    const apply = (v, from) => {
      if (!isFinite(v)) return;
      const d = Math.min(max, Math.max(min, Math.round(v)));
      set(d);
      if (from !== r) r.value = d;
      if (from !== n) n.value = d;
      onParams();
    };
    r.oninput = () => apply(+r.value, r);
    n.oninput = () => { if (n.value !== "" && n.value !== "-") apply(+n.value, n); };
    n.onchange = () => { n.value = get(); r.value = get(); };
    pairs.push(() => { r.value = get(); n.value = get(); });
    r.value = get(); n.value = get();
  }
  function bindNum(rangeTpl, numTpl, get, set, min, max) {
    Object.keys(REAL_SUPS).forEach((k) => bindPair(rangeTpl.replace("{k}", k), numTpl.replace("{k}", k), () => get(k), (d) => set(k, d), min, max));
  }
  function paramLabels() {
    pairs.forEach((f) => f());
    $("#scenNote").innerHTML = `<b>${SCN[state.p.scenario].label}:</b> ${esc(SCN[state.p.scenario].note)}. <span class="muted">Демонстрационные допущения, а не вероятности.</span>`;
    $$("#scenSeg button").forEach((b) => { const on = b.dataset.sc === state.p.scenario; b.classList.toggle("active", on); b.setAttribute("aria-checked", on); });
  }
  function setScenario(k) { state.p.scenario = k; onParams(); }
  let paramTimer;
  function onParams() {
    paramLabels();
    store.set("params", state.p);
    clearTimeout(paramTimer);
    paramTimer = setTimeout(() => { recompute(); render(); if (openId) openDrawer(openId, true); }, 30);
  }

  // ---------------- filtering ----------------
  function visible(ignoreUrg = false) {
    const q = state.q.trim().toLowerCase();
    return rows.filter(({ s, r, final }) => {
      if (state.sup !== "all" && s.sup !== state.sup) return false;
      if (state.group !== "all" && s.g !== state.group) return false;
      if (state.abc !== "all" && s.abc !== state.abc) return false;
      if (!ignoreUrg && state.urg !== "all" && r.urgency !== state.urg) return false;
      if (state.st !== "all" && r.status !== state.st) return false;
      if (state.stSet && !state.stSet.includes(r.status)) return false;
      if (state.deficitOnly && !r.expectedDeficit) return false;
      if (state.win && !WINDOWS.find((w) => w.k === state.win).test(r.orderByDay)) return false;
      if (state.onlyOrder && !(final > 0) && !(state.urg === "ok")) return false;
      if (q && !(`${s.n} ${s.id} ${s.art || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }
  function sorted(list) {
    const by = {
      action: Engine.actionCompare,
      urgency: (a, b) => URG_ORDER[a.r.urgency] - URG_ORDER[b.r.urgency] || a.s.abc.localeCompare(b.s.abc) || b.r.monthly - a.r.monthly,
      value: (a, b) => b.value - a.value || b.final - a.final,
      qty: (a, b) => b.final - a.final,
      orderBy: (a, b) => (a.r.orderByDay ?? 1e6) - (b.r.orderByDay ?? 1e6) || URG_ORDER[a.r.urgency] - URG_ORDER[b.r.urgency],
      name: (a, b) => a.s.n.localeCompare(b.s.n, "ru"),
    }[state.sort];
    return list.sort(by);
  }

  // ---------------- KPIs ----------------
  const ICON = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M9 9.5h4.5a2 2 0 010 4H10a2 2 0 000 4H15M12 7v2M12 17.5V19"/>',
  };
  function renderKpis() {
    const base = baseRows();
    const today = base.filter(Engine.isOrderToday);
    const deficit = base.filter((x) => x.r.expectedDeficit);
    const crit = base.filter((x) => x.r.urgency === "critical");
    const cov = Engine.priceCoverage(base);
    // четыре показателя не пересекаются: нет на складе + срок наступил = «заказать сегодня»
    const noStock = today.filter((x) => x.r.status === "now");
    const due = today.filter((x) => x.r.status !== "now");
    const week = base.filter((x) => x.final > 0 && x.r.status === "week");
    const cards = [
      { label: "Нет на складе", tone: "crit", ico: "alert", value: fmt(noStock.length), sub: "спрос есть, товара нет — заказать немедленно", act: () => setFilter({ urg: "all", st: "now", win: null, onlyOrder: true, sort: "action" }) },
      { label: "Срок заказа наступил", tone: "crit", ico: "clock", value: fmt(due.length), sub: `товар ещё есть, но заказ нужен сегодня · всего сегодня ${fmt(today.length)}`, act: () => setFilter({ urg: "all", st: "all", win: null, onlyOrder: true, sort: "action", stSet: ["overdue", "today"] }) },
      { label: "Заказать на этой неделе", tone: "warn", ico: "box", value: fmt(week.length), sub: "последний безопасный день в ближайшие 7 дней", act: () => setFilter({ urg: "all", st: "week", win: null, onlyOrder: true, sort: "action" }) },
      { label: "Стоимость заказа", tone: "plan", ico: "coin", value: cov.priced ? money(cov.value) : "Нет данных", sub: `неполная: цены у ${pct(cov.share)} позиций`, bar: cov.share, act: () => switchTab("method") },
    ];
    $("#kpis").innerHTML = cards.map((c, i) => `
      <div class="kpi t-${c.tone} clickable" data-i="${i}" tabindex="0" role="button">
        <div class="k-top"><div class="k-label">${c.label}</div><div class="k-ico"><svg viewBox="0 0 24 24">${ICON[c.ico]}</svg></div></div>
        <div class="k-value num">${c.value}</div>
        <div class="k-sub">${c.sub}</div>
        ${c.bar != null ? `<div class="k-bar" title="Покрытие ценами"><i style="width:${Math.round(c.bar * 100)}%"></i></div>` : ""}
      </div>`).join("");
    $$("#kpis .kpi").forEach((el) => {
      el.addEventListener("click", () => cards[+el.dataset.i].act());
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cards[+el.dataset.i].act(); } });
    });
    const p = state.p;
    $("#ctx").innerHTML = `<span class="c-item">Сценарий <b>${SCN[p.scenario].label}</b></span>
      ${Object.entries(REAL_SUPS).map(([k, v]) => `<span class="c-item">${esc(v.name)} <b>${fmt(Math.round(p.lead[k] * 30))} дн</b></span>`).join("")}
      <span class="c-item">Согласование <b>${p.buffer} дн</b></span>
      <label class="c-item c-sel" title="В выгрузке партнёра один склад — Алматы; у Systeme Electric в карточке товара видна разбивка по складам">Склад <select id="ctxWh" aria-label="Склад"><option>Алматы (все склады)</option></select></label>
      <label class="c-item c-sel">Категория <select id="ctxGroup" aria-label="Группа товаров"><option value="all">Все группы</option>${[...new Set(rows.filter((x) => state.sup === "all" || x.s.sup === state.sup).map((x) => x.s.g))].sort((a, b) => a.localeCompare(b, "ru")).map((g) => `<option ${state.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></label>
      ${p.growth ? `<span class="c-item">Прирост <b>${p.growth > 0 ? "+" : ""}${Math.round(p.growth * 100)}%</b></span>` : ""}
      <button class="c-edit" id="ctxEdit">Изменить параметры</button>`;
    $("#ctxEdit").onclick = openParams;
    $("#ctxGroup").onchange = (e) => { state.group = e.target.value; renderGroupSel(); recompute(); render(); };
  }
  function openParams() { $("#params").classList.add("open"); $("#paramsScrim").hidden = false; document.body.classList.add("lock"); $("#params").scrollTop = 0; }
  function closeParams() { $("#params").classList.remove("open"); $("#paramsScrim").hidden = true; document.body.classList.remove("lock"); }

  // ---------------- «Что делать сегодня» ----------------
  function reasonText(x) {
    const { s, r } = x;
    const parts = [];
    if (r.status === "now") parts.push(`товара нет, спрос ${fmt(r.monthly)} шт/мес`);
    else if (r.status === "overdue") parts.push(`срок заказа прошёл ${fmt(-r.safeDay)} дн назад`);
    else if (r.status === "today") parts.push("сегодня последний безопасный день");
    else if (r.status === "week") parts.push(`безопасный день через ${fmt(r.safeDay)} дн`);
    if (r.expectedDeficit && r.deficitLead >= 1) parts.push(`до прихода поставки не хватит ≈ ${fmt(r.deficitLead)} шт`);
    if (s.abc === "A") parts.push("частый спрос (A)");
    if (r.transitNoEta) parts.push(`${fmt(r.transitNoEta)} шт в пути без даты`);
    return parts.join(" · ");
  }
  const ST_COLOR = { now: "var(--crit)", overdue: "#ec835a", today: "var(--warn)", week: "#f5c451", later: "var(--good)", nodata: "var(--line-strong)" };
  function donut(parts, total) {
    const R = 86, r = 62, C = 90;
    let a0 = -Math.PI / 2, out = "";
    parts.filter((p) => p.v > 0).forEach((p) => {
      const a1 = a0 + (p.v / total) * Math.PI * 2 - 0.02;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (rad, a) => `${(C + rad * Math.cos(a)).toFixed(2)},${(C + rad * Math.sin(a)).toFixed(2)}`;
      out += `<path d="M${pt(R, a0)} A${R},${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${large} 0 ${pt(r, a0)} Z" fill="${p.c}" class="hit2" data-tip="${esc(`<b>${p.l}</b><br>${fmt(p.v)} позиций`)}"/>`;
      a0 = a1 + 0.02;
    });
    return `<svg viewBox="0 0 180 180" role="img" aria-label="Статусы позиций к заказу">${out}
      <text x="90" y="92" text-anchor="middle" font-size="24" font-weight="700" fill="var(--text)">${fmt(total)}</text>
      <text x="90" y="110" text-anchor="middle" font-size="11" fill="var(--text-3)">к заказу</text></svg>`;
  }
  function weekBars(list) {
    const weeks = 12, counts = new Array(weeks).fill(0);
    list.forEach((x) => { const d = Math.max(0, x.r.safeDay); const w = Math.floor(d / 7); if (w < weeks) counts[w]++; });
    const W = 560, H = 190, pl = 34, pb = 24, pt = 16, iw = W - pl - 6, ih = H - pb - pt, bw = iw / weeks;
    const nice = niceMax(Math.max(1, ...counts));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Сколько заказов разместить по неделям">`;
    [0, 0.5, 1].forEach((f) => { const yy = pt + ih - f * ih; svg += `<line x1="${pl}" x2="${W - 6}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${pl - 6}" y="${yy + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">${fmt(nice * f)}</text>`; });
    counts.forEach((c, i) => {
      const h = (c / nice) * ih, xx = pl + i * bw + 4, yy = pt + ih - h;
      if (c) svg += `<path d="${roundTop(xx, yy, bw - 8, h, 4)}" fill="${i === 0 ? "var(--crit)" : i === 1 ? "var(--warn)" : "var(--series-1)"}"/><text x="${xx + (bw - 8) / 2}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="var(--text-2)">${fmt(c)}</text>`;
      svg += `<rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${ih}" fill="transparent" data-tip="${esc(`<b>${i === 0 ? "Сейчас (срок наступил или наступает на этой неделе)" : `Неделя с ${dayDate(i * 7)}`}</b><br>${fmt(c)} позиций`)}"/>`;
      if (i % 2 === 0) svg += `<text x="${pl + i * bw + bw / 2}" y="${H - 7}" text-anchor="middle" font-size="10" fill="var(--text-3)">${i === 0 ? "сейчас" : dayDate(i * 7)}</text>`;
    });
    return svg + "</svg>";
  }

  // ---------------- заказ поставщику: проверить → согласовать → отправить ----------------
  const SCOPES = {
    today: ["Сегодня", "нет на складе и срок заказа наступил", (x) => Engine.isOrderToday(x)],
    week: ["+ эта неделя", "сегодня и ближайшие 7 дней", (x) => Engine.isOrderToday(x) || (x.final > 0 && x.r.status === "week")],
    all: ["Весь заказ", "все рекомендованные позиции", (x) => x.final > 0],
  };
  let sheet = { k: null, scope: "today" };
  // ручной выбор: off — снятые галочки, add — товары, добавленные вручную через поиск
  state.pick = store.get("pick", {});
  const pickOf = (k) => (state.pick[k] ||= { off: [], add: [] });
  const savePick = () => store.set("pick", state.pick);
  /** Кандидаты в заказ: рекомендованные в выбранном наборе + добавленные вручную. */
  function orderCandidates(k, scope) {
    const pk = pickOf(k);
    const base = rows.filter((x) => x.s.sup === k && (state.group === "all" || x.s.g === state.group) && SCOPES[scope][2](x));
    const ids = new Set(base.map((x) => x.s.id));
    const added = pk.add.map((id) => rows.find((x) => x.s.id === id)).filter((x) => x && !ids.has(x.s.id));
    return [...base.sort(Engine.actionCompare), ...added].map((x) => ({ ...x, on: !pk.off.includes(x.s.id), manual: !ids.has(x.s.id) }));
  }
  /** Позиции, которые реально уходят в заказ: отмечены и количество > 0. */
  const orderLines = (k, scope) => orderCandidates(k, scope).filter((x) => x.on && x.final > 0);
  const orderFile = (k) => `Заказ_${SUPS[k].name.replace(/\s+/g, "_")}_${META.asOf}.xlsx`;

  function orderSummary(k, lines, pendingAt = null) {
    const cov = Engine.priceCoverage(lines);
    const units = lines.reduce((a, x) => a + x.final, 0);
    const ap = state.approved[k] || (pendingAt ? { at: pendingAt } : null);
    const head = [
      `Заказ поставщику ${SUPS[k].name} от ${new Date().toLocaleDateString("ru-RU")}`,
      `Позиций: ${fmt(lines.length)}, штук: ${fmt(units)}`,
      cov.priced ? `Сумма по себестоимости (известные цены): ${money(cov.value)}` : null,
      ap ? `Согласовано: ${ap.at}` : null,
    ].filter(Boolean);
    // весь заказ в тексте, если он умещается в сообщение; иначе первые 30 позиций
    const all = lines.length <= 50;
    const top = (all ? lines : lines.slice(0, 30)).map((x, i) => `${i + 1}. ${x.s.art || x.s.id} — ${x.s.n} — ${fmt(x.final)} шт`);
    if (!all) top.push(`…и ещё ${fmt(lines.length - 30)} позиций — полный список в файле Excel`);
    return [...head, "", ...top].join("\n");
  }

  /** Ссылка на WhatsApp/Telegram с готовым текстом. Это обычная ссылка <a>: переход по ней
   *  браузер не блокирует (в отличие от window.open после скачивания файла). */
  function shareUrl(kind, k, lines) {
    const at = state.approved[k] ? null : new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const text = orderSummary(k, lines, at);
    return kind === "wa"
      ? `https://wa.me/?text=${encodeURIComponent(text)}`
      : `https://t.me/share/url?url=${encodeURIComponent("https://umny-zakup.vercel.app")}&text=${encodeURIComponent(text)}`;
  }

  // Заказ поставщику — мастер из двух шагов: 1) выбрать товары, 2) проверить текст и отправить.
  function openOrderSheet(k, scope = sheet.scope, step = 1) {
    sheet = { k, scope, q: "", link: null, step: state.approved[k] ? 2 : step };
    openId = null;
    const d = $("#drawer");
    d.innerHTML = `<div class="d-head"><div style="min-width:0;flex:1">
          <div class="wiz" id="osWiz"></div>
          <h2 id="osTitle"></h2>
        </div>
        <button class="d-close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="d-body" id="osBody"></div>
      <div class="os-bar" id="osBar"></div>`;
    $(".d-close", d).onclick = closeDrawer;
    refreshSheet(true);
    d.classList.add("open"); d.setAttribute("aria-hidden", "false"); $("#scrim").hidden = false; d.scrollTop = 0;
  }

  function refreshSheet(full = false) {
    const { k, step } = sheet;
    const cand = orderCandidates(k, sheet.scope);
    const lines = cand.filter((x) => x.on && x.final > 0);
    const units = lines.reduce((a, x) => a + x.final, 0);
    const cov = Engine.priceCoverage(lines);
    $("#osWiz").innerHTML = `<span class="${step === 1 ? "on" : "done"}">1 · Выбрать товары</span><i></i><span class="${step === 2 ? "on" : ""}">2 · Проверить и отправить</span>`;
    $("#osTitle").textContent = step === 1 ? `Какие товары заказать у ${SUPS[k].name}?` : `Отправить заказ ${SUPS[k].name}`;
    const total = `<b class="num">${fmt(lines.length)}</b> поз. · <b class="num">${fmt(units)}</b> шт${cov.priced ? ` · <b class="num">${money(cov.value)}</b>${cov.missing ? " по изв. ценам" : ""}` : ""}`;
    if (step === 1) {
      if (full) renderStep1(k);
      renderStep1List(k, cand);
      $("#osBar").innerHTML = `<div class="os-bar-t">Выбрано: ${total}</div>
        <button class="btn primary" id="osNext" ${lines.length ? "" : "disabled"}>Далее: проверить и отправить →</button>`;
      $("#osNext").onclick = () => { sheet.step = 2; sheet.link = null; refreshSheet(true); $("#drawer").scrollTop = 0; };
    } else {
      renderStep2(k, lines, total);
    }
  }

  function renderStep1(k) {
    $("#osBody").innerHTML = `
      <div class="os-howto">Сервис уже отметил товары, которые <b>нужно заказать</b> (набор можно сменить ниже). Снимите галочки с лишнего, нажмите <b>«Снять все»</b>, чтобы выбрать с нуля, или найдите любой товар поставщика через поиск. Затем нажмите <b>«Далее»</b> внизу.</div>
      <div class="os-tools">
        <div class="seg" role="tablist" aria-label="Какие товары отметить">${Object.entries(SCOPES).map(([key, [l]]) => `<button class="${key === sheet.scope ? "active" : ""}" data-scope="${key}">${l}</button>`).join("")}</div>
        <button class="btn sm" id="osAllOn">Отметить все</button>
        <button class="btn sm" id="osAllOff">Снять все</button>
      </div>
      <div class="os-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="osQ" type="search" placeholder="Найти товар ${esc(SUPS[k].name)}: название, код 1С, артикул" autocomplete="off" aria-label="Поиск товара">
      </div>
      <div id="osFound"></div>
      <div id="osList"></div>`;
    $$("[data-scope]").forEach((b) => (b.onclick = () => { sheet.scope = b.dataset.scope; refreshSheet(true); }));
    let qt;
    $("#osQ").oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { sheet.q = e.target.value.trim().toLowerCase(); refreshSheet(); }, 120); };
    const pk = pickOf(k);
    const setAll = (on) => { orderCandidates(k, sheet.scope).forEach((x) => { pk.off = pk.off.filter((id) => id !== x.s.id); if (!on) pk.off.push(x.s.id); }); savePick(); refreshSheet(); };
    $("#osAllOn").onclick = () => setAll(true);
    $("#osAllOff").onclick = () => setAll(false);
  }

  function renderStep1List(k, cand) {
    const q = sheet.q;
    const inList = new Set(cand.map((x) => x.s.id));
    const match = (x) => `${x.s.n} ${x.s.id} ${x.s.art || ""}`.toLowerCase().includes(q);
    const found = q.length >= 2 ? rows.filter((x) => x.s.sup === k && !inList.has(x.s.id) && match(x)).slice(0, 8) : [];
    $("#osFound").innerHTML = found.length ? `<div class="os-found"><div class="muted" style="font-size:12.5px;margin-bottom:6px">Других товаров нет в списке — можно добавить:</div>
      ${found.map((x) => `<div class="os-f"><span><b>${esc(x.s.n)}</b><br><span class="muted">${esc(x.s.id)}${x.s.art ? " · " + esc(x.s.art) : ""} · остаток ${fmt(x.r.stock)} · ${x.r.qty > 0 ? `рекомендовано ${fmt(x.r.qty)} шт` : "сервис не рекомендует заказ"}</span></span><button class="btn sm" data-add="${esc(x.s.id)}">+ Добавить</button></div>`).join("")}</div>` : "";
    const shown = q ? cand.filter(match) : cand;
    $("#osList").innerHTML = shown.length ? `<div class="table-wrap"><table class="acts os-table">
        <thead><tr><th style="width:34px"></th><th>Товар</th><th>Статус</th><th class="r">Заказать, шт</th></tr></thead>
        <tbody>${shown.slice(0, 400).map((x) => `<tr class="${x.on ? "" : "off"}">
          <td><input type="checkbox" data-on="${esc(x.s.id)}" ${x.on ? "checked" : ""} aria-label="Заказать этот товар"></td>
          <td><div class="p-name">${esc(x.s.n)}${x.manual || x.s.manual ? ' <span class="badge in">добавлен вручную</span>' : ""}</div><div class="p-meta"><span>${esc(x.s.id)}</span>${x.s.art ? `<span>${esc(x.s.art)}</span>` : ""}<span>остаток ${fmt(x.r.stock)}</span></div></td>
          <td>${statusPill(x.r.status)}</td>
          <td class="r"><input class="qty-input ${state.overrides[x.s.id] != null ? "edited" : ""}" type="number" min="0" step="${x.s.moq}" value="${x.final}" data-oq="${esc(x.s.id)}" ${x.on ? "" : "disabled"} aria-label="Количество">${x.on && !(x.final > 0) ? '<div class="rec-hint" style="color:var(--warn)">укажите количество</div>' : ""}</td>
        </tr>`).join("")}</tbody></table></div>
        ${shown.length > 400 ? `<p class="muted" style="font-size:12.5px">Показаны первые 400 из ${fmt(shown.length)} — уточните поиск.</p>` : ""}`
      : `<div class="empty">${q ? "Среди отмеченных таких нет — выше можно добавить найденные." : "Список пуст. Выберите другой набор выше или найдите товар поиском."}</div>`;
    const pk = pickOf(k);
    const setOn = (id, on) => { pk.off = pk.off.filter((x) => x !== id); if (!on) pk.off.push(id); };
    $$("[data-on]").forEach((c) => (c.onchange = () => { setOn(c.dataset.on, c.checked); savePick(); refreshSheet(); }));
    $$("[data-add]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.add;
      if (!pk.add.includes(id)) pk.add.push(id);
      setOn(id, true); savePick();
      if (!(rows.find((r) => r.s.id === id).final > 0)) toast("Товар добавлен — укажите количество");
      refreshSheet();
    }));
    $$("[data-oq]").forEach((inp) => (inp.onchange = () => {
      const row = rows.find((x) => x.s.id === inp.dataset.oq);
      const v = Math.max(0, Math.round(+inp.value || 0));
      if (v === row.r.qty) delete state.overrides[row.s.id]; else state.overrides[row.s.id] = v;
      store.set("overrides", state.overrides); recompute(); render(); refreshSheet();
    }));
  }

  function renderStep2(k, lines, total) {
    const ap = state.approved[k];
    const preview = orderSummary(k, lines);
    $("#osBody").innerHTML = `
      ${ap ? `<div class="step-done"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>Согласовано ${esc(ap.at)} на этом устройстве</div>` : ""}
      ${sheet.link ? `<div class="os-link">Если ${sheet.link.kind === "wa" ? "WhatsApp" : "Telegram"} не открылся, нажмите:
        <a class="btn share ${sheet.link.kind}" href="${esc(sheet.link.url)}" target="_blank" rel="noopener">Открыть ${sheet.link.kind === "wa" ? "WhatsApp" : "Telegram"}</a>
        <span class="muted">Нужен файл для поставщика? Кнопка «Excel» ниже.</span></div>` : ""}
      <div class="os-block"><div class="os-label">В заказе</div><div class="os-total">${total}</div>
        <div class="os-mini">${lines.slice(0, 200).map((x) => `<div><span>${esc(x.s.n)}</span><b class="num">${fmt(x.final)} шт</b></div>`).join("")}${lines.length > 200 ? `<div class="muted">…и ещё ${fmt(lines.length - 200)}</div>` : ""}</div></div>
      <div class="os-block"><div class="os-label">Так будет выглядеть сообщение</div><pre class="os-preview">${esc(preview)}</pre></div>
      <p class="muted" style="font-size:12px;margin:0">Нажатие кнопки отправки = согласование заказа. Сервис ничего не отправляет сам: откроется мессенджер с этим текстом, получателя выберете вы. Файл скачивается только кнопкой «Excel».</p>`;
    $("#osBar").innerHTML = `
      <button class="btn" id="osBack">← Изменить выбор</button>
      <div class="send-row" style="margin-left:auto">
        <a class="btn share wa" data-send="wa" href="${esc(shareUrl("wa", k, lines))}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1 1 8 19z"/></svg>WhatsApp</a>
        <a class="btn share tg" data-send="tg" href="${esc(shareUrl("tg", k, lines))}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24"><path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/></svg>Telegram</a>
        <button class="btn share" data-send="mail">Почта</button>
        ${navigator.canShare ? `<button class="btn share" data-send="file">Поделиться файлом</button>` : ""}
        <button class="btn share" id="osXls">Excel</button>
        <button class="btn share" id="osCsv" title="CSV для загрузки в 1С: код 1С, артикул, наименование, количество, цена">Для 1С (CSV)</button>
      </div>`;
    $("#osBack").onclick = () => {
      if (state.approved[k]) { delete state.approved[k]; store.set("approved", state.approved); render(); }
      sheet.step = 1; sheet.link = null; refreshSheet(true);
    };
    const approve = () => {
      if (state.approved[k]) return state.approved[k];
      state.approved[k] = { at: new Date().toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }), n: lines.length };
      store.set("approved", state.approved);
      return state.approved[k];
    };
    const xls = (a = state.approved[k]) => XLSX.writeFile(buildWorkbook([k], () => lines, a ? `Согласовано ${a.at}, отправляет менеджер` : null), orderFile(k));
    $("#osXls").onclick = () => { xls(); toast("Excel скачан"); };
    $("#osCsv").onclick = () => { csv1c(k, lines); toast("CSV для 1С скачан"); };
    $$("[data-send]").forEach((b) => (b.onclick = async (e) => {
      const kind = b.dataset.send;
      const a = approve();
      const later = () => setTimeout(() => { render(); refreshSheet(true); }, 60);
      if (kind === "wa" || kind === "tg") {
        sheet.link = { url: b.getAttribute("href"), kind };
        toast(`Открывается ${kind === "wa" ? "WhatsApp" : "Telegram"} с текстом заказа`);
        later();
        return;
      }
      e.preventDefault();
      const text = orderSummary(k, lines);
      if (kind === "file") {
        const blob = new Blob([XLSX.write(buildWorkbook([k], () => lines, `Согласовано ${a.at}`), { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const file = new File([blob], orderFile(k), { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: `Заказ ${SUPS[k].name}`, text: text.split("\n").slice(0, 3).join("\n") }); } catch { /* отменено */ }
        } else { xls(a); toast("Это устройство не умеет делиться файлом — Excel скачан"); }
      } else if (kind === "mail") {
        location.href = `mailto:?subject=${encodeURIComponent(`Заказ поставщику ${SUPS[k].name}`)}&body=${encodeURIComponent(text.split("\n").slice(0, 25).join("\n"))}`;
        toast("Открыта почта с текстом заказа");
      }
      later();
    }));
  }

  function highlightSend() { toast("Шаг 1: отметьте товары и нажмите «Далее» — затем выберите WhatsApp или Telegram"); }
  /** Кнопка «Отправить заказ» в шапке: выбрать поставщика. */
  function sendChooser() {
    const keys = Object.keys(REAL_SUPS).filter((k) => state.sup === "all" || k === state.sup);
    if (keys.length === 1) { switchTab("today"); openOrderSheet(keys[0], "today"); return; }
    const m = $("#modal");
    m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true"><h3>Отправить заказ поставщику</h3>
      <p>Выберите поставщика. Откроется заказ: отметьте нужные товары галочками, найдите и добавьте другие через поиск — и отправьте в WhatsApp, Telegram или на почту.</p>
      <div class="list">${keys.map((k) => { const l = orderLines(k, "today"); return `<button class="list-row" data-ch="${k}" style="width:100%;border:0;background:none;cursor:pointer;text-align:left;font:inherit"><span><b>${esc(REAL_SUPS[k].name)}</b><br><span class="muted">на сегодня ${fmt(l.length)} поз. · ${fmt(l.reduce((a, x) => a + x.final, 0))} шт</span></span><span style="color:var(--accent-ink);font-weight:600">Открыть →</span></button>`; }).join("")}</div>
      <div class="modal-actions"><button class="btn" data-close>Отмена</button></div></div>`;
    m.hidden = false;
    $("[data-close]", m).onclick = () => (m.hidden = true);
    m.onclick = (e) => { if (e.target === m) m.hidden = true; };
    $$("[data-ch]", m).forEach((b) => (b.onclick = () => { m.hidden = true; switchTab("today"); openOrderSheet(b.dataset.ch, "today"); }));
  }

  function supplierOrderCards(base) {
    return `<div class="order-cards">${Object.keys(REAL_SUPS).filter((k) => state.sup === "all" || k === state.sup).map((k) => {
      const lines = orderLines(k, "today");
      const all = base.filter((x) => x.s.sup === k && x.final > 0);
      const cov = Engine.priceCoverage(lines);
      const ap = state.approved[k];
      const pk = pickOf(k);
      const edited = pk.off.length || pk.add.length;
      return `<div class="order-card">
        <div class="oc-name"><div class="oc-sup">${esc(REAL_SUPS[k].name)}</div><div class="muted">на сегодня${state.group !== "all" ? ` · ${esc(state.group)}` : ""}${edited ? " · изменён" : ""} · всего ${fmt(all.length)}</div></div>
        <div class="oc-nums"><div><b class="num">${fmt(lines.length)}</b><span>поз.</span></div><div><b class="num">${fmt(lines.reduce((a, x) => a + x.final, 0))}</b><span>шт</span></div><div><b class="num">${cov.priced ? money(cov.value) : "—"}</b><span>${cov.priced ? (cov.missing ? "изв. цены" : "сумма") : "цен нет"}</span></div></div>
        ${ap ? `<span class="approved-badge"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>${esc(ap.at)}</span>` : ""}
        <div class="oc-actions">
          <button class="btn primary oc-btn" data-order="${k}" title="Отметить нужные товары галочками, найти и добавить любой товар">☑ Выбрать товары</button>
          <button class="btn share wa oc-ic" data-order="${k}" data-intent="wa" title="Отправить заказ в WhatsApp" aria-label="Отправить заказ ${esc(REAL_SUPS[k].name)} в WhatsApp"><svg viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1 1 8 19z"/></svg><span>WhatsApp</span></button>
          <button class="btn share tg oc-ic" data-order="${k}" data-intent="tg" title="Отправить заказ в Telegram" aria-label="Отправить заказ ${esc(REAL_SUPS[k].name)} в Telegram"><svg viewBox="0 0 24 24"><path d="M21 4L3 11l6 2 2 6 3-4 5 4z"/></svg><span>Telegram</span></button>
        </div>
      </div>`;
    }).join("")}</div>`;
  }

  function renderToday() {
    const base = baseRows();
    const orders = base.filter((x) => x.final > 0);
    const acts = orders.filter((x) => ST[x.r.status].rank <= 3).sort(Engine.actionCompare);
    const top = acts.slice(0, 10);
    // 1. статусы
    const order = ["now", "overdue", "today", "week", "later", "nodata"];
    const parts = order.map((k) => ({ k, l: ST[k].label, v: orders.filter((x) => x.r.status === k).length, c: ST_COLOR[k] }));
    // 2. поставщики
    const supRows = Object.keys(REAL_SUPS).filter((k) => state.sup === "all" || k === state.sup).map((k) => {
      const l = orders.filter((x) => x.s.sup === k);
      const crit = l.filter((x) => x.r.urgency === "critical").length;
      const cov = Engine.priceCoverage(l);
      return { k, n: l.length, crit, units: l.reduce((a, x) => a + x.final, 0), cov };
    });
    const supMax = Math.max(1, ...supRows.map((x) => x.n));
    // 3. группы
    const groups = {};
    orders.forEach((x) => { const g = (groups[x.s.g] ||= { crit: 0, other: 0 }); x.r.urgency === "critical" ? g.crit++ : g.other++; });
    const gl = Object.entries(groups).sort((a, b) => b[1].crit + b[1].other - (a[1].crit + a[1].other)).slice(0, 7);
    const gmax = Math.max(1, ...gl.map(([, g]) => g.crit + g.other));
    const legendCrit = `<div class="legend"><span><i style="width:10px;height:10px;background:var(--crit);border-radius:2px"></i>Критичные</span><span><i style="width:10px;height:10px;background:var(--series-1);border-radius:2px"></i>Остальные к заказу</span></div>`;
    $("#tab-today").innerHTML = `${supplierOrderCards(base)}<div class="dash">
      <div class="card"><h3>Статус позиций к заказу</h3><p class="c-desc">Когда нужно действовать · нажмите, чтобы открыть список</p>
        <div class="donut-wrap">${donut(parts, orders.length || 1)}
          <div class="dlegend">${parts.map((p) => `<button data-st="${p.k}"><i style="background:${p.c}"></i><span>${p.l}</span><b>${fmt(p.v)}</b></button>`).join("")}</div>
        </div></div>
      <div class="card"><h3>Когда размещать заказы</h3><p class="c-desc">Позиций по неделям до последнего безопасного дня</p>
        <div class="chart">${weekBars(orders.filter((x) => x.r.safeDay != null))}</div></div>
      <div class="card"><h3>Поставщики</h3><p class="c-desc">Позиций к заказу и сколько из них критичных</p>
        <div class="sup-bars">${supRows.map((x) => `<div class="sup-bar" data-tip="${esc(`<b>${REAL_SUPS[x.k].name}</b><br>К заказу: ${fmt(x.n)}<br>Критичных: ${fmt(x.crit)}<br>Штук: ${fmt(x.units)}`)}">
          <div class="sb-top"><b>${esc(REAL_SUPS[x.k].name)}</b><span class="num"><b>${fmt(x.n)}</b> поз.</span></div>
          <div class="sb-track" style="width:${Math.max(4, (x.n / supMax) * 100)}%"><i style="width:${x.n ? (x.crit / x.n) * 100 : 0}%;background:var(--crit)"></i><i style="flex:1;background:var(--series-1)"></i></div>
          <div class="sb-sub">${fmt(x.crit)} критичных · ${fmt(x.units)} шт · ${x.cov.priced ? `${money(x.cov.value)} по известным ценам` : "цен нет"}</div></div>`).join("")}</div>
        ${legendCrit}</div>
      <div class="card"><h3>Группы товаров</h3><p class="c-desc">Где больше всего позиций к заказу</p>
        ${gl.map(([name, g]) => `<div class="hbar" data-tip="${esc(`<b>${name}</b><br>Критичных: ${g.crit}<br>Остальных: ${g.other}`)}"><span>${esc(name)}</span>
          <div class="track">${g.crit ? `<i style="width:${(g.crit / gmax) * 100}%;background:var(--crit)"></i>` : ""}${g.other ? `<i style="width:${(g.other / gmax) * 100}%;background:var(--series-1)"></i>` : ""}</div>
          <span class="v">${fmt(g.crit + g.other)}</span></div>`).join("")}
        ${legendCrit}</div>
      <div class="card wide"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline"><h3>10 главных действий</h3><button class="btn sm" id="allActs">Все действия · ${fmt(acts.length)}</button></div>
        <p class="c-desc">Сначала просроченные и «дефицит сейчас», затем по дате окончания запаса</p>
        ${top.length ? `<div class="table-wrap"><table class="acts">
          <thead><tr><th>Статус</th><th>Товар</th><th class="r">Остаток</th><th>Закончится</th><th>Заказать до</th><th class="r">Заказ, шт</th></tr></thead>
          <tbody>${top.map((x) => `<tr data-id="${esc(x.s.id)}" tabindex="0">
            <td>${statusPill(x.r.status)}</td>
            <td><div class="p-name">${esc(x.s.n)}</div><div class="why">${esc(SUPS[x.s.sup].name)} · ${x.r.status === "now" ? "товара нет" : x.r.status === "overdue" ? `срок прошёл ${fmt(-x.r.safeDay)} дн назад` : ST[x.r.status].label.toLowerCase()}${x.r.expectedDeficit && x.r.deficitLead >= 1 ? ` · до прихода не хватит ≈ ${fmt(x.r.deficitLead)} шт` : ""}</div></td>
            <td class="r num">${fmt(x.r.stock)}</td>
            <td class="num">${fDay(x.r.stockoutDay)}</td>
            <td class="num"><b>${x.r.safeDay == null ? NA : x.r.status === "now" ? '<span style="color:var(--crit)">немедленно</span>' : x.r.safeDay < 0 ? `<span style="color:var(--crit)">просрочено ${fmt(-x.r.safeDay)} дн</span>` : x.r.safeDay === 0 ? "сегодня" : Engine.fmtDay(x.r.safeDay)}</b></td>
            <td class="r num"><b>${fmt(x.final)}</b></td>
          </tr>`).join("")}</tbody></table></div>` : `<div class="empty">Срочных действий нет.</div>`}
      </div></div>`;
    bindRows($("#tab-today"));
    bindTips($("#tab-today"));
    $$("#tab-today .hit2").forEach((h) => { h.addEventListener("mousemove", (e) => { const t = $("#tip"); t.innerHTML = h.dataset.tip; t.hidden = false; t.style.left = e.clientX + 14 + "px"; t.style.top = e.clientY + 14 + "px"; }); h.addEventListener("mouseleave", () => ($("#tip").hidden = true)); });
    $$("#tab-today [data-st]").forEach((b) => (b.onclick = () => setFilter({ urg: "all", st: b.dataset.st, win: null, onlyOrder: true, sort: "action" })));
    $("#allActs")?.addEventListener("click", () => setFilter({ urg: "all", st: "all", win: null, onlyOrder: true, sort: "action" }));
    $$("#tab-today [data-order]").forEach((b) => (b.onclick = () => { openOrderSheet(b.dataset.order, "today"); if (b.dataset.intent) highlightSend(b.dataset.intent); }));
  }
  function bindRows(root) {
    $$("tr[data-id]", root).forEach((tr) => {
      tr.addEventListener("click", (e) => { if (!e.target.closest("input")) openDrawer(tr.dataset.id); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.target.closest("input")) openDrawer(tr.dataset.id); });
    });
  }

  function setFilter(f) {
    state.deficitOnly = false;
    state.stSet = null;
    Object.assign(state, f);
    $("#onlyOrder").checked = state.onlyOrder;
    $("#statusSel").value = state.st;
    $("#sortSel").value = state.sort;
    switchTab("orders");
    render();
  }

  // ---------------- orders tab ----------------
  function renderFilters() {
    const list = visible(true);
    const counts = { all: list.length, critical: 0, soon: 0, planned: 0, ok: 0 };
    list.forEach((x) => counts[x.r.urgency]++);
    const chips = [["all", "Все"], ["critical", URG.critical.label], ["soon", URG.soon.label], ["planned", URG.planned.label]];
    if (!state.onlyOrder || state.urg === "ok") chips.push(["ok", URG.ok.label]);
    $("#urgChips").innerHTML = chips.map(([k, l]) => `
      <button class="chip ${state.urg === k ? "active" : ""}" data-u="${k}">
        ${k !== "all" ? `<span class="dot" style="background:var(--${k === "critical" ? "crit" : k === "soon" ? "warn" : k === "planned" ? "plan" : "good"})"></span>` : ""}
        ${l} <b>${fmt(counts[k])}</b></button>`).join("");
    if (state.stSet) {
      $("#urgChips").insertAdjacentHTML("beforeend", `<button class="chip active" id="stSetChip">Статус: ${state.stSet.map((k) => ST[k].label.toLowerCase()).join(" и ")} ✕</button>`);
      $("#stSetChip").addEventListener("click", () => { state.stSet = null; render(); });
    }
    if (state.deficitOnly) {
      $("#urgChips").insertAdjacentHTML("beforeend", `<button class="chip active" id="defChip">Ожидаемый дефицит ✕</button>`);
      $("#defChip").addEventListener("click", () => { state.deficitOnly = false; render(); });
    }
    if (state.win) {
      const w = WINDOWS.find((x) => x.k === state.win);
      $("#urgChips").insertAdjacentHTML("beforeend", `<button class="chip active" id="winChip">Заказать: ${w.label.toLowerCase()} ✕</button>`);
      $("#winChip").addEventListener("click", () => { state.win = null; render(); });
    }
    $$("#urgChips .chip[data-u]").forEach((el) => el.addEventListener("click", () => { state.urg = el.dataset.u; render(); }));
  }

  function renderOrders() {
    const list = sorted(visible());
    const bySup = {};
    list.forEach((x) => (bySup[x.s.sup] ||= []).push(x));
    const keys = Object.keys(SUPS).filter((k) => bySup[k]);
    if (!keys.length) {
      $("#orders").innerHTML = `<div class="sup-block"><div class="empty">Нет позиций по выбранным фильтрам</div></div>`;
      return;
    }
    $("#orders").innerHTML = keys.map((k) => supBlock(k, bySup[k])).join("");
    bindOrders();
  }

  function supBlock(k, list) {
    const all = rows.filter((x) => x.s.sup === k && x.final > 0);
    const val = all.reduce((a, x) => a + x.value, 0);
    const units = all.reduce((a, x) => a + x.final, 0);
    const ap = state.approved[k];
    const lim = state.limit[k] || 60;
    const shown = list.slice(0, lim);
    return `
    <div class="sup-block" data-sup="${k}">
      <div class="sup-head">
        <div class="sup-title">${esc(SUPS[k].name)}</div>
        <div class="sup-stats">
          <span>Позиций к заказу: <b class="num">${fmt(all.length)}</b></span>
          <span>Штук: <b class="num">${fmt(units)}</b></span>
          ${val ? `<span>Сумма: <b class="num">${money(val)}</b></span>` : ""}
          <span>Срок поставки: <b>${months(state.p.lead[k])}</b></span>
        </div>
        <div class="sup-actions">
          ${ap ? `<span class="approved-badge"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>Отмечен как согласованный · ${esc(ap.at)} · на этом устройстве</span>
                  <button class="btn sm" data-unapprove="${k}">Изменить</button>`
               : `<button class="btn sm success" data-approve="${k}">Проверить и отправить заказ</button>`}
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Статус</th><th>Товар и обоснование</th>
          <th class="r">Остаток</th><th class="r hide-sm">В пути</th><th class="r hide-sm">Спрос/мес</th>
          <th>Заказать до</th><th class="r">Заказ, шт</th><th class="r hide-sm">Сумма</th>
        </tr></thead>
        <tbody>${shown.map((x) => rowHtml(x, !!ap)).join("")}</tbody>
      </table></div>
      ${list.length > lim ? `<button class="more" data-more="${k}">Показать ещё ${fmt(Math.min(60, list.length - lim))} из ${fmt(list.length - lim)}</button>` : ""}
    </div>`;
  }

  function rowHtml({ s, r, final, value }, locked) {
    const edited = state.overrides[s.id] != null;
    const b = state.alloc && state.alloc.mark[s.id];
    const badge = b ? `<div><span class="badge ${b}">${b === "in" ? "в бюджете" : b === "out" ? "не поместилось" : "нет цены"}</span></div>` : "";
    return `<tr data-id="${esc(s.id)}" tabindex="0">
      <td>${statusPill(r.status)}<div class="urg-small">срочность: ${URG[r.urgency].label.toLowerCase()}</div></td>
      <td>
        <div class="p-name">${esc(s.n)}</div>
        <div class="p-meta"><span>${esc(s.id)}</span>${s.art ? `<span>${esc(s.art)}</span>` : ""}<span>${esc(s.g)}</span><span class="abc" title="ABC: частота спроса">${s.abc}</span></div>
        <div class="why">${esc(shortWhy(s, r))}</div>
      </td>
      <td class="r num">${fmt(r.stock)}</td>
      <td class="r num hide-sm">${r.transit ? fmt(r.transit) : '<span class="muted">—</span>'}</td>
      <td class="r num hide-sm">${fmt(r.monthly, r.monthly < 10 ? 1 : 0)}</td>
      <td>${orderByCell(r)}</td>
      <td class="r">
        <input class="qty-input ${edited ? "edited" : ""}" type="number" min="0" step="${s.moq}" value="${final}" data-qty="${esc(s.id)}" ${locked ? "disabled" : ""} aria-label="Количество к заказу">
        ${edited ? `<div class="rec-hint">расчёт: ${fmt(r.qty)}</div>` : s.moq > 1 ? `<div class="rec-hint">кратно ${fmt(s.moq)}</div>` : ""}${badge}
      </td>
      <td class="r num hide-sm">${Engine.hasPrice(s) ? (final > 0 ? money(value) : "0 ₸") : NA}</td>
    </tr>`;
  }

  function orderByCell(r) {
    const sd = r.safeDay, out = r.stockoutDay;
    if (r.status === "nodata") return `<div class="ob">${NA}</div><div class="ob-sub">мало истории продаж</div>`;
    const outTxt = out == null ? "запаса хватит > 6 мес" : `${r.expectedDeficit ? "дефицит с" : "закончится"} ${dayDate(out)}`;
    if (sd == null) return `<div class="ob ok">Не нужно</div><div class="ob-sub">${outTxt}</div>`;
    const cls = sd < 0 || r.status === "now" ? "crit" : sd <= 7 ? "warn" : "plan";
    const main = r.status === "now" ? "Немедленно" : sd < 0 ? "Просрочено" : sd === 0 ? "Сегодня" : dayDate(sd);
    return `<div class="ob ${cls}">${main}</div><div class="ob-sub">${sd > 0 ? inDays(sd) + " · " : sd < 0 && r.status !== "now" ? `на ${fmt(-sd)} дн · ` : ""}${r.status === "now" ? "товара нет на складе" : outTxt}</div>`;
  }

  function shortWhy(s, r) {
    const p = state.p;
    const bits = [`спрос ${fmt(r.level, r.level < 10 ? 1 : 0)}/мес`];
    if (p.season && r.level > 0 && Math.abs(r.seasonMult - 1) >= 0.05) bits.push(`сезон ×${r.seasonMult.toFixed(2)}`);
    if (p.trend && Math.abs(r.growth) >= 0.05) bits.push(`тренд ${r.growth > 0 ? "+" : ""}${Math.round(r.growth * 100)}%`);
    if (p.oneoff && s.oo.length) bits.push(`без ${s.oo.length} разов. заказ.`);
    if (p.restore && r.lost > 0.5) bits.push(`+${fmt(r.lost)} упущенный спрос`);
    bits.push(`страх. запас ${fmt(r.safety)}`);
    if (r.transit) bits.push(`в пути ${fmt(r.transit)}`);
    return bits.join(" · ");
  }

  function bindOrders() {
    bindRows($("#orders"));
    $$("#orders [data-qty]").forEach((inp) => {
      inp.addEventListener("click", (e) => e.stopPropagation());
      inp.addEventListener("change", () => {
        const id = inp.dataset.qty;
        const row = rows.find((x) => x.s.id === id);
        const v = Math.max(0, Math.round(+inp.value || 0));
        if (v === row.r.qty) delete state.overrides[id]; else state.overrides[id] = v;
        store.set("overrides", state.overrides);
        recompute(); render();
        toast("Количество изменено — будет в экспорте");
      });
    });
    $$("[data-more]").forEach((b) => b.addEventListener("click", () => { state.limit[b.dataset.more] = (state.limit[b.dataset.more] || 60) + 60; renderOrders(); }));
    $$("[data-approve]").forEach((b) => b.addEventListener("click", () => openOrderSheet(b.dataset.approve, "all")));
    $$("[data-unapprove]").forEach((b) => b.addEventListener("click", () => {
      delete state.approved[b.dataset.unapprove]; store.set("approved", state.approved); render();
    }));
  }

  // ---------------- approve & export ----------------
  function approveModal(k) {
    const lines = rows.filter((x) => x.s.sup === k && x.final > 0);
    const val = lines.reduce((a, x) => a + x.value, 0);
    const crit = lines.filter((x) => x.r.urgency === "critical").length;
    const edited = lines.filter((x) => state.overrides[x.s.id] != null).length;
    const m = $("#modal");
    m.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true">
      <h3>Отметить заказ ${esc(SUPS[k].name)} как согласованный?</h3>
      <p>Отметка сохраняется <b>только на этом устройстве</b> (в браузере) и может исчезнуть при очистке данных браузера — это не журнал согласований. Будет выгружен Excel для проверки и последующего импорта в учётную систему. Поставщику заказ <b>не отправляется</b> — это делает менеджер.</p>
      <div class="list">
        <div class="list-row"><span>Позиций</span><b class="num">${fmt(lines.length)}</b></div>
        <div class="list-row"><span>Штук</span><b class="num">${fmt(lines.reduce((a, x) => a + x.final, 0))}</b></div>
        ${val ? `<div class="list-row"><span>Сумма по себестоимости</span><b class="num">${money(val)}</b></div>` : ""}
        <div class="list-row"><span>Из них критичных</span><b class="num">${fmt(crit)}</b></div>
        <div class="list-row"><span>Изменено вручную</span><b class="num">${fmt(edited)}</b></div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-close>Отмена</button>
        <button class="btn success" data-ok>Отметить и выгрузить Excel</button>
      </div></div>`;
    m.hidden = false;
    $("[data-close]", m).onclick = () => (m.hidden = true);
    m.onclick = (e) => { if (e.target === m) m.hidden = true; };
    $("[data-ok]", m).onclick = () => {
      const d = new Date();
      state.approved[k] = { at: d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) };
      store.set("approved", state.approved);
      m.hidden = true;
      render();
      exportXlsx([k]);
      toast(`Заказ ${SUPS[k].name} отмечен на этом устройстве, Excel выгружен. Поставщику ничего не отправлено`);
    };
  }

  /** Книга Excel: лист на поставщика + «Параметры». pick(k) — строки заказа поставщика k. */
  function buildWorkbook(keys, pick = (k) => rows.filter((x) => x.s.sup === k && x.final > 0), statusText = null) {
    const wb = XLSX.utils.book_new();
    const ctx = {
      supName: (k) => SUPS[k].name, urgLabel: (u) => URG[u].label,
      approval: (k) => statusText || (state.approved[k] ? `Отмечен как согласованный на этом устройстве ${state.approved[k].at}, не отправлен поставщику` : "Черновик, не отправлен"),
    };
    keys.forEach((k) => {
      const lines = pick(k).slice().sort(Engine.actionCompare);
      const data = Engine.exportRows(lines, state.p, ctx);
      const ws = XLSX.utils.json_to_sheet(data);
      // коды 1С и артикулы — текст, чтобы Excel не срезал ведущие нули
      const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
      for (let R = 1; R <= range.e.r; R++) [1, 2].forEach((C) => {
        const c = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (c) { c.t = "s"; c.v = String(c.v); c.z = "@"; }
      });
      ws["!cols"] = [16, 13, 18, 50, 5, 9, 10, 10, 10, 12, 12, 16, 12, 11, 11, 9, 12, 13, 11, 90, 28].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, SUPS[k].name.slice(0, 31));
    });
    // лист «Параметры»: с какими данными и настройками получен заказ
    const cov = Engine.priceCoverage(keys.flatMap((k) => pick(k)));
    const sc = SCN[state.p.scenario];
    const info = [
      ["Сервис", "Умный Закуп — расчёт заказов поставщикам"],
      ["Дата выгрузки данных", META.asOf.split("-").reverse().join(".")],
      ["Дата формирования файла", new Date().toLocaleString("ru-RU")],
      ["Поставщики", keys.map((k) => SUPS[k].name).join(", ")],
      ["Сценарий", `${sc.label}: ${sc.note}`],
      ...keys.map((k) => [`Срок поставки ${SUPS[k].name}, дн`, Math.round(state.p.lead[k] * 30)]),
      ["Согласование заказа, дн", state.p.buffer],
      ["Период пересмотра, дн", Math.round(state.p.review * 30)],
      ["Прогноз прироста рынка, %", Math.round(state.p.growth * 100)],
      ["Факторы расчёта", [["oneoff", "разовые заказы"], ["restore", "восстановление спроса"], ["season", "сезонность"], ["trend", "тренд"], ["transit", "товар в пути"]].map(([k, l]) => `${l}: ${state.p[k] ? "вкл" : "выкл"}`).join("; ")],
      ["Строк к заказу", cov.lines],
      ["Строк с известной ценой", `${cov.priced} (${cov.share == null ? "—" : Math.round(cov.share * 100) + "%"})`],
      ["Стоимость по известным ценам, ₸", Math.round(cov.value)],
      ["Внимание", "Стоимость неполная: у части позиций нет цены (в файле — «Нет данных», а не 0)."],
      ["Статус", statusText || "Файл подготовлен для проверки и последующего импорта. Поставщику ничего не отправлено."],
    ];
    const wsInfo = XLSX.utils.aoa_to_sheet([["Параметр", "Значение"], ...info]);
    wsInfo["!cols"] = [{ wch: 34 }, { wch: 110 }];
    XLSX.utils.book_append_sheet(wb, wsInfo, "Параметры");
    return wb;
  }
  /** Выгрузка для загрузки в 1С: CSV с разделителем «;», UTF-8 с BOM (открывается в Excel и загружается
   *  обработкой 1С «Загрузка из табличного документа»). Коды 1С и артикулы — как текст. */
  function csv1c(k, lines) {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Код 1С", "Артикул", "Наименование", "Количество", "Ед.", "Цена", "Сумма", "Поставщик"];
    const body = lines.map((x) => [x.s.id, x.s.art || "", x.s.n, x.final, "шт",
      Engine.hasPrice(x.s) ? String(x.s.pr).replace(".", ",") : "", Engine.hasPrice(x.s) ? String(Math.round(x.final * x.s.pr * 100) / 100).replace(".", ",") : "", SUPS[k].name]);
    const text = "\ufeff" + [head, ...body].map((r) => r.map(q).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `Заказ_${SUPS[k].name.replace(/\s+/g, "_")}_${META.asOf}_для_1С.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportXlsx(keys = Object.keys(REAL_SUPS).filter((k) => state.sup === "all" || k === state.sup)) {
    if (!window.XLSX) { toast("Библиотека Excel не загрузилась"); return; }
    XLSX.writeFile(buildWorkbook(keys), `Заказ_поставщикам_${META.asOf}_${SCN[state.p.scenario].label}.xlsx`);
  }

  // ---------------- drawer ----------------
  let openId = null;
  function openDrawer(id, keepScroll = false) {
    const row = id === SB_ID ? sandboxRow() : rows.find((x) => x.s.id === id);
    if (!row) return;
    openId = id;
    const { s, r } = row;
    const d = $("#drawer");
    const scroll = d.scrollTop;
    const p = state.p;
    const priced = Engine.hasPrice(s);
    const trList = s.tr.length ? s.tr.map((t) => `${esc(t[0])}: ${fmt(t[1])} шт · ${t[2] ? "приход до " + Engine.fmtDay(Engine.dayOf(t[2])) : "<b>без даты — не учтено</b>"}`).join("<br>") : "нет";
    const dq = [
      priced ? "цена есть" : "нет цены",
      s.mq ? "кратность из файла" : "кратность не задана (принята 1)",
      `история ${s.nh ?? "?"} мес`,
      s.rt ? `возвраты: ${s.rt}` : null,
      r.transitNoEta ? "в пути без даты" : null,
      s.av ? `stockout: ${s.av.filter((a) => a < 1).length} мес` : null,
    ].filter(Boolean).join(" · ");
    const fact = (l, v, sub = "", cls = "") => `<div class="fact ${cls}"><div class="f-l">${l}</div><div class="f-v">${v}</div>${sub ? `<div class="f-s">${sub}</div>` : ""}</div>`;
    d.innerHTML = `
      <div class="d-head">
        <div>
          <div style="margin-bottom:6px;display:flex;gap:6px;flex-wrap:wrap">${statusPill(r.status)}${pill(r.urgency)}<span class="scen-tag">Сценарий: ${SCN[p.scenario].label}</span></div>
          <h2>${esc(s.n)}</h2>
          <div class="p-meta">${s.id === SB_ID ? "<span>Данные введены вручную на вкладке «Проверить расчёт»</span>" : `<span>Код 1С ${esc(s.id)}</span>`}${s.art ? `<span>Арт. ${esc(s.art)}</span>` : ""}<span>${esc(supName(s.sup))}</span><span>${esc(s.g)}</span><span>ABC: ${s.abc}${s.pc ? ` · кат. партнёра ${esc(s.pc)}` : ""}</span></div>
        </div>
        <button class="d-close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="d-body">
        ${heroSay(s, r, row)}
        <div class="facts">
          ${fact("Закончится", fDay(r.stockoutDay), r.stockoutDay == null ? (r.status === "nodata" ? "мало истории" : "не раньше чем через 6 мес") : inDays(r.stockoutDay), r.status === "now" || r.expectedDeficit ? "crit" : "")}
          ${fact("Последний безопасный день", r.safeDay == null ? NA : r.status === "now" ? "Немедленно" : r.safeDay < 0 ? "Просрочено" : Engine.fmtDay(r.safeDay), r.safeDay == null ? (r.status === "nodata" ? "мало истории" : "заказ пока не нужен") : r.status === "now" ? "товара уже нет" : r.safeDay < 0 ? `на ${fmt(-r.safeDay)} дн` : inDays(r.safeDay), r.safeDay != null && r.safeDay < 0 ? "crit" : "")}
          ${fact("Приход, если заказать сегодня", Engine.fmtDay(r.arrivalDay), `${p.buffer} дн согласования + ${r.leadDays} дн поставки`)}
          ${fact("Дефицит до прихода", r.status === "nodata" ? NA : `${fmt(r.deficitLead)} шт`, r.deficitLead >= 1 ? "расчётный неудовлетворённый спрос, если не будет срочной поставки" : "дефицита нет", r.deficitLead >= 1 ? "crit" : "")}
          ${fact("Дней запаса", r.stockoutDay == null ? (r.status === "nodata" ? NA : "> 180") : fmt(r.stockoutDay), "с учётом товара в пути по датам")}
          ${fact("Рекомендуемый заказ", `${fmt(row.final)} шт`, `${state.overrides[s.id] != null ? `расчёт ${fmt(r.qty)} · изменено вручную` : `потребность ${fmt(Math.max(r.need, 0))} → кратно ${fmt(r.moq)}`}${priced ? ` · ${money(row.final * s.pr)}` : " · цена: нет данных"}`, "main")}
          ${fact("Текущий остаток", `${fmt(r.stock)} шт`, s.wh ? Object.entries(s.wh).map(([k, v]) => `${esc(k)}: ${fmt(v)}`).join(" · ") : `на ${META.asOf.split("-").reverse().join(".")}`)}
          ${fact("Товар в пути", `${fmt(r.transit + r.transitNoEta + r.transitLate)} шт`, trList)}
          ${fact("Качество данных", s.nh >= META.minHistory && priced ? "Полные" : "Неполные", dq)}
        </div>

        <div class="d-sec"><h4>Почему именно так</h4><p class="say">${esc(Engine.explain(s, r, p))}</p>${factorTable(s, r, row)}</div>

        <div class="d-sec"><h4>Календарь остатка на 6 месяцев</h4>${stockChart(s, r, row.final)}</div>

        <div class="d-sec"><h4>История спроса и прогноз</h4>${demandChart(s, r)}</div>

        <div class="d-sec"><h4>Как посчитано</h4>
          <div class="calc">
            ${calcRow("", `Прогноз спроса на ${fmt(r.H, 1)} мес.`, `срок поставки ${months(r.L)} + пересмотр ${months(p.review)}${p.season ? `, сезонность ×${r.seasonMult.toFixed(2)}` : ""}${p.trend && r.growth ? `, тренд ${r.growth > 0 ? "+" : ""}${Math.round(r.growth * 100)}%` : ""}`, r.demandH)}
            ${calcRow("+", "Страховой запас", `z = ${r.z} (категория ${s.abc}) × σ ${fmt(r.sd, 1)} × √${fmt(r.H, 1)}`, r.safety)}
            ${calcRow("−", "Остаток на складе", s.wh ? Object.entries(s.wh).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ") : `на ${META.asOf.split("-").reverse().join(".")}`, r.stock)}
            ${calcRow("−", "Подтверждённый товар в пути", p.transit ? (r.transitNoEta ? `без даты прихода ${fmt(r.transitNoEta)} шт не учтено` : "с датой прихода в пределах горизонта") : "не учитывается", r.transit)}
            ${calcRow("=", "Потребность", "", r.need)}
            <div class="calc-row total"><span class="op">→</span><div><div>Заказ с учётом кратности ${fmt(s.moq)}</div>${state.overrides[s.id] != null ? `<div class="c-sub">изменено вручную, расчёт: ${fmt(r.qty)}</div>` : ""}</div><div class="c-val">${fmt(row.final)} шт</div></div>
          </div>
        </div>

        ${s.oo.length ? `<div class="d-sec"><h4>Исключённые разовые заказы</h4><div class="list">
          ${s.oo.map((o) => `<div class="list-row"><span>${o[1] ? `Накладная ${esc(o[1])} от ` : "Накладная от "}${esc(o[2])}</span><span><b class="num">${fmt(o[3])} шт</b> <span class="muted">· обычно ${fmt(o[4])} шт</span></span></div>`).join("")}
        </div></div>` : ""}

        ${s.cap ? `<div class="d-sec"><h4>Сглаженные всплески продаж</h4><div class="list">
          ${s.cap.map((i) => `<div class="list-row"><span>${META.months[i]}</span><span>продано ${fmt(s.raw[i])} → в расчёте <b class="num">${fmt(s.cln[i])}</b> <span class="muted">(фильтр Хампеля)</span></span></div>`).join("")}
        </div></div>` : ""}

        ${s.av ? `<div class="d-sec"><h4>Периоды отсутствия товара</h4><div class="list">
          ${s.av.map((a, i) => (a < 1 ? `<div class="list-row"><span>${META.months[i]}</span><span>${a <= 0.1 ? "не было весь месяц" : a < 0.6 ? "большую часть месяца" : "часть месяца"} · продано ${fmt(s.raw[i])} · после очистки ${fmt(s.cln[i])} → восстановлено <b class="num">${fmt(s.rst[i])}</b></span></div>` : "")).join("")}
        </div></div>` : ""}

      </div>`;
    $(".d-close", d).onclick = closeDrawer;
    bindChart(d);
    bindStock(d);
    d.classList.add("open");
    d.setAttribute("aria-hidden", "false");
    $("#scrim").hidden = false;
    if (keepScroll) d.scrollTop = scroll; else { d.scrollTop = 0; d.focus({ preventScroll: true }); }
  }
  function closeDrawer() {
    openId = null;
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#scrim").hidden = true;
  }
  /** Главный ответ по товару одной фразой: сколько и когда заказать и что будет с запасом. */
  function heroSay(s, r, row) {
    if (r.status === "nodata") return `<div class="hero-say none"><b class="big">Недостаточно данных для прогноза.</b><br>Истории продаж меньше ${META.minHistory} месяцев — решение принимает менеджер.</div>`;
    const q = row.final;
    const arr = Engine.fmtDay(r.arrivalDay);
    const gap = r.stockoutDay != null ? r.arrivalDay - r.stockoutDay : 0;
    if (!(q > 0)) {
      return `<div class="hero-say"><b class="big">Заказ не нужен.</b><br>${r.stockoutDay == null ? "Запаса хватит больше чем на 6 месяцев." : `Запаса хватит до ${Engine.fmtDay(r.stockoutDay)}; вернитесь к товару до ${Engine.fmtDay(Math.max(r.safeDay ?? 0, 0))}.`}</div>`;
    }
    const when = r.status === "now" || (r.safeDay != null && r.safeDay <= 0) ? "сегодня" : `до ${Engine.fmtDay(r.safeDay)}`;
    let tail;
    if (r.status === "now") tail = `Товара нет уже сейчас. Заказ, размещённый сегодня, придёт ${arr}${r.deficitLead >= 1 ? ` — до этого не будет удовлетворено ≈ ${fmt(r.deficitLead)} шт спроса` : ""}.`;
    else if (r.expectedDeficit) tail = `Товар закончится ${Engine.fmtDay(r.stockoutDay)}, заказ придёт ${arr}: ${fmt(gap)} ${gap === 1 ? "день" : "дн"} без товара, ≈ ${fmt(r.deficitLead)} шт спроса.`;
    else if (r.stockoutDay != null) tail = `Товар закончится ${Engine.fmtDay(r.stockoutDay)}; если заказать ${when}, поставка придёт вовремя.`;
    else tail = "Запаса хватит надолго, заказ поддерживает страховой уровень.";
    const tone = r.status === "now" || r.expectedDeficit ? "crit" : r.safeDay != null && r.safeDay <= 7 ? "warn" : "";
    return `<div class="hero-say ${tone}"><b class="big">Заказать ${fmt(q)} шт ${when}.</b><br>${tail}</div>`;
  }
  const calcRow = (op, title, sub, val) => `<div class="calc-row"><span class="op">${op}</span><div><div>${title}</div>${sub ? `<div class="c-sub">${esc(sub)}</div>` : ""}</div><div class="c-val">${fmt(val)}</div></div>`;

  /** Вклад каждого фактора в штуках. Для алгоритмических факторов — разница заказа
   *  «с фактором» и «без него»; для остатка, товара в пути, страхового запаса и MOQ — прямое слагаемое. */
  function factorTable(s, r, row) {
    const p = state.p;
    const sens = Engine.sensitivity(s, p);
    const d = (k) => (p[k] ? -sens[k] : null);
    const sign = (v) => (v == null ? '<span class="muted">выкл.</span>' : v === 0 ? "0" : `${v > 0 ? "+" : "−"}${fmt(Math.abs(v))} шт`);
    const items = [
      ["Сезонность", d("season"), p.season && r.level > 0 ? `коэффициент на горизонте ×${r.seasonMult.toFixed(2)}` : ""],
      ["Тренд", d("trend"), p.trend ? `${r.growth >= 0 ? "+" : ""}${Math.round(r.growth * 100)}% год к году (ограничен −30…+50%)` : ""],
      ["Восстановленный спрос при stockout", d("restore"), r.lost > 0.5 ? `+${fmt(r.lost)} шт спроса за 12 мес` : "дефицита в истории не было"],
      ["Исключённые разовые продажи и всплески", d("oneoff"), s.oo.length ? `${s.oo.length} накладных, ${fmt(r.oneoffQty)} шт` : s.cap ? `${s.cap.length} мес. сглажено` : "не найдено"],
      ["Текущий остаток", -r.stock, "вычитается из потребности"],
      ["Подтверждённый товар в пути", p.transit ? -r.transit : null, r.transitNoEta ? `ещё ${fmt(r.transitNoEta)} шт без даты не учтено` : ""],
      ["Страховой запас", Math.round(r.safety), `z ${r.z} × σ ${fmt(r.sd, 1)} × √${fmt(r.H, 1)} (категория ${s.abc})`],
      ["Округление до MOQ", r.qty > 0 ? Math.round(r.qty - r.need) : 0, `кратность ${fmt(r.moq)}${s.mq ? "" : " (нет в файле — принята 1)"}`],
    ];
    return `<table class="ftable">${items.map(([l, v, n]) => `<tr><td>${l}<div class="n">${esc(n)}</div></td><td class="v">${sign(v)}</td></tr>`).join("")}
      <tr><td><b>Рекомендуемый заказ</b><div class="n">сценарий «${SCN[p.scenario].label}»</div></td><td class="v"><b>${fmt(r.qty)} шт</b></td></tr></table>`;
  }

  // ---------------- charts ----------------
  function demandChart(s, r) {
    const p = state.p;
    const n = s.raw.length;
    const reg = p.oneoff ? (p.restore ? s.rst : s.cln) : s.raw.map((v, i) => (p.restore ? Math.max(v, s.rst[i] - s.cln[i] + v) : v));
    const fc = [];
    const seen = {};
    r.forecast.forEach((x) => { const k = x.am; seen[k] = (seen[k] || 0) + x.q / x.f * x.f; fc.push(x); });
    // прогноз помесячно (полный месяц)
    const fcMonths = [];
    const [Y, M] = META.asOf.split("-").map(Number);
    for (let i = 0; i < 6; i++) {
      const am = Y * 12 + M - 1 + i;
      const x = r.forecast.find((f) => f.am === am);
      fcMonths.push({ am, q: x ? x.q / x.f : 0 });
    }
    const N = n + fcMonths.length;
    const W = 680, H = 230, pl = 44, pr = 10, pt = 12, pb = 26;
    const iw = W - pl - pr, ih = H - pt - pb;
    const oo = {};
    s.oo.forEach((o) => { oo[o[0]] = (oo[o[0]] || 0) + o[3]; });
    const vals = [...s.raw, ...reg, ...fcMonths.map((x) => x.q)];
    let max = Math.max(1, ...vals);
    // если разовый заказ огромен — не даём ему сплющить график
    const regMax = Math.max(1, ...reg, ...fcMonths.map((x) => x.q));
    const clipped = max > regMax * 3;
    if (clipped) max = regMax * 2.2;
    const nice = niceMax(max);
    const x = (i) => pl + (i + 0.5) * (iw / N);
    const y = (v) => pt + ih - (Math.min(v, nice) / nice) * ih;
    const bw = Math.max(3, iw / N - 4);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="График спроса по месяцам">
      <defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--crit)" stroke-width="1.5" opacity=".35"/></pattern></defs>
      <g class="grid">`;
    for (let k = 0; k <= 4; k++) {
      const v = (nice / 4) * k;
      svg += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text x="${pl - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">${short(v)}</text>`;
    }
    svg += `</g>`;
    // stockout
    if (s.av) s.av.forEach((a, i) => { if (a < 1) svg += `<rect x="${x(i) - iw / N / 2}" y="${pt}" width="${iw / N}" height="${ih}" fill="url(#hatch)"/>`; });
    // прогнозная зона
    svg += `<rect x="${x(n) - iw / N / 2}" y="${pt}" width="${(iw / N) * fcMonths.length}" height="${ih}" fill="var(--accent-soft)" opacity=".6"/>`;
    svg += `<text x="${x(n) - iw / N / 2 + 6}" y="${pt + 12}" font-size="10" fill="var(--accent-ink)" font-weight="600">прогноз</text>`;
    // bars
    s.raw.forEach((v, i) => {
      if (v <= 0) return;
      const top = y(v), h = pt + ih - top;
      svg += `<path d="${roundTop(x(i) - bw / 2, top, bw, h, Math.min(3, bw / 2))}" fill="var(--bar)"/>`;
      if (v > nice) svg += `<text x="${x(i)}" y="${pt - 2}" text-anchor="middle" font-size="9" fill="var(--text-3)">↑</text>`;
    });
    // one-off markers
    Object.entries(oo).forEach(([i, q]) => {
      svg += `<circle cx="${x(+i)}" cy="${y(s.raw[+i]) - 7}" r="4.5" fill="var(--series-2)" stroke="var(--surface)" stroke-width="2"/>`;
    });
    // regular line
    const pts = reg.map((v, i) => [x(i), y(v)]);
    // очищенный ряд показываем отдельно там, где восстановление его подняло
    const showClean = p.oneoff && p.restore && s.av && s.cln.some((v, i) => s.rst[i] - v > 0.5);
    if (showClean) svg += `<path d="${line(s.cln.map((v, i) => [x(i), y(v)]))}" fill="none" stroke="var(--text-3)" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    svg += `<path d="${line(pts)}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    const fpts = [[x(n - 1), y(reg[n - 1])], ...fcMonths.map((f, j) => [x(n + j), y(f.q)])];
    svg += `<path d="${line(fpts)}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-dasharray="5 4" stroke-linecap="round"/>`;
    fcMonths.forEach((f, j) => { svg += `<circle cx="${x(n + j)}" cy="${y(f.q)}" r="3" fill="var(--surface)" stroke="var(--series-1)" stroke-width="2"/>`; });
    // axis labels
    const labels = [...META.months, ...fcMonths.map((f) => `${MON[f.am % 12]} ${String(Math.floor(f.am / 12)).slice(2)}`)];
    labels.forEach((l, i) => {
      if (i % 3 === 0) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-3)">${l}</text>`;
    });
    // hover targets
    labels.forEach((l, i) => {
      const tip = i < n
        ? `<b>${l}</b><br>Фактические продажи: ${fmt(s.raw[i])}<br>После очистки: ${fmt(s.cln[i])}${p.restore && s.rst[i] - s.cln[i] > 0.5 ? `<br>Восстановленный спрос: ${fmt(s.rst[i])} (+${fmt(s.rst[i] - s.cln[i])})` : ""}${oo[i] ? `<br><span style="color:#f59a70">● Разовый заказ ${fmt(oo[i])} шт — исключён</span>` : ""}${s.av && s.av[i] < 1 ? `<br><span style="color:#f08a8a">Товара не было — спрос восстановлен</span>` : ""}`
        : `<b>${l} · прогноз</b><br>${fmt(fcMonths[i - n].q)} шт`;
      svg += `<rect class="hit" x="${x(i) - iw / N / 2}" y="${pt}" width="${iw / N}" height="${ih}" fill="transparent" data-tip="${esc(tip)}"/>`;
    });
    svg += `</svg>`;
    return `<div class="chart">${svg}</div>
      <div class="legend">
        <span><i style="width:10px;height:10px;background:var(--bar);border-radius:2px"></i>Фактические продажи</span>
        <span><i style="width:16px;height:2px;background:var(--series-1)"></i>${p.restore && s.av ? "Регулярный спрос (с восстановлением)" : "Регулярный спрос (после очистки)"}</span>
        ${p.oneoff && p.restore && s.av && s.cln.some((v, i) => s.rst[i] - v > 0.5) ? `<span><i style="width:16px;height:0;border-top:2px dashed var(--text-3)"></i>После очистки, до восстановления</span>` : ""}
        <span><i style="width:16px;height:0;border-top:2px dashed var(--series-1)"></i>Прогноз</span>
        ${s.oo.length ? `<span><i style="width:9px;height:9px;border-radius:50%;background:var(--series-2)"></i>Разовый заказ (исключён)</span>` : ""}
        ${s.av ? `<span><i style="width:12px;height:12px;background:url(#hatch);background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--crit) 35%,transparent) 0 1.5px,transparent 1.5px 4px)"></i>Нет товара на складе</span>` : ""}
        ${clipped ? `<span class="muted">↑ — столбец выше шкалы</span>` : ""}
      </div>`;
  }
  function stockChart(s, r, orderQty) {
    if (r.status === "nodata") return `<div class="empty-state">Недостаточно истории продаж, чтобы построить календарь остатка. Нужны продажи хотя бы за ${META.minHistory} месяца.</div>`;
    const pr = Engine.projection(s, state.p, orderQty, r);
    const pts = pr.pts;
    const N = pts.length - 1;
    const W = 680, H = 240, pl = 44, prr = 12, pt = 30, pb = 26;
    const iw = W - pl - prr, ih = H - pt - pb;
    const maxV = Math.max(1, r.safety * 1.2, ...pts.map((q) => Math.max(q[1], q[2])));
    const nice = niceMax(maxV);
    const x = (i) => pl + (i / N) * iw;
    const y = (v) => pt + ih - (Math.min(v, nice) / nice) * ih;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Прогноз остатка по дням">
      <defs><pattern id="hatch2" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--crit)" stroke-width="1.5" opacity=".45"/></pattern></defs>`;
    for (let k = 1; k <= 4; k++) {
      const v = (nice / 4) * k;
      svg += `<line x1="${pl}" x2="${W - prr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${pl - 6}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">${short(v)}</text>`;
    }
    // нулевая линия
    svg += `<line x1="${pl}" x2="${W - prr}" y1="${y(0)}" y2="${y(0)}" stroke="var(--text-3)" stroke-width="1"/><text x="${pl - 6}" y="${y(0) + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">0</text>`;
    // зона дефицита без нового заказа
    const zones = [];
    let run = null;
    pts.forEach((q, i) => {
      const empty = q[1] <= 0 && q[3] > 0;
      if (empty && run == null) run = i;
      if ((!empty || i === N) && run != null) { zones.push([run, empty ? i : i - 1]); run = null; }
    });
    zones.forEach(([a, b]) => { svg += `<rect x="${x(a)}" y="${y(0) - 16}" width="${Math.max(2, x(b) - x(a))}" height="16" fill="url(#hatch2)"/>`; });
    if (zones.length) svg += `<text x="${Math.min(x(zones[0][0]) + 4, W - 150)}" y="${y(0) - 20}" font-size="10" font-weight="600" fill="var(--crit)">дефицит без нового заказа</text>`;
    // страховой запас
    if (r.safety > 0 && r.safety < nice) svg += `<line x1="${pl}" x2="${W - prr}" y1="${y(r.safety)}" y2="${y(r.safety)}" stroke="var(--warn)" stroke-dasharray="4 4"/><text x="${W - prr}" y="${y(r.safety) - 4}" text-anchor="end" font-size="10" fill="var(--warn)">страховой запас</text>`;
    // метки дат: подписи в верхней полосе, чтобы не перекрывать линии
    const marks = [[0, "сегодня", "var(--text-3)"]];
    if (pr.safeDay != null && pr.safeDay > 0 && pr.safeDay <= N) marks.push([pr.safeDay, `заказать до ${dayDate(pr.safeDay)}`, "var(--warn)"]);
    if (pr.arrivalDay <= N) marks.push([pr.arrivalDay, `приход заказа ${dayDate(pr.arrivalDay)}`, "var(--series-1)"]);
    if (pr.stockoutDay != null && pr.stockoutDay > 0) marks.push([pr.stockoutDay, `закончится ${dayDate(pr.stockoutDay)}`, "var(--crit)"]);
    marks.sort((a, b) => a[0] - b[0]);
    let lastX = -1e9, row = 0;
    marks.forEach(([i, label, color]) => {
      const xx = x(i);
      row = xx - lastX < 120 ? (row + 1) % 2 : 0;
      lastX = xx;
      svg += `<line x1="${xx}" x2="${xx}" y1="${pt - 4 + row * 12}" y2="${pt + ih}" stroke="${color}" stroke-width="1.5" stroke-dasharray="2 3"/>`;
      svg += `<text x="${Math.min(xx + 3, W - 110)}" y="${pt - 8 + row * 12}" font-size="10" font-weight="600" fill="${color}">${label}</text>`;
    });
    // линии остатка
    const line0 = pts.map((q, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(q[1]).toFixed(1)}`).join("");
    const line1 = pts.map((q, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(q[2]).toFixed(1)}`).join("");
    svg += `<path d="${line0}" fill="none" stroke="var(--text-3)" stroke-width="2" stroke-dasharray="5 4"/>`;
    if (orderQty > 0) svg += `<path d="${line1}" fill="none" stroke="var(--series-1)" stroke-width="2"/>`;
    pr.arrivals.forEach((a) => { if (a.day <= N) svg += `<path d="M${x(a.day)},${y(0) + 2} l-5,8 h10 z" fill="var(--series-1)"/>`; });
    if (pr.stockoutDay != null) svg += `<circle cx="${x(pr.stockoutDay)}" cy="${y(0)}" r="5" fill="var(--crit)" stroke="var(--surface)" stroke-width="2"/>`;
    for (let i = 0; i <= N; i++) {
      const dt = Engine.dateOf(i);
      if (dt.getUTCDate() === 1) svg += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--text-3)">${MON[dt.getUTCMonth()]}</text>`;
    }
    svg += `<rect class="stock-hit" x="${pl}" y="${pt}" width="${iw}" height="${ih}" fill="transparent"/><line class="cross" x1="0" x2="0" y1="${pt}" y2="${pt + ih}" stroke="var(--text-3)" opacity="0"/></svg>`;
    const noEta = r.transitNoEta ? `<div class="banner" style="margin:10px 0 0"><svg viewBox="0 0 24 24"><path d="M12 3l10 18H2z"/><path d="M12 10v4M12 17.5v.5"/></svg><div>${fmt(r.transitNoEta)} шт в пути без даты прихода не показаны на графике и не уменьшают заказ. Уточните ETA у поставщика.</div></div>` : "";
    let after = "";
    if (orderQty > 0) {
      after = `С заказом ${fmt(orderQty)} шт (приход ${dayDate(pr.arrivalDay)}) запаса хватит ${pr.stockoutWithOrder == null ? "до конца горизонта" : "до " + dayDate(pr.stockoutWithOrder)}.`;
      if (pr.nextOrderByDay != null) after += ` Следующий заказ — до ${dayDate(Math.max(pr.nextOrderByDay, 0))}.`;
    }
    const html = `<div class="chart">${svg}</div>
      <div class="legend">
        <span><i style="width:16px;height:0;border-top:2px dashed var(--text-3)"></i>Остаток без нового заказа</span>
        ${orderQty > 0 ? `<span><i style="width:16px;height:2px;background:var(--series-1)"></i>С рекомендованным заказом</span>` : ""}
        <span><i style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:8px solid var(--series-1)"></i>Приход товара в пути</span>
        ${zones.length ? `<span><i style="width:12px;height:12px;background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--crit) 45%,transparent) 0 1.5px,transparent 1.5px 4px)"></i>Дефицит — спрос не будет удовлетворён</span>` : ""}
      </div>${after ? `<p class="say" style="margin-top:8px">${after}</p>` : ""}${noEta}
      <p class="muted" style="font-size:12px;margin:6px 0 0">Прогноз спроса по месяцам — на графике «История спроса и прогноз» ниже; здесь он распределён по дням месяца.</p>`;
    stockCache = { pr, x0: pl, iw, N, W, orderQty };
    return html;
  }
  let stockCache = null;
  function bindStock(root) {
    const hit = $(".stock-hit", root);
    if (!hit || !stockCache) return;
    const svg = hit.ownerSVGElement, cross = $(".cross", svg), tip = $("#tip");
    const { pr, x0, iw, N, W, orderQty } = stockCache;
    hit.addEventListener("mousemove", (e) => {
      const box = svg.getBoundingClientRect();
      const vx = ((e.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(N, Math.round(((vx - x0) / iw) * N)));
      const p = pr.pts[i];
      const cx = x0 + (i / N) * iw;
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("opacity", ".6");
      const arr = pr.arrivals.filter((a) => a.day === i).map((a) => `<br>▲ приход ${fmt(a.qty)} шт (${esc(a.doc)})`).join("");
      tip.innerHTML = `<b>${dayDate(i)}</b> · ${inDays(i)}<br>Без заказа: ${fmt(p[1])} шт${orderQty > 0 ? `<br>С заказом: ${fmt(p[2])} шт` : ""}<br>Спрос: ${fmt(p[3], 1)} шт/день${arr}${p[1] <= 0 && p[3] > 0 ? '<br><span style="color:#f08a8a">Товара нет</span>' : ""}`;
      tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + "px";
      tip.style.top = e.clientY + 14 + "px";
    });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("opacity", "0"); });
  }

  function bindChart(root) {
    const tip = $("#tip");
    $$(".hit", root).forEach((h) => {
      h.addEventListener("mousemove", (e) => {
        tip.innerHTML = h.dataset.tip;
        tip.hidden = false;
        const tw = tip.offsetWidth;
        tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + "px";
        tip.style.top = e.clientY + 14 + "px";
        h.setAttribute("fill", "rgba(127,127,127,.08)");
      });
      h.addEventListener("mouseleave", () => { tip.hidden = true; h.setAttribute("fill", "transparent"); });
    });
  }
  function niceMax(v) {
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= v) return m * e;
    return 10 * e;
  }
  const short = (v) => (v >= 1e6 ? fmt(v / 1e6, 1) + "м" : v >= 1e3 ? fmt(v / 1e3, v >= 1e4 ? 0 : 1) + "к" : fmt(v));
  const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  function roundTop(x, y, w, h, r) {
    if (h < r) r = Math.max(0, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ---------------- analytics tab ----------------
  function renderAnalytics() {
    const base = rows.filter(({ s }) => state.sup === "all" || s.sup === state.sup);
    // 1. к заказу по группам
    const groups = {};
    base.forEach((x) => {
      const g = (groups[x.s.g] ||= { crit: 0, other: 0, total: 0 });
      g.total++;
      if (x.final > 0) x.r.urgency === "critical" ? g.crit++ : g.other++;
    });
    const gl = Object.entries(groups).sort((a, b) => b[1].crit + b[1].other - (a[1].crit + a[1].other));
    const gmax = Math.max(1, ...gl.map(([, g]) => g.crit + g.other));
    const hbars = gl.map(([name, g]) => `
      <div class="hbar" data-tip="${esc(`<b>${name}</b><br>Критично: ${g.crit}<br>Остальные к заказу: ${g.other}<br>Всего артикулов: ${g.total}`)}">
        <span>${esc(name)}</span>
        <div class="track">
          ${g.crit ? `<i style="width:${(g.crit / gmax) * 100}%;background:var(--crit)"></i>` : ""}
          ${g.other ? `<i style="width:${(g.other / gmax) * 100}%;background:var(--series-1)"></i>` : ""}
        </div>
        <span class="v">${fmt(g.crit + g.other)}</span>
      </div>`).join("");

    // 2. сезонность
    const supKeys = Object.keys(SUPS).filter((k) => state.sup === "all" || k === state.sup);
    const season = seasonChart(supKeys);

    // 3. динамика спроса по группам (small multiples)
    const n = META.months.length;
    const byG = {};
    base.forEach(({ s }) => {
      const a = (byG[s.g] ||= new Array(n).fill(0));
      s.cln.forEach((v, i) => (a[i] += v));
    });
    const smalls = Object.entries(byG).sort((a, b) => b[1].reduce((x, y) => x + y) - a[1].reduce((x, y) => x + y)).map(([g, a]) => {
      const last6 = a.slice(-6).reduce((x, y) => x + y), prev6 = a.slice(-18, -12).reduce((x, y) => x + y);
      const yoy = prev6 > 0 ? last6 / prev6 - 1 : null;
      return `<div class="small-m"><div class="sm-t">${esc(g)}</div>
        <div class="sm-v">${yoy == null ? "новая группа" : `${yoy >= 0 ? "▲ +" : "▼ "}${Math.round(yoy * 100)}% г/г`}</div>
        ${sparkline(a)}</div>`;
    }).join("");

    // 4. разовые заказы
    const oos = [];
    base.forEach(({ s }) => s.oo.forEach((o) => oos.push({ s, o })));
    oos.sort((a, b) => b.o[3] / Math.max(b.o[4], 1) - a.o[3] / Math.max(a.o[4], 1));
    const seenOo = new Set();
    const ooList = oos.filter(({ s }) => !seenOo.has(s.id) && seenOo.add(s.id)).slice(0, 10).map(({ s, o }) => `<div class="list-row" data-open="${esc(s.id)}" style="cursor:pointer"><span>${esc(s.n)}<br><span class="muted">накладная от ${esc(o[2])}</span></span><span style="text-align:right;white-space:nowrap"><b class="num">${fmt(o[3])} шт</b><br><span class="muted">в ${fmt(o[3] / Math.max(o[4], 1))} раз больше обычного</span></span></div>`).join("");

    // 5. упущенный спрос
    const lost = base.filter((x) => x.r.lost > 0.5).sort((a, b) => (b.s.pr ? b.r.lost * b.s.pr : b.r.lost) - (a.s.pr ? a.r.lost * a.s.pr : a.r.lost)).slice(0, 10);
    const lostList = lost.map(({ s, r }) => `<div class="list-row" data-open="${esc(s.id)}" style="cursor:pointer"><span>${esc(s.n)}<br><span class="muted">${esc(SUPS[s.sup].name)} · ${s.av.filter((a) => a < 1).length} мес. без товара</span></span><span style="text-align:right;white-space:nowrap"><b class="num">+${fmt(r.lost)} шт</b>${s.pr ? `<br><span class="muted">себест. ≈ ${money(r.lost * s.pr)}</span>` : ""}</span></div>`).join("");

    const excess = base.filter((x) => x.r.excess > 0);
    const excessVal = excess.reduce((a, x) => a + (Engine.hasPrice(x.s) ? x.r.excess * x.s.pr : 0), 0);
    const oneDocs = base.reduce((a, x) => a + x.s.oo.length, 0), oneQty = base.reduce((a, x) => a + x.r.oneoffQty, 0);
    const lostQ = base.reduce((a, x) => a + Math.max(0, x.r.lost), 0);
    $("#tab-analytics").innerHTML = `
      <div class="bstats">
        <div class="fact"><div class="f-l">Излишки (запас > 6 мес)</div><div class="f-v">${fmt(excess.length)} поз.</div><div class="f-s">${excessVal ? `${money(excessVal)} по известным ценам` : "цены неизвестны"}</div></div>
        <div class="fact"><div class="f-l">Разовые заказы исключены</div><div class="f-v">${fmt(oneDocs)}</div><div class="f-s">${fmt(oneQty)} шт не раздувают закупку</div></div>
        <div class="fact"><div class="f-l">Упущенный спрос учтён</div><div class="f-v">+${fmt(lostQ)} шт</div><div class="f-s">за 12 мес, когда товара не было</div></div>
      </div>
      <div class="grid-2">
        <div class="card"><h3>Что заказывать: по группам товаров</h3><p class="c-desc">Количество позиций к заказу, из них критичных</p>
          ${hbars}
          <div class="legend"><span><i style="width:10px;height:10px;background:var(--crit);border-radius:2px"></i>Критично</span><span><i style="width:10px;height:10px;background:var(--series-1);border-radius:2px"></i>Остальные к заказу</span></div>
        </div>
        <div class="card"><h3>Сезонность спроса</h3><p class="c-desc">Коэффициент месяца относительно среднего (1.0) — из файлов партнёра</p>${season}</div>
        <div class="card wide"><h3>Динамика регулярного спроса по группам</h3><p class="c-desc">Сумма очищенных продаж по месяцам, янв 2024 — авг 2026; изменение — последние 6 мес. к тем же месяцам прошлого года</p><div class="smalls">${smalls}</div></div>
        <div class="card"><h3>Крупнейшие разовые заказы</h3><p class="c-desc">Найдены автоматически и исключены из регулярной потребности</p><div class="list">${ooList || '<div class="empty">Нет</div>'}</div></div>
        <div class="card"><h3>Упущенный спрос из-за дефицита</h3><p class="c-desc">Сколько товара не продали, пока его не было на складе (12 мес.)</p><div class="list">${lostList || '<div class="empty">Нет</div>'}</div></div>
      </div>`;
    $$("#tab-analytics [data-open]").forEach((el) => el.addEventListener("click", () => openDrawer(el.dataset.open)));
    bindTips($("#tab-analytics"));
  }
  function bindTips(root) {
    const tip = $("#tip");
    $$("[data-tip]", root).forEach((h) => {
      if (h.classList.contains("hit")) return;
      h.addEventListener("mousemove", (e) => {
        tip.innerHTML = h.dataset.tip; tip.hidden = false;
        tip.style.left = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14) + "px";
        tip.style.top = e.clientY + 14 + "px";
      });
      h.addEventListener("mouseleave", () => (tip.hidden = true));
    });
    bindChart(root);
  }
  function sparkline(a) {
    const W = 180, H = 44;
    const max = Math.max(1, ...a);
    const pts = a.map((v, i) => [2 + (i / (a.length - 1)) * (W - 4), H - 3 - (v / max) * (H - 8)]);
    const area = `${line(pts)}L${pts[pts.length - 1][0]},${H}L${pts[0][0]},${H}Z`;
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin-top:6px"><path d="${area}" fill="var(--accent-soft)"/><path d="${line(pts)}" fill="none" stroke="var(--series-1)" stroke-width="1.5"/></svg>`;
  }
  function seasonChart(keys) {
    const W = 520, H = 200, pl = 30, pb = 22, pt = 10;
    const iw = W - pl - 6, ih = H - pb - pt;
    const max = 1.4, min = 0;
    const y = (v) => pt + ih - ((v - min) / (max - min)) * ih;
    const colors = ["var(--series-1)", "var(--series-2)"];
    const gw = iw / 12, bw = Math.min(14, (gw - 6) / keys.length);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Сезонность по месяцам">`;
    [0, 0.5, 1, 1.4].forEach((v) => {
      svg += `<line x1="${pl}" x2="${W - 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" ${v === 1 ? 'stroke-dasharray="3 3" stroke="var(--line-strong)"' : ""}/>`;
      svg += `<text x="${pl - 5}" y="${y(v) + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">${v.toFixed(1)}</text>`;
    });
    for (let m = 0; m < 12; m++) {
      const cx = pl + gw * m + gw / 2;
      keys.forEach((k, j) => {
        const v = SUPS[k].S[m];
        const bx = cx - (bw * keys.length + 2 * (keys.length - 1)) / 2 + j * (bw + 2);
        svg += `<path d="${roundTop(bx, y(v), bw, y(0) - y(v), 3)}" fill="${colors[j]}"/>`;
      });
      const tip = `<b>${MON[m]}</b><br>` + keys.map((k) => `${SUPS[k].name}: ×${SUPS[k].S[m].toFixed(2)}`).join("<br>");
      svg += `<rect class="hit" x="${pl + gw * m}" y="${pt}" width="${gw}" height="${ih}" fill="transparent" data-tip="${esc(tip)}"/>`;
      svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--text-3)">${MON[m]}</text>`;
    }
    svg += `</svg>`;
    const legend = keys.length > 1 ? `<div class="legend">${keys.map((k, j) => `<span><i style="width:10px;height:10px;background:${colors[j]};border-radius:2px"></i>${esc(SUPS[k].name)}</span>`).join("")}</div>` : "";
    return `<div class="chart">${svg}</div>${legend}`;
  }

  // ---------------- calendar tab ----------------
  function renderCalendar() {
    const base = rows.filter(({ s, r, final }) => (state.sup === "all" || s.sup === state.sup) && r.orderByDay != null && r.level > 0 && (final > 0 || r.orderByDay > 0));
    const cards = WINDOWS.map((w) => {
      const list = base.filter((x) => w.test(x.r.orderByDay)).sort((a, b) => a.r.orderByDay - b.r.orderByDay || URG_ORDER[a.r.urgency] - URG_ORDER[b.r.urgency] || b.r.monthly - a.r.monthly);
      const bySup = Object.keys(SUPS).map((k) => {
        const l = list.filter((x) => x.s.sup === k);
        return l.length ? `<span>${esc(SUPS[k].name)}: <b class="num">${fmt(l.length)}</b></span>` : "";
      }).join("");
      const val = list.reduce((a, x) => a + (x.s.pr ? Math.max(x.final, 0) * x.s.pr : 0), 0);
      const def = list.reduce((a, x) => a + (x.s.pr ? x.r.deficit * x.s.pr : 0), 0);
      const crit = list.filter((x) => x.r.urgency === "critical").length;
      return { w, list, html: `
        <div class="cal-card ${w.k === "now" ? "now" : ""}">
          <div class="cal-top"><div><div class="cal-title">${w.label}</div><div class="cal-sub">${w.k === "now" ? "заказ нужно разместить сегодня" : w.sub + (w.k !== "later" ? ` · до ${dayDate(w.k === "w1" ? 7 : w.k === "w2" ? 14 : w.k === "m1" ? 30 : 60)}` : "")}</div></div>
            <div class="cal-count num">${fmt(list.length)}</div></div>
          <div class="cal-stats">${bySup}${val ? `<span>Сумма: <b class="num">${money(val)}</b></span>` : ""}${crit ? `<span style="color:var(--crit)">Дефицит неизбежен: <b class="num">${fmt(crit)}</b></span>` : ""}</div>
          ${def && w.k !== "later" ? `<div class="cal-risk">Расчётный неудовлетворённый спрос без заказа за 6 мес. — по себестоимости ≈ <b>${money(def)}</b> (только позиции SE с ценой; это не выручка и не прибыль)</div>` : ""}
          <div class="cal-list">${list.slice(0, 5).map((x) => `<div class="cal-item" data-open="${esc(x.s.id)}"><span class="ci-name">${esc(x.s.n)}</span><span class="ci-date num">${x.r.orderByDay <= 0 ? (x.r.orderByDay < 0 ? `опоздание ${fmt(-x.r.orderByDay)} дн` : "сегодня") : dayDate(x.r.orderByDay)}</span></div>`).join("")}</div>
          ${list.length ? `<button class="btn sm" data-win="${w.k}">Открыть список (${fmt(list.length)})</button>` : '<div class="muted" style="font-size:13px">Нет позиций</div>'}
        </div>` };
    });
    // полоса-таймлайн: сколько позиций на каждую неделю ближайших 3 месяцев
    const weeks = 13;
    const counts = new Array(weeks).fill(0);
    base.forEach((x) => { const d = Math.max(0, x.r.orderByDay); const wk = Math.floor(d / 7); if (wk < weeks) counts[wk]++; });
    const cmax = Math.max(1, ...counts);
    const W = 680, H = 150, pl = 30, pb = 24, pt = 10, iw = W - pl - 6, ih = H - pb - pt, bw = iw / weeks;
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Количество позиций к заказу по неделям">`;
    const nice = niceMax(cmax);
    [0, 0.5, 1].forEach((f) => { const v = nice * f, yy = pt + ih - (v / nice) * ih; svg += `<line x1="${pl}" x2="${W - 6}" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="${pl - 5}" y="${yy + 3}" text-anchor="end" font-size="10" fill="var(--text-3)">${fmt(v)}</text>`; });
    counts.forEach((c, i) => {
      const h = (c / nice) * ih, xx = pl + i * bw + 3, yy = pt + ih - h;
      const col = i === 0 ? "var(--crit)" : i === 1 ? "var(--warn)" : "var(--series-1)";
      if (c) svg += `<path d="${roundTop(xx, yy, bw - 6, h, 4)}" fill="${col}"/><text x="${xx + (bw - 6) / 2}" y="${yy - 4}" text-anchor="middle" font-size="10" fill="var(--text-2)">${fmt(c)}</text>`;
      const tip = `<b>${i === 0 ? "Сегодня и эта неделя" : `Неделя ${dayDate(i * 7)} – ${dayDate(i * 7 + 6)}`}</b><br>Разместить заказ: ${fmt(c)} позиций`;
      svg += `<rect class="hit" x="${pl + i * bw}" y="${pt}" width="${bw}" height="${ih}" fill="transparent" data-tip="${esc(tip)}"/>`;
      if (i % 2 === 0) svg += `<text x="${pl + i * bw + bw / 2}" y="${H - 7}" text-anchor="middle" font-size="10" fill="var(--text-3)">${i === 0 ? "сейчас" : dayDate(i * 7)}</text>`;
    });
    svg += `</svg>`;
    $("#tab-calendar").innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <h3>Когда размещать заказы</h3>
        <p class="c-desc">Поставка идёт ~${fmt(state.p.lead.IEK * 30)} дней, поэтому заказывать нужно заранее. Дата «заказать до» = день, когда остаток опустится до страхового уровня, минус срок поставки. Учтены сезонность, тренд и приходы товара в пути по датам.</p>
        <div class="chart">${svg}</div>
        <div class="legend"><span><i style="width:10px;height:10px;background:var(--crit);border-radius:2px"></i>Сегодня / эта неделя</span><span><i style="width:10px;height:10px;background:var(--warn);border-radius:2px"></i>Следующая неделя</span><span><i style="width:10px;height:10px;background:var(--series-1);border-radius:2px"></i>Позже</span></div>
      </div>
      <div class="cal-grid">${cards.map((c) => c.html).join("")}</div>`;
    $$("#tab-calendar [data-open]").forEach((el) => el.addEventListener("click", () => openDrawer(el.dataset.open)));
    $$("#tab-calendar [data-win]").forEach((el) => el.addEventListener("click", () => { state.urg = "all"; setFilter({ win: el.dataset.win, onlyOrder: el.dataset.win === "now" || el.dataset.win === "w1" ? true : false }); }));
    bindTips($("#tab-calendar"));
  }

  // ---------------- сценарии и бюджет ----------------
  let scenCache = { key: null, val: null };
  function scenarioStats() {
    const key = JSON.stringify([state.p, state.sup, Object.keys(state.overrides).length]);
    if (scenCache.key === key) return scenCache.val;
    const base = allSkus().filter((sk) => state.sup === "all" || sk.sup === state.sup);
    const val = {};
    Object.keys(SCN).forEach((k) => {
      const p = { ...state.p, scenario: k };
      const rs = base.map((sk) => { const r = Engine.calc(sk, p); return { s: sk, r, final: r.qty }; });
      const cov = Engine.priceCoverage(rs);
      val[k] = {
        order: rs.filter((x) => x.final > 0).length,
        crit: rs.filter((x) => x.r.urgency === "critical").length,
        today: rs.filter(Engine.isOrderToday).length,
        deficit: rs.filter((x) => x.r.expectedDeficit).length,
        units: rs.reduce((a, x) => a + x.final, 0),
        value: cov.value, share: cov.share, priced: cov.priced, lines: cov.lines,
      };
    });
    scenCache = { key, val };
    return val;
  }
  function renderScenarios() {
    const st = scenarioStats();
    const keys = Object.keys(SCN);
    const cur = state.p.scenario;
    const row = (label, f, note = "") => `<tr><td>${label}${note ? `<div class="n muted" style="font-size:12px">${note}</div>` : ""}</td>${keys.map((k) => `<td class="num ${k === cur ? "cur" : ""}">${f(st[k])}</td>`).join("")}</tr>`;
    const al = state.alloc;
    const sumv = (l) => l.reduce((a, x) => a + x.final * x.s.pr, 0);
    const li = (l) => l.slice(0, 6).map((x) => `<div class="list-row" data-open="${esc(x.s.id)}" style="cursor:pointer" tabindex="0"><span>${esc(x.s.n)}<br><span class="muted">${ST[x.r.status].label} · ${esc(x.s.id)}</span></span><span style="text-align:right;white-space:nowrap"><b class="num">${fmt(x.final)} шт</b>${Engine.hasPrice(x.s) ? `<br><span class="muted">${money(x.final * x.s.pr)}</span>` : `<br><span class="muted">нет цены</span>`}</span></div>`).join("") || '<div class="empty" style="padding:14px">Нет</div>';
    $("#tab-scenarios").innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center">
          <h3>Сравнение сценариев</h3>
          <div class="seg" id="scenSeg2">${keys.map((k) => `<button class="${k === cur ? "active" : ""}" data-sc="${k}">${SCN[k].label}</button>`).join("")}</div>
        </div>
        <p class="c-desc">Одинаковые данные, разные допущения. Выбранный сценарий подсвечен и применяется ко всему сервису. Разница между сценариями — не «экономия»: для этого нужны проверенные маржа и стоимость хранения.</p>
        <div class="table-wrap"><table class="cmp">
          <thead><tr><th>Метрика</th>${keys.map((k) => `<th class="${k === cur ? "cur" : ""}">${SCN[k].label}</th>`).join("")}</tr></thead>
          <tbody>
            ${row("Допущения", (x) => "", "")}
            <tr><td class="muted" style="font-size:12px">спрос · срок поставки · уровень сервиса A/B/C</td>${keys.map((k) => `<td class="${k === cur ? "cur" : ""}" style="font-size:12px">${SCN[k].demand ? (SCN[k].demand > 0 ? "+" : "−") + Math.abs(SCN[k].demand * 100) + "%" : "прогноз"} · ${SCN[k].lead_add_days ? "+" + SCN[k].lead_add_days + " дн" : "текущий"} · z ${SCN[k].z.A}/${SCN[k].z.B}/${SCN[k].z.C}</td>`).join("")}</tr>
            ${row("SKU к заказу", (x) => fmt(x.order))}
            ${row("Критические SKU", (x) => fmt(x.crit))}
            ${row("Заказать сегодня", (x) => fmt(x.today), "безопасный день наступил или прошёл")}
            ${row("Ожидаемый дефицит", (x) => fmt(x.deficit), "закончатся до прихода заказа, размещённого сегодня")}
            ${row("Рекомендуемое количество, шт", (x) => fmt(x.units))}
            ${row("Стоимость по известным ценам", (x) => (x.priced ? money(x.value) : "Нет данных"), "неполная сумма")}
            ${row("Покрытие ценами", (x) => pct(x.share))}
          </tbody></table></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">Коэффициенты сценариев — демонстрационные допущения (engine/forecast.py → SCENARIOS), а не исторически доказанные вероятности. Ручные корректировки менеджера в сравнении не учитываются.</p>
      </div>

      <div class="card">
        <h3>Приоритизация заказа при ограниченном бюджете</h3>
        <p class="c-desc">Необязательно. Если бюджет не задан, ничего не оптимизируется. Порядок: «Дефицит сейчас» и «Просрочено» → ранняя дата окончания → категория A → больший дефицит. В бюджет входят только позиции с известной ценой; позиции без цены не считаются бесплатными и показываются отдельно.</p>
        <div class="budget-row">
          <label for="budgetIn">Доступный бюджет, ₸</label>
          <input id="budgetIn" type="number" min="0" step="100000" placeholder="например, 10 000 000" value="${state.budget || ""}">
          <button class="btn primary sm" id="budgetApply">Применить</button>
          ${state.budget ? `<button class="btn sm" id="budgetClear">Сбросить</button>` : ""}
        </div>
        ${al ? `<div class="bstats">
            <div class="fact main"><div class="f-l">Включено в бюджет</div><div class="f-v">${fmt(al.included.length)} поз.</div><div class="f-s">${money(al.spent)} из ${money(state.budget)}</div></div>
            <div class="fact"><div class="f-l">Не поместилось</div><div class="f-v">${fmt(al.skipped.length)} поз.</div><div class="f-s">${money(sumv(al.skipped))}</div></div>
            <div class="fact"><div class="f-l">Нет цены</div><div class="f-v">${fmt(al.noPrice.length)} поз.</div><div class="f-s">стоимость неизвестна</div></div>
            <div class="fact ${al.criticalNoPrice.length ? "crit" : ""}"><div class="f-l">Критичные без цены</div><div class="f-v">${fmt(al.criticalNoPrice.length)} поз.</div><div class="f-s">остаются в предупреждениях</div></div>
          </div>
          <div class="grid-2">
            <div><h4 style="margin:0 0 8px">Включено</h4><div class="list">${li(al.included)}</div></div>
            <div><h4 style="margin:0 0 8px">Не поместилось</h4><div class="list">${li(al.skipped)}</div></div>
            <div><h4 style="margin:0 0 8px">Критичные без цены — нужна цена или решение менеджера</h4><div class="list">${li(al.criticalNoPrice)}</div></div>
          </div>
          <p class="muted" style="font-size:12px">Метки «в бюджете / не поместилось / нет цены» также видны в таблице «Заказ поставщикам».</p>`
        : `<div class="empty-state">Бюджет не задан — рекомендации показаны полностью, без ограничений.</div>`}
      </div>`;
    $$("#scenSeg2 button").forEach((b) => (b.onclick = () => setScenario(b.dataset.sc)));
    $("#budgetApply").onclick = () => {
      const v = Math.max(0, +$("#budgetIn").value || 0);
      state.budget = v > 0 ? v : null; store.set("budget", state.budget); recompute(); render();
    };
    $("#budgetIn").onkeydown = (e) => { if (e.key === "Enter") $("#budgetApply").click(); };
    if ($("#budgetClear")) $("#budgetClear").onclick = () => { state.budget = null; store.set("budget", null); recompute(); render(); };
    $$("#tab-scenarios [data-open]").forEach((el) => { el.onclick = () => openDrawer(el.dataset.open); el.onkeydown = (e) => { if (e.key === "Enter") openDrawer(el.dataset.open); }; });
  }

  // ---------------- качество данных ----------------
  function dataQualityHtml() {
    const q = Engine.dataQuality(baseRows());
    const cov = Engine.priceCoverage(baseRows());
    const item = (v, title, text) => `<div class="dq-row"><div class="dq-v">${v}</div><div><b>${title}</b><div class="dq-t">${text}</div></div></div>`;
    return `<div class="dq">
      ${item(pct(q.priceShare), "Артикулы с ценой", `Для ${pct(cov.lines ? cov.missing / cov.lines : null)} позиций к заказу нет цены (${fmt(cov.missing)} из ${fmt(cov.lines)}). Количество рассчитано, но полный бюджет заказа определить нельзя. В выгрузке IEK нет себестоимости.`)}
      ${item(pct(q.moqShare), "Артикулы с кратностью (MOQ)", "Где кратности нет в файле, принята 1 — заказ может не совпасть с упаковкой поставщика.")}
      ${item(pct(q.etaShare), "Товар в пути с датой прихода", q.transitNoEta ? `${fmt(q.transitNoEta)} шт в пути без даты (файл SE) не считаются прибывшими: заказ по таким позициям может оказаться больше нужного. Нужны даты поступления.` : "У всего товара в пути есть дата прихода.")}
      ${item(fmt(q.returns), "Артикулы с возвратами", "Отрицательные строки накладных в спрос не входят.")}
      ${item("Нет", "Поле клиента в выгрузке", "В файлах продаж партнёра нет идентификатора клиента (только дата, номер документа, товар, склад, количество). Проверка «крупные продажи одному клиенту» невозможна — разовые заказы ищутся по накладной. Для проверки по клиенту нужен обезличенный ID клиента в выгрузке.")}
      ${item(fmt(q.noHistory), "Без достаточной истории", `Меньше ${META.minHistory} мес. продаж или нулевой спрос — статус «Недостаточно данных», даты не рассчитываются.`)}
      ${item(fmt(q.zeroStock), "С нулевым остатком", "При положительном спросе — статус «Дефицит сейчас».")}
      ${item(fmt(q.badCodes.length), "Нестандартные коды 1С", q.badCodes.length ? `Например: ${q.badCodes.slice(0, 4).map(esc).join(", ")}. Проверьте сопоставление с 1С перед загрузкой.` : "Все коды в едином формате.")}
    </div>`;
  }

  // ---------------- backtest ----------------
  function backtestHtml() {
    const bt = META.bt;
    if (!bt) return "";
    const p = (x) => (x == null ? "Нет данных" : `${fmt(x * 100, 1)}%`);
    const sg = (x) => (x == null ? "Нет данных" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${fmt(Math.abs(x) * 100, 1)}%`);
    const r = (label, m, nv) => `<tr><td>${label}</td><td class="num">${fmt(m.n)}</td><td class="num"><b>${p(m.wape)}</b></td><td class="num">${nv ? p(nv.wape) : "—"}</td><td class="num">${sg(m.bias)}</td><td class="num hide-sm">${p(m.under)}</td><td class="num hide-sm">${p(m.over)}</td></tr>`;
    return `<h2 class="sec" id="bt">Проверка прогноза на прошлом</h2>
      <div class="card">
        <p class="c-desc" style="margin-bottom:12px">Дата отсечения — 1 ${["", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"][+bt.cutoff.slice(5)]} ${bt.cutoff.slice(0, 4)}. Алгоритм видел только данные до этой даты (продажи, остатки, накладные, сезонность по полным годам) и спрогнозировал спрос на ${bt.horizon} мес. (${bt.period}). Прогноз сравнён с фактическими продажами. Для сравнения — простое среднее за 12 месяцев, как в ручном расчёте.</p>
        <div class="bstats">
          <div class="fact main"><div class="f-l">Ошибка прогноза (WAPE)</div><div class="f-v">${p(bt.overall.wape)}</div><div class="f-s">у среднего за 12 мес — ${p(bt.naive.wape)}</div></div>
          <div class="fact"><div class="f-l">Смещение (bias)</div><div class="f-v">${sg(bt.overall.bias)}</div><div class="f-s">у среднего за 12 мес — ${sg(bt.naive.bias)} (${bt.naive.bias > 0 ? "завышает" : "занижает"})</div></div>
          <div class="fact"><div class="f-l">Прогноз ниже факта</div><div class="f-v">${p(bt.overall.under)}</div><div class="f-s">артикулов; выше факта — ${p(bt.overall.over)}</div></div>
        </div>
        <div class="table-wrap"><table class="cmp"><thead><tr><th>Срез</th><th>SKU</th><th>WAPE</th><th>WAPE среднего</th><th>Bias</th><th class="hide-sm">Ниже факта</th><th class="hide-sm">Выше факта</th></tr></thead><tbody>
          ${r("Все", bt.overall, bt.naive)}
          ${Object.entries(bt.byAbc).map(([k, m]) => r(`Категория ${k}`, m, bt.naiveByAbc[k])).join("")}
          ${Object.entries(bt.bySup).map(([k, m]) => r(esc(k), m, null)).join("")}
        </tbody></table></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">WAPE = Σ|прогноз − факт| / Σ факт. Bias = Σ(прогноз − факт) / Σ факт: плюс — завышение, минус — занижение. Для редких товаров (C) ошибка выше — это ожидаемо при штучных продажах. Проверка измеряет точность прогноза спроса и <b>не доказывает предотвращённые дефициты</b>: для этого нужна точная история ежедневных остатков и поступлений.</p>
      </div>`;
  }

  // ---------------- проверить расчёт на своих числах ----------------
  // Тот же алгоритм, что и для реальных товаров: Engine.analyzeSeries (шаги 1–5, копия Python)
  // + Engine.calc (заказ, календарь остатка). Данные хранятся только в этом браузере.
  const NM = META.months.length;
  const avgLast = (a, k = 6) => { const t = a.slice(-k); return t.reduce((x, y) => x + y, 0) / t.length; };
  const blankSb = () => ({
    sales: new Array(NM).fill(100), av: new Array(NM).fill(1), oneoffs: [], stock: 150,
    transit: [], leadDays: Math.round(state.p.lead.IEK * 30), moq: 1, abc: "B", prof: "IEK", price: "", typical: 10,
    source: "Стабильный спрос ≈ 100 шт/мес", realId: null,
  });
  state.sb = store.get("sandbox", null) || blankSb();
  let sbPrev = null, sbNote = "";

  /** Разовый ли заказ: правило как у детектора по накладным (упрощённо для ручного ввода):
   *  ≥ 5 обычных накладных и ≥ 25 % продаж месяца; если такие заказы в 4+ месяцах — это регулярный оптовик. */
  function sbVerdicts(sb) {
    const monthsWithBig = new Set();
    const v = sb.oneoffs.map((o) => {
      if (o.fixed) return { ...o, one: true, why: "найден по накладным партнёра" };
      const monthTotal = (+sb.sales[o.m] || 0) + sb.oneoffs.filter((q) => q.m === o.m).reduce((a, q) => a + (+q.qty || 0), 0);
      const big = +o.qty >= 5 * Math.max(1, +sb.typical || 1) && +o.qty >= 0.25 * monthTotal;
      if (big) monthsWithBig.add(o.m);
      return { ...o, one: big, why: big ? `в ${fmt(+o.qty / Math.max(1, +sb.typical || 1))} раз больше обычной накладной и ${fmt(100 * o.qty / Math.max(monthTotal, 1))}% продаж месяца` : "меньше 5 обычных накладных или < 25% месяца — это обычный спрос" };
    });
    const recurring = monthsWithBig.size >= 4;
    return v.map((o) => (recurring && !o.fixed && o.one ? { ...o, one: false, why: "крупные заказы в 4+ месяцах — постоянный оптовик, спрос регулярный" } : o));
  }

  function sandboxRow() {
    const sb = state.sb;
    const verd = sbVerdicts(sb);
    const raw = sb.sales.map((v, i) => Math.max(0, +v || 0) + verd.filter((o) => o.m === i).reduce((a, o) => a + (+o.qty || 0), 0));
    const oneoff = new Array(NM).fill(0);
    verd.forEach((o) => { if (o.one) oneoff[o.m] += +o.qty || 0; });
    const avail = sb.av.map((a, i) => (a < 1 && !(a > 0.1 && a < 1 && sb.realId) ? (raw[i] <= 0 ? 0.1 : 0.4) : a));
    const a = Engine.analyzeSeries({ raw, avail, oneoff, supplierS: SUPS[sb.prof].S });
    state.p.lead[SB_ID] = Math.max(1, +sb.leadDays || 1) / 30;
    const tr = sb.transit.filter((t) => +t.qty > 0).map((t, i) => [`Поставка ${i + 1}`, +t.qty,
      t.days === "" || t.days == null ? null : Engine.dateOf(Math.max(0, +t.days)).toISOString().slice(0, 10)]);
    const s = {
      id: SB_ID, n: "Проверочный товар (ручной ввод)", g: sb.source || "Ручная проверка", abc: sb.abc, sup: SB_ID,
      pr: +sb.price > 0 ? +sb.price : null, mq: 1, st: Math.max(0, +sb.stock || 0), tr, moq: Math.max(1, Math.round(+sb.moq || 1)),
      oo: verd.filter((o) => o.one).map((o) => [o.m, o.fixed ? o.doc : "ручной ввод", o.fixed ? o.date : "", +o.qty, +sb.typical || 1]), ...a,
    };
    const r = Engine.calc(s, state.p);
    return { s, r, final: r.qty, value: Engine.hasPrice(s) ? r.qty * s.pr : 0, verd };
  }
  const saveSb = () => store.set("sandbox", state.sb);

  function sbLoadReal(id) {
    const x = rows.find((q) => q.s.id === id.trim() || (q.s.art && q.s.art === id.trim()));
    if (!x) { toast("Товар не найден: проверьте код 1С или артикул"); return false; }
    const s = x.s;
    const oo = s.oo.map((o) => ({ m: o[0], qty: o[3], fixed: true, doc: o[1], date: o[2] }));
    state.sb = {
      sales: s.raw.map((v, i) => Math.max(0, v - oo.filter((o) => o.m === i).reduce((a, o) => a + o.qty, 0))),
      av: (s.av || new Array(NM).fill(1)).slice(), oneoffs: oo, stock: s.st,
      transit: s.tr.map((t) => ({ qty: t[1], days: t[2] ? Math.max(0, Engine.dayOf(t[2])) : "" })),
      leadDays: Math.round(state.p.lead[s.sup] * 30), moq: s.moq, abc: s.abc, prof: s.sup, price: s.pr ?? "",
      typical: Math.max(1, Math.round((s.oo[0] && s.oo[0][4]) || 10)), source: `Копия: ${s.n}`, realId: s.id,
    };
    return true;
  }
  const TEMPLATES = {
    flat: ["Стабильный спрос ≈ 100 шт/мес", () => new Array(NM).fill(100)],
    season: ["Сезонный товар: пик летом", () => META.monthNums.map((m) => Math.round(100 * [0.5, 0.5, 0.7, 1, 1.2, 1.5, 1.7, 1.6, 1.2, 0.9, 0.7, 0.5][m - 1]))],
    growth: ["Растущий спрос: +40% за год", () => META.monthNums.map((_, i) => Math.round(80 * Math.pow(1.4, i / 12)))],
    fresh: ["Новый товар: продажи 6 месяцев", () => META.monthNums.map((_, i) => (i < NM - 6 ? 0 : 120))],
  };

  function sbQuick(kind) {
    const sb = state.sb;
    const before = sandboxRow();
    const avg = Math.max(1, Math.round(avgLast(sb.sales.map((v) => +v || 0))));
    if (kind === "oneoff") {
      const qty = avg * 30;
      sb.typical = Math.max(1, Math.round(avg / 10));
      sb.oneoffs.push({ m: NM - 3, qty });
      sbNote = `Добавлен разовый заказ ${fmt(qty)} шт в ${META.months[NM - 3]} (в 30 раз больше месячного спроса).`;
    } else if (kind === "stockout") {
      [NM - 5, NM - 4, NM - 3].forEach((i) => { sb.sales[i] = 0; sb.av[i] = 0.1; });
      sbNote = `Отмечены 3 месяца без товара (${META.months[NM - 5]} — ${META.months[NM - 3]}), продажи в них = 0.`;
    } else if (kind === "season") {
      sb.sales = TEMPLATES.season[1]();
      sbNote = "Продажи заменены на сезонный профиль с пиком в июле–августе.";
    } else if (kind === "transit") {
      sb.transit.push({ qty: Math.round(avg * 1.5), days: 10 });
      sbNote = `Добавлен товар в пути ${fmt(Math.round(avg * 1.5))} шт с приходом через 10 дней.`;
    } else if (kind === "transitNoEta") {
      sb.transit.push({ qty: Math.round(avg * 1.5), days: "" });
      sbNote = `Добавлен товар в пути ${fmt(Math.round(avg * 1.5))} шт без даты прихода.`;
    }
    sbPrev = before;
    saveSb();
    renderSandbox();
  }

  function renderSandbox() {
    const sb = state.sb;
    const row = sandboxRow();
    const { s, r } = row;
    const real = sb.realId && rows.find((x) => x.s.id === sb.realId);
    const match = real ? (real.r.qty === r.qty && real.r.stockoutDay === r.stockoutDay
      ? `<div class="sb-match">✓ Совпадает с основным расчётом этого товара: ${fmt(real.r.qty)} шт, закончится ${Engine.fmtDay(real.r.stockoutDay)}.</div>`
      : `<div class="sb-match warn">Отличается от основного расчёта (${fmt(real.r.qty)} шт): вы изменили данные или у товара был остаток до первых продаж.</div>`) : "";
    let delta = "";
    if (sbPrev) {
      const d = r.qty - sbPrev.r.qty;
      const lv = r.level - sbPrev.r.level;
      delta = `<div class="sb-delta">${esc(sbNote)}<br>Заказ: <b>${fmt(sbPrev.r.qty)} → ${fmt(r.qty)} шт</b> (${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))}) · регулярный спрос ${fmt(sbPrev.r.level, 1)} → ${fmt(r.level, 1)} шт/мес (${lv >= 0 ? "+" : "−"}${fmt(Math.abs(lv), 1)})
        · закончится ${Engine.fmtDay(sbPrev.r.stockoutDay)} → ${Engine.fmtDay(r.stockoutDay)}</div>`;
    }
    const monthCells = META.months.map((m, i) => `<div class="sb-m ${sb.av[i] < 1 ? "off" : ""}">
        <div class="ml"><span>${m}</span><label title="Товара не было на складе"><input type="checkbox" data-av="${i}" ${sb.av[i] < 1 ? "checked" : ""}>нет</label></div>
        <input type="number" min="0" step="1" data-sale="${i}" value="${sb.sales[i]}" aria-label="Продажи ${m}, шт"></div>`).join("");
    const verd = row.verd;
    $("#tab-sandbox").innerHTML = `<div class="sb-grid">
      <div class="card">
        <h3>Проверить расчёт на своих числах</h3>
        <p class="c-desc">Введите продажи, остаток и поставки — сервис посчитает заказ тем же алгоритмом, что и для 2 944 реальных товаров, и покажет каждый шаг. Данные сохраняются только в этом браузере и никуда не отправляются.</p>
        <div class="sb-inline" style="margin-bottom:14px">
          <select id="sbTpl" aria-label="Шаблон"><option value="">Шаблон…</option>${Object.entries(TEMPLATES).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select>
          <span class="muted">или</span>
          <input id="sbReal" placeholder="код 1С или артикул" aria-label="Код 1С или артикул реального товара" style="width:170px">
          <button class="btn sm" id="sbLoad">Взять реальный товар</button>
          <button class="btn sm ghost" id="sbReset">Сбросить</button>
        </div>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">Сейчас: <b>${esc(sb.source)}</b></div>

        <h4 style="margin:0 0 8px">Продажи по месяцам, шт <small class="muted">(«нет» — товара не было на складе)</small></h4>
        <div class="sb-months">${monthCells}</div>
        <div class="sb-inline" style="margin:8px 0 16px"><span>Заполнить все месяцы:</span><input type="number" id="sbFill" min="0" value="100" aria-label="Одинаковые продажи во всех месяцах"><button class="btn sm" id="sbFillBtn">Заполнить</button></div>

        <h4 style="margin:0 0 8px">Товар сейчас</h4>
        <div class="sb-fields">
          <label>Остаток на складе, шт<input type="number" min="0" data-f="stock" value="${sb.stock}"></label>
          <label>Срок поставки, дней<input type="number" min="1" max="365" data-f="leadDays" value="${sb.leadDays}"></label>
          <label>Кратность (MOQ), шт<input type="number" min="1" data-f="moq" value="${sb.moq}"></label>
          <label>Категория ABC<select data-f="abc">${["A", "B", "C"].map((k) => `<option ${sb.abc === k ? "selected" : ""}>${k}</option>`).join("")}</select></label>
          <label>Сезонность поставщика<select data-f="prof">${Object.entries(REAL_SUPS).map(([k, v]) => `<option value="${k}" ${sb.prof === k ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
          <label>Цена, ₸ (необязательно)<input type="number" min="0" data-f="price" value="${sb.price}" placeholder="нет данных"></label>
        </div>

        <h4 style="margin:16px 0 8px">Товар в пути</h4>
        ${sb.transit.map((t, i) => `<div class="sb-inline" style="margin-bottom:6px"><input type="number" min="0" data-tq="${i}" value="${t.qty}" aria-label="Количество в пути"> шт, придёт через <input type="number" min="0" data-td="${i}" value="${t.days}" placeholder="нет даты" aria-label="Через сколько дней придёт"> дн <button class="btn sm ghost" data-trdel="${i}" aria-label="Удалить поставку">✕</button></div>`).join("") || '<div class="muted" style="font-size:13px;margin-bottom:6px">Нет</div>'}
        <button class="btn sm" id="sbTrAdd">+ Добавить поставку</button>
        <div class="muted" style="font-size:12px;margin-top:4px">Пустое поле «придёт через» = дата неизвестна: такой товар не считается прибывшим вовремя.</div>

        <h4 style="margin:16px 0 8px">Разовые крупные заказы</h4>
        ${verd.map((o, i) => `<div class="list-row" style="border:1px solid var(--line);border-radius:8px;margin-bottom:6px"><span>${META.months[o.m]} · <b>${fmt(o.qty)} шт</b><br><span class="muted" style="font-size:12px">${o.one ? "исключён из регулярного спроса" : "оставлен в спросе"}: ${esc(o.why)}</span></span>${o.fixed ? "" : `<button class="btn sm ghost" data-oodel="${i}" aria-label="Удалить заказ">✕</button>`}</div>`).join("")}
        <div class="sb-inline"><select id="sbOoM" aria-label="Месяц">${META.months.map((m, i) => `<option value="${i}" ${i === NM - 3 ? "selected" : ""}>${m}</option>`).join("")}</select>
          <input type="number" id="sbOoQ" min="1" placeholder="шт" aria-label="Количество разового заказа">
          <span>обычная накладная</span><input type="number" min="1" data-f="typical" value="${sb.typical}" style="width:80px" aria-label="Обычный размер накладной, шт"> шт
          <button class="btn sm" id="sbOoAdd">Добавить заказ</button></div>

        <h4 style="margin:16px 0 8px">Проверить требования ТЗ одной кнопкой</h4>
        <div class="sb-quick">
          <button class="btn sm" data-q="oneoff">+ Разовый заказ ×30</button>
          <button class="btn sm" data-q="stockout">3 месяца без товара</button>
          <button class="btn sm" data-q="season">Сделать сезонным</button>
          <button class="btn sm" data-q="transit">Товар в пути с датой</button>
          <button class="btn sm" data-q="transitNoEta">Товар в пути без даты</button>
        </div>
      </div>

      <div class="card sb-result">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">${statusPill(r.status)}${pill(r.urgency)}<span class="scen-tag">Сценарий: ${SCN[state.p.scenario].label}</span></div>
        ${delta}
        <div class="facts" style="margin:12px 0">
          <div class="fact main"><div class="f-l">Рекомендуемый заказ</div><div class="f-v">${fmt(r.qty)} шт</div><div class="f-s">кратно ${fmt(r.moq)}${s.pr ? ` · ${money(r.qty * s.pr)}` : ""}</div></div>
          <div class="fact ${r.expectedDeficit ? "crit" : ""}"><div class="f-l">Закончится</div><div class="f-v">${fDay(r.stockoutDay)}</div><div class="f-s">${r.stockoutDay == null ? (r.status === "nodata" ? "мало истории" : "> 6 мес") : inDays(r.stockoutDay)}</div></div>
          <div class="fact ${r.safeDay != null && r.safeDay < 0 ? "crit" : ""}"><div class="f-l">Заказать до</div><div class="f-v">${r.safeDay == null ? NA : r.status === "now" ? "Немедленно" : r.safeDay < 0 ? "Просрочено" : Engine.fmtDay(r.safeDay)}</div><div class="f-s">поставка ${fmt(r.leadDays)} + ${state.p.buffer} дн</div></div>
          <div class="fact"><div class="f-l">Регулярный спрос</div><div class="f-v">${fmt(r.level, r.level < 10 ? 1 : 0)}</div><div class="f-s">шт/мес без сезонности</div></div>
        </div>
        ${match}
        <p class="say" style="margin-top:10px">${esc(Engine.explain(s, r, state.p))}</p>
        ${factorTable(s, r, row)}
        <div style="margin-top:14px">${stockChart(s, r, r.qty)}</div>
        <button class="btn" id="sbOpen" style="margin-top:12px">Открыть подробный расчёт</button>
        <div class="sb-add">
          <h4 style="margin:0 0 8px">Добавить этот товар в заказ поставщику</h4>
          <div class="sb-fields">
            <label>Название товара<input id="sbName" value="${esc(sb.name || "")}" placeholder="например, Автомат ВА47-29 16А"></label>
            <label>Код 1С или артикул<input id="sbCode" value="${esc(sb.code || "")}" placeholder="необязательно"></label>
            <label>Поставщик<select id="sbSup">${Object.entries(REAL_SUPS).map(([key, v]) => `<option value="${key}" ${sb.prof === key ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></label>
          </div>
          <button class="btn primary" id="sbAdd" style="margin-top:10px">+ Добавить в заказ поставщику</button>
          <p class="muted" style="font-size:12px;margin:6px 0 0">Товар появится на дашборде, в таблице заказа и в отправке WhatsApp / Telegram с пометкой «добавлен вручную». Срок поставки — как у выбранного поставщика. Хранится в этом браузере.</p>
          ${state.custom.length ? `<div class="list" style="margin-top:10px">${state.custom.map((c) => `<div class="list-row"><span><b>${esc(c.n)}</b><br><span class="muted">${esc(SUPS[c.sup].name)}${c.art ? " · " + esc(c.art) : ""}</span></span><button class="btn sm ghost" data-cdel="${esc(c.id)}">Удалить</button></div>`).join("")}</div>` : ""}
        </div>
      </div>
    </div>`;
    bindStock($("#tab-sandbox"));
    const T = $("#tab-sandbox");
    const upd = (fn) => { fn(); sbPrev = null; saveSb(); clearTimeout(sbTimer); sbTimer = setTimeout(renderSandbox, 250); };
    $$("[data-sale]", T).forEach((el) => el.oninput = () => upd(() => { state.sb.sales[+el.dataset.sale] = Math.max(0, +el.value || 0); }));
    $$("[data-av]", T).forEach((el) => el.onchange = () => { state.sb.av[+el.dataset.av] = el.checked ? 0.1 : 1; sbPrev = null; saveSb(); renderSandbox(); });
    $$("[data-f]", T).forEach((el) => (el.oninput = el.onchange = () => upd(() => { state.sb[el.dataset.f] = el.tagName === "SELECT" ? el.value : el.value === "" ? "" : +el.value; })));
    $$("[data-tq]", T).forEach((el) => el.oninput = () => upd(() => { state.sb.transit[+el.dataset.tq].qty = +el.value || 0; }));
    $$("[data-td]", T).forEach((el) => el.oninput = () => upd(() => { state.sb.transit[+el.dataset.td].days = el.value === "" ? "" : Math.max(0, +el.value); }));
    $$("[data-trdel]", T).forEach((el) => el.onclick = () => { state.sb.transit.splice(+el.dataset.trdel, 1); saveSb(); renderSandbox(); });
    $$("[data-oodel]", T).forEach((el) => el.onclick = () => { state.sb.oneoffs.splice(+el.dataset.oodel, 1); saveSb(); renderSandbox(); });
    $("#sbTrAdd").onclick = () => { state.sb.transit.push({ qty: 100, days: 14 }); saveSb(); renderSandbox(); };
    $("#sbOoAdd").onclick = () => {
      const q = +$("#sbOoQ").value;
      if (!(q > 0)) { toast("Укажите количество разового заказа"); return; }
      sbPrev = sandboxRow(); sbNote = `Добавлен заказ ${fmt(q)} шт в ${META.months[+$("#sbOoM").value]}.`;
      state.sb.oneoffs.push({ m: +$("#sbOoM").value, qty: q }); saveSb(); renderSandbox();
    };
    $("#sbFillBtn").onclick = () => { const v = Math.max(0, +$("#sbFill").value || 0); state.sb.sales = new Array(NM).fill(v); state.sb.source = `Одинаковые продажи ${fmt(v)} шт/мес`; state.sb.realId = null; sbPrev = null; saveSb(); renderSandbox(); };
    $("#sbTpl").onchange = (e) => { const t = TEMPLATES[e.target.value]; if (!t) return; state.sb = { ...blankSb(), sales: t[1](), source: t[0] }; sbPrev = null; saveSb(); renderSandbox(); };
    $("#sbLoad").onclick = () => { if (sbLoadReal($("#sbReal").value)) { sbPrev = null; saveSb(); renderSandbox(); } };
    $("#sbReal").onkeydown = (e) => { if (e.key === "Enter") $("#sbLoad").click(); };
    $("#sbReset").onclick = () => { state.sb = blankSb(); sbPrev = null; saveSb(); renderSandbox(); };
    $$("[data-q]", T).forEach((el) => el.onclick = () => sbQuick(el.dataset.q));
    $("#sbOpen").onclick = () => openDrawer(SB_ID);
    $("#sbName").oninput = (e) => { state.sb.name = e.target.value; saveSb(); };
    $("#sbCode").oninput = (e) => { state.sb.code = e.target.value; saveSb(); };
    $("#sbAdd").onclick = () => {
      const name = $("#sbName").value.trim();
      if (!name) { toast("Укажите название товара"); $("#sbName").focus(); return; }
      const sup = $("#sbSup").value;
      const base = sandboxRow().s;
      const item = { ...base, id: `MAN-${Date.now().toString(36)}`, n: name, art: $("#sbCode").value.trim() || null, sup, g: "Добавлено вручную", manual: 1 };
      delete item.pc; delete item.wh;
      state.custom.push(item);
      store.set("custom", state.custom);
      recompute(); render(); renderSandbox();
      toast(`«${name}» добавлен в заказ ${SUPS[sup].name}`);
    };
    $$("[data-cdel]", T).forEach((b) => (b.onclick = () => {
      state.custom = state.custom.filter((c) => c.id !== b.dataset.cdel);
      store.set("custom", state.custom); recompute(); render(); renderSandbox();
    }));
  }
  let sbTimer;

  // ---------------- method tab ----------------
  function pickExamples() {
    const cand = rows.filter((x) => x.r.level > 5);
    const best = (f) => cand.reduce((a, b) => (f(b) > f(a) ? b : a), cand[0]);
    const sens = (x, k) => Math.abs(Engine.sensitivity(x.s, state.p)[k]);
    return {
      transit: best((x) => (x.s.tr.length ? x.r.transit * (x.final > 0 ? 2 : 1) : -1)),
      season: best((x) => (x.s.sw > 0 ? Math.max(...x.s.S) / Math.min(...x.s.S) * Math.min(1, x.r.level / 50) : 0)),
      restore: best((x) => (x.s.av ? x.r.lost / Math.max(x.r.level, 1) * Math.min(1, x.r.level / 20) : 0)),
      oneoff: best((x) => (x.s.oo.length ? x.r.oneoffQty / Math.max(x.r.level, 1) * Math.min(1, x.r.level / 20) : 0)),
    };
  }
  function renderMethod() {
    const ex = pickExamples();
    const steps = [
      ["Очистка от разовых заказов", "По каждой накладной сравниваем объём с типичным для товара (медиана + 6·MAD, ≥ 5 медиан, ≥ 25 % месяца). Если крупные заказы повторяются (4+ месяцев) — это постоянный оптовик, их оставляем в спросе."],
      ["Восстановление упущенного спроса", "Если на начало/конец месяца остаток был нулевым, продажи занижены. Заменяем их ожидаемым спросом с учётом доли месяца без товара."],
      ["Сезонность", "Коэффициенты поставщика из файла «Сезонность» + собственный профиль товара (вес до 60 % при двух полных годах истории)."],
      ["Уровень и тренд", "Средний спрос за 6 мес. без сезонности. Рост год к году ограничен −30…+50 %, чтобы один всплеск не раздул заказ."],
      ["Страховой запас", "z × σ × √(срок поставки + период пересмотра). z зависит от ABC-категории: A — 95 %, B — 90 %, C — 80 % уровень сервиса."],
      ["Заказ", "Прогноз + страховой запас − остаток − товар в пути, округление вверх до кратности поставщика. Срочность — по тому, хватит ли запаса до прихода поставки."],
      ["Календарь остатка", "Остаток по дням на 6 месяцев: минус спрос (месячный прогноз с сезонностью распределён по дням), плюс товар в пути — только с датой прихода. Последний безопасный день = дата окончания запаса − срок поставки − дни на согласование."],
    ];
    const checks = [
      ["Учёт всех источников данных", "История продаж, остатки, товар в пути, категории (ABC), прогноз прироста, кратность — каждый влияет на результат. Попробуйте выключить «Товар в пути».", ex.transit],
      ["Сезонность и устойчивый рост", "Прогноз повторяет сезонный профиль товара, а не среднее по истории. Тренд г/г учитывается и ограничен.", ex.season],
      ["Упущенный спрос при stockout", "Для месяцев без остатка спрос восстановлен — расчётная потребность выше, чем по «сырым» продажам.", ex.restore],
      ["Исключение разовых крупных заказов", "Крупные разовые продажи найдены по накладным и не раздувают регулярный заказ.", ex.oneoff],
      ["Список по поставщикам с обоснованием", "Заказ разбит по поставщикам, каждая строка содержит расчёт и текстовое обоснование, экспорт в Excel с кодами 1С.", null],
      ["Сверх ТЗ: когда заказывать", "Поставка идёт 1,5 месяца, поэтому важно не только «сколько», но и «когда». Для каждого товара — дата «заказать до», дата окончания запаса и календарь заказов по неделям.", ex.transit],
    ];
    $("#tab-method").innerHTML = `
      <h2 class="sec">Алгоритм расчёта</h2>
      <div class="steps">${steps.map(([t, d], i) => `<div class="step"><div class="n">${i + 1}</div><h4>${t}</h4><p>${d}</p></div>`).join("")}</div>
      <h2 class="sec">Проверка требований ТЗ</h2>
      <div class="checks">${checks.map(([t, d, x], i) => `
        <div class="check"><div class="ok"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div>
          <div><h4>${i + 1}. ${t}</h4><p>${d}${x ? ` Пример: <b>${esc(x.s.n)}</b>.` : ""}</p></div>
          ${x ? `<button class="btn sm" data-open="${esc(x.s.id)}">Открыть пример</button>` : `<button class="btn sm" data-goto="orders">К заказу</button>`}
        </div>`).join("")}</div>
      ${backtestHtml()}
      ${window.renderCoverage ? '<h2 class="sec">Охват данных</h2><div id="coverageBox"></div>' : ""}
      ${window.renderAssumptions ? '<h2 class="sec">Реестр допущений модели</h2><div class="card" id="assumptionsBox"></div>' : ""}
      <h2 class="sec">Качество данных</h2>
      <div class="card">${dataQualityHtml()}</div>
      <h2 class="sec">Надёжность поставщиков</h2>
      <div class="card"><div class="grid-2">${Object.values(SUPS).map((v) => `<div><h4 style="margin:0 0 8px">${esc(v.name)}</h4>
        <div class="empty-state">Недостаточно истории поставок. Добавьте плановую и фактическую даты приходов — сервис рассчитает среднюю задержку, P90 срока поставки, долю поставок вовремя и недопоставки, а страховой запас начнёт учитывать опоздания.</div></div>`).join("")}</div></div>
      <h2 class="sec">Какие данные усилят расчёт</h2>
      <div class="card"><div class="list">
        <div class="list-row"><span><b>Клиентские резервы и подтверждённые заказы</b><br><span class="muted">вычитаются из свободного остатка; крупные известные заказы планируются отдельно</span></span><span class="muted">нет источника</span></div>
        <div class="list-row"><span><b>Товары-заменители и семейства</b><br><span class="muted">аналог IEK ↔ Systeme Electric при дефиците</span></span><span class="muted">нет источника</span></div>
        <div class="list-row"><span><b>Цены IEK и маржа</b><br><span class="muted">полная стоимость заказа, бюджет по всем позициям</span></span><span class="muted">нет источника</span></div>
        <div class="list-row"><span><b>Даты прихода SE</b><br><span class="muted">учёт товара в пути в календаре остатка</span></span><span class="muted">нет в файле</span></div>
      </div><p class="muted" style="font-size:12px;margin:10px 0 0">Пока источников нет, эти поля не участвуют в расчётах.</p></div>
      <h2 class="sec">Данные и ограничения</h2>
      <div class="card"><p style="margin:0;color:var(--text-2)">Данные ТОО «Электрокомплект» на ${META.asOf.split("-").reverse().join(".")}: помесячные продажи и остатки (янв 2024 — сен 2026), 248 тыс. строк расходных накладных, товар в пути, сезонность, кратность поставщиков.
      Сентябрь 2026 неполный — в прогнозе не используется, остаток на сегодня рассчитан с учётом продаж с начала месяца.
      Данные клиентов не используются: разовый заказ определяется по номеру накладной. Автоматические тесты: <code>PYTHONPATH=. pytest -q</code> — требования ТЗ, календарь остатка, сценарии и сверка расчёта Python с браузером.</p></div>`;
    $$("#tab-method [data-open]").forEach((b) => b.addEventListener("click", () => openDrawer(b.dataset.open)));
    try { if (window.renderCoverage) window.renderCoverage($("#coverageBox"), META.coverage); } catch (e) { console.warn("coverage", e); }
    try { if (window.renderAssumptions) window.renderAssumptions($("#assumptionsBox"), META); } catch (e) { console.warn("assumptions", e); }
    $$("#tab-method [data-goto]").forEach((b) => b.addEventListener("click", () => switchTab("orders")));
  }

  // ---------------- chrome ----------------
  function renderSupSeg() {
    const opts = [["all", "Все поставщики"], ...Object.entries(SUPS).map(([k, v]) => [k, v.name])];
    $("#supSeg").innerHTML = opts.map(([k, l]) => `<button role="tab" class="${state.sup === k ? "active" : ""}" data-s="${k}">${esc(l)}</button>`).join("");
    $$("#supSeg button").forEach((b) => b.addEventListener("click", () => { state.sup = b.dataset.s; state.group = "all"; renderSupSeg(); renderGroupSel(); recompute(); render(); }));
  }
  function renderGroupSel() {
    const gs = [...new Set(rows.filter((x) => state.sup === "all" || x.s.sup === state.sup).map((x) => x.s.g))].sort((a, b) => a.localeCompare(b, "ru"));
    $("#groupSel").innerHTML = `<option value="all">Все группы товаров</option>` + gs.map((g) => `<option ${state.group === g ? "selected" : ""}>${esc(g)}</option>`).join("");
  }
  function switchTab(t) {
    state.tab = t;
    $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    $$(".tabpane").forEach((p) => (p.hidden = p.id !== "tab-" + t));
    render();
  }
  function render() {
    renderKpis();
    if (state.tab === "orders") { renderFilters(); renderOrders(); }
    if (state.tab === "today") renderToday();
    if (state.tab === "scenarios") renderScenarios();
    if (state.tab === "sandbox" && !document.activeElement?.closest("#tab-sandbox")) renderSandbox();
    if (state.tab === "analytics") renderAnalytics();
    if (state.tab === "calendar") renderCalendar();
    if (state.tab === "method") renderMethod();
  }
  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2200);
  }

  function init() {
    $("#asof").textContent = `Данные на ${META.asOf.split("-").reverse().join(".")}`;
    recompute();
    buildParams();
    renderSupSeg();
    renderGroupSel();
    let qTimer;
    $("#q").addEventListener("input", (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; if (state.tab !== "orders") switchTab("orders"); else render(); }, 120); });
    $("#groupSel").addEventListener("change", (e) => { state.group = e.target.value; recompute(); render(); });
    $("#abcSel").addEventListener("change", (e) => { state.abc = e.target.value; render(); });
    $("#statusSel").addEventListener("change", (e) => { state.st = e.target.value; render(); });
    $("#sortSel").value = state.sort;
    $("#sortSel").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
    $("#onlyOrder").addEventListener("change", (e) => { state.onlyOrder = e.target.checked; if (state.onlyOrder && state.urg === "ok") state.urg = "all"; render(); });
    $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#exportBtn").addEventListener("click", () => { exportXlsx(); toast("Excel сформирован. Поставщику ничего не отправлено"); });
    $("#sendBtn").addEventListener("click", sendChooser);
    $("#paramsToggle").addEventListener("click", openParams);
    $("#paramsClose").addEventListener("click", closeParams);
    $("#paramsScrim").addEventListener("click", closeParams);
    $("#scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeParams(); $("#modal").hidden = true; } });
    render();
    // прямые ссылки: #tab=analytics, #sku=<код 1С>
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("scenario") && SCN[h.get("scenario")]) { state.p.scenario = h.get("scenario"); paramLabels(); recompute(); render(); }
    if (h.get("budget")) { state.budget = +h.get("budget") || null; recompute(); render(); }
    if (h.get("sup") && SUPS[h.get("sup")]) { state.sup = h.get("sup"); renderSupSeg(); renderGroupSel(); recompute(); render(); }
    if (h.get("tab")) switchTab(h.get("tab"));
    if (h.get("sku")) openDrawer(h.get("sku"));
    if (h.get("order") && REAL_SUPS[h.get("order")]) openOrderSheet(h.get("order"), "today", +h.get("step") === 2 ? 2 : 1);
    if (h.get("sec")) document.getElementById(h.get("sec"))?.scrollIntoView();
  }
  try {
    if (!window.DATA || !window.Engine && typeof Engine === "undefined") throw new Error("данные не загружены");
    init();
  } catch (err) {
    console.error(err);
    document.querySelector("main").innerHTML = `<div class="card" style="margin-top:20px"><h3>Не удалось загрузить данные</h3>
      <p class="c-desc">Проверьте, что рядом с index.html есть файлы data.js и engine.js, или пересоберите данные командой <code>python -m engine.build</code>.</p>
      <p class="muted" style="font-size:12px">${String(err && err.message || err).replace(/</g, "&lt;")}</p></div>`;
  }
})();
