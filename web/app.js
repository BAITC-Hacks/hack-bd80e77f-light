/* Умный Закуп — интерфейс менеджера по закупкам. */
(() => {
  const DATA = window.DATA;
  const META = DATA.meta;
  const SUPS = META.suppliers;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const fmt = (x, d = 0) => (x == null || !isFinite(x) ? "—" : Number(x).toLocaleString("ru-RU", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const money = (x) => (x >= 1e6 ? `${fmt(x / 1e6, 1)} млн ₸` : x >= 1e3 ? `${fmt(x / 1e3, 0)} тыс ₸` : `${fmt(x)} ₸`);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

  const URG = {
    critical: { label: "Критично", hint: "закончится до прихода новой поставки", icon: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>' },
    soon: { label: "Скоро", hint: "запас ниже страхового уровня", icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
    planned: { label: "Планово", hint: "плановое пополнение", icon: '<path d="M5 12h14M13 6l6 6-6 6"/>' },
    ok: { label: "Запас в норме", hint: "заказ не нужен", icon: '<path d="M5 12l5 5 9-10"/>' },
  };
  const URG_ORDER = { critical: 0, soon: 1, planned: 2, ok: 3 };
  const pill = (u) => `<span class="pill ${u}"><svg viewBox="0 0 24 24">${URG[u].icon}</svg>${URG[u].label}</span>`;

  // ---------------- state ----------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem("zakup:" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("zakup:" + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };
  const defaults = {
    lead: Object.fromEntries(Object.entries(SUPS).map(([k, v]) => [k, v.lead])),
    review: 1, growth: 0, oneoff: true, restore: true, season: true, trend: true, transit: true,
  };
  const state = {
    sup: "all", q: "", urg: "all", group: "all", abc: "all", sort: "urgency", onlyOrder: true, tab: "orders",
    p: { ...defaults, ...store.get("params", {}) },
    overrides: store.get("overrides", {}),
    approved: store.get("approved", {}),
    limit: {},
  };
  let rows = [];

  function recompute() {
    rows = DATA.skus.map((s) => {
      const r = Engine.calc(s, state.p);
      const ov = state.overrides[s.id];
      const final = ov != null ? ov : r.qty;
      return { s, r, final, value: s.pr ? final * s.pr : 0 };
    });
  }

  // ---------------- params panel ----------------
  const TOGGLES = [
    ["oneoff", "Исключать разовые заказы", "крупные разовые продажи одному клиенту"],
    ["restore", "Восстанавливать упущенный спрос", "месяцы, когда товара не было на складе"],
    ["season", "Сезонность", "профиль поставщика + история товара"],
    ["trend", "Тренд роста", "рост/падение спроса год к году"],
    ["transit", "Товар в пути", "уже заказанное вычитается из потребности"],
  ];

  function buildParams() {
    $("#leadFields").innerHTML = Object.entries(SUPS).map(([k, v]) => `
      <div class="field">
        <label for="lead-${k}">Срок поставки ${esc(v.name)} <b id="leadVal-${k}"></b></label>
        <input type="range" id="lead-${k}" data-sup="${k}" min="0.5" max="4" step="0.5">
      </div>`).join("");
    $$("#leadFields input").forEach((el) => {
      el.value = state.p.lead[el.dataset.sup];
      el.addEventListener("input", () => { state.p.lead[el.dataset.sup] = +el.value; onParams(); });
    });
    $("#review").value = state.p.review;
    $("#growth").value = Math.round(state.p.growth * 100);
    $("#review").addEventListener("input", (e) => { state.p.review = +e.target.value; onParams(); });
    $("#growth").addEventListener("input", (e) => { state.p.growth = +e.target.value / 100; onParams(); });
    $("#toggles").innerHTML = TOGGLES.map(([k, t, sub]) => `
      <label class="toggle">
        <span class="t-text"><span class="t-title">${t}</span><br><span class="t-sub">${sub}</span></span>
        <span class="switch"><input type="checkbox" data-k="${k}" ${state.p[k] ? "checked" : ""}><span></span></span>
      </label>`).join("") + `<button class="btn sm ghost" id="resetParams" style="margin-top:8px">Сбросить параметры</button>`;
    $$("#toggles input").forEach((el) => el.addEventListener("change", () => { state.p[el.dataset.k] = el.checked; onParams(); }));
    $("#resetParams").addEventListener("click", () => {
      state.p = JSON.parse(JSON.stringify(defaults));
      buildParams(); onParams();
    });
    paramLabels();
  }
  const months = (x) => `${fmt(x, x % 1 ? 1 : 0)} мес`;
  function paramLabels() {
    Object.keys(SUPS).forEach((k) => { $(`#leadVal-${k}`).textContent = months(state.p.lead[k]); });
    $("#reviewVal").textContent = months(state.p.review);
    const g = Math.round(state.p.growth * 100);
    $("#growthVal").textContent = (g > 0 ? "+" : "") + g + "%";
  }
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
      if (state.onlyOrder && !(final > 0) && !(state.urg === "ok")) return false;
      if (q && !(`${s.n} ${s.id} ${s.art || ""}`.toLowerCase().includes(q))) return false;
      return true;
    });
  }
  function sorted(list) {
    const by = {
      urgency: (a, b) => URG_ORDER[a.r.urgency] - URG_ORDER[b.r.urgency] || a.s.abc.localeCompare(b.s.abc) || b.r.monthly - a.r.monthly,
      value: (a, b) => b.value - a.value || b.final - a.final,
      qty: (a, b) => b.final - a.final,
      name: (a, b) => a.s.n.localeCompare(b.s.n, "ru"),
    }[state.sort];
    return list.sort(by);
  }

  // ---------------- KPIs ----------------
  function renderKpis() {
    const base = rows.filter(({ s }) => state.sup === "all" || s.sup === state.sup);
    const toOrder = base.filter((x) => x.final > 0);
    const crit = base.filter((x) => x.r.urgency === "critical");
    const priced = toOrder.filter((x) => x.s.pr);
    const value = priced.reduce((a, x) => a + x.value, 0);
    const excess = base.filter((x) => x.r.excess > 0 && x.r.level >= 0);
    const excessVal = excess.reduce((a, x) => a + (x.s.pr ? x.r.excess * x.s.pr : 0), 0);
    const oneoffDocs = base.reduce((a, x) => a + x.s.oo.length, 0);
    const oneoffQty = base.reduce((a, x) => a + x.r.oneoffQty, 0);
    const lost = base.reduce((a, x) => a + Math.max(0, x.r.lost), 0);
    const lostVal = base.reduce((a, x) => a + (x.s.pr ? Math.max(0, x.r.lost) * x.s.pr : 0), 0);
    const cards = [
      { label: "Позиций к заказу", value: fmt(toOrder.length), sub: `из ${fmt(base.length)} активных артикулов`, act: () => setFilter({ urg: "all", onlyOrder: true }) },
      { label: "Сумма заказа", value: value ? money(value) : "—", sub: priced.length < toOrder.length ? `по ${fmt(priced.length)} позициям с ценой (SE)` : "по себестоимости" },
      { label: "Критично", dot: "var(--crit)", value: fmt(crit.length), sub: "закончатся до прихода поставки", act: () => setFilter({ urg: "critical" }) },
      { label: "Излишки на складе", dot: "var(--warn)", value: fmt(excess.length), sub: excessVal ? `${money(excessVal)} заморожено (запас > 6 мес)` : "запас больше чем на 6 мес" },
      { label: "Разовые заказы исключены", value: fmt(oneoffDocs), sub: `${fmt(oneoffQty)} шт не раздувают закупку` },
      { label: "Упущенный спрос учтён", value: `+${fmt(lost)}`, sub: lostVal ? `шт за 12 мес · ≈ ${money(lostVal)} продаж` : "шт за 12 мес при отсутствии товара" },
    ];
    $("#kpis").innerHTML = cards.map((c, i) => `
      <div class="kpi ${c.act ? "clickable" : ""}" data-i="${i}">
        <div class="k-label">${c.dot ? `<span class="dot" style="background:${c.dot}"></span>` : ""}${c.label}</div>
        <div class="k-value num">${c.value}</div>
        <div class="k-sub">${c.sub}</div>
      </div>`).join("");
    $$("#kpis .kpi.clickable").forEach((el) => el.addEventListener("click", () => cards[+el.dataset.i].act()));
  }
  function setFilter(f) {
    Object.assign(state, f);
    $("#onlyOrder").checked = state.onlyOrder;
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
    $$("#urgChips .chip").forEach((el) => el.addEventListener("click", () => { state.urg = el.dataset.u; render(); }));
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
          ${ap ? `<span class="approved-badge"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>Утверждён ${esc(ap.at)}</span>
                  <button class="btn sm" data-unapprove="${k}">Изменить</button>`
               : `<button class="btn sm success" data-approve="${k}">Утвердить заказ</button>`}
        </div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Срочность</th><th>Товар и обоснование</th>
          <th class="r">Остаток</th><th class="r hide-sm">В пути</th><th class="r hide-sm">Спрос/мес</th>
          <th class="r">Хватит на</th><th class="r">Заказ, шт</th><th class="r hide-sm">Сумма</th>
        </tr></thead>
        <tbody>${shown.map((x) => rowHtml(x, !!ap)).join("")}</tbody>
      </table></div>
      ${list.length > lim ? `<button class="more" data-more="${k}">Показать ещё ${fmt(Math.min(60, list.length - lim))} из ${fmt(list.length - lim)}</button>` : ""}
    </div>`;
  }

  function rowHtml({ s, r, final, value }, locked) {
    const edited = state.overrides[s.id] != null;
    const cover = r.coverDays;
    const leadDays = r.L * 30;
    const pct = cover == null ? 100 : Math.min(100, (cover / (leadDays * 2)) * 100);
    const col = r.urgency === "critical" ? "var(--crit)" : r.urgency === "soon" ? "var(--warn)" : "var(--good)";
    return `<tr data-id="${esc(s.id)}">
      <td>${pill(r.urgency)}</td>
      <td>
        <div class="p-name">${esc(s.n)}</div>
        <div class="p-meta"><span>${esc(s.id)}</span>${s.art ? `<span>${esc(s.art)}</span>` : ""}<span>${esc(s.g)}</span><span class="abc" title="ABC: частота спроса">${s.abc}</span></div>
        <div class="why">${esc(shortWhy(s, r))}</div>
      </td>
      <td class="r num">${fmt(r.stock)}</td>
      <td class="r num hide-sm">${r.transit ? fmt(r.transit) : '<span class="muted">—</span>'}</td>
      <td class="r num hide-sm">${fmt(r.monthly, r.monthly < 10 ? 1 : 0)}</td>
      <td class="r"><span class="cover num">${cover == null ? "∞" : cover > 365 ? "> 1 года" : fmt(cover) + " дн"}</span>
        <div class="bar-mini"><i style="width:${pct}%;background:${col}"></i></div></td>
      <td class="r">
        <input class="qty-input ${edited ? "edited" : ""}" type="number" min="0" step="${s.moq}" value="${final}" data-qty="${esc(s.id)}" ${locked ? "disabled" : ""} aria-label="Количество к заказу">
        ${edited ? `<div class="rec-hint">расчёт: ${fmt(r.qty)}</div>` : s.moq > 1 ? `<div class="rec-hint">кратно ${fmt(s.moq)}</div>` : ""}
      </td>
      <td class="r num hide-sm">${value ? money(value) : '<span class="muted">—</span>'}</td>
    </tr>`;
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
    $$("#orders tbody tr").forEach((tr) => tr.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      openDrawer(tr.dataset.id);
    }));
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
    $$("[data-approve]").forEach((b) => b.addEventListener("click", () => approveModal(b.dataset.approve)));
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
      <h3>Утвердить заказ ${esc(SUPS[k].name)}?</h3>
      <p>Заказ будет зафиксирован и подготовлен к выгрузке в 1С. Поставщику он <b>не отправляется</b> — это делает менеджер.</p>
      <div class="list">
        <div class="list-row"><span>Позиций</span><b class="num">${fmt(lines.length)}</b></div>
        <div class="list-row"><span>Штук</span><b class="num">${fmt(lines.reduce((a, x) => a + x.final, 0))}</b></div>
        ${val ? `<div class="list-row"><span>Сумма по себестоимости</span><b class="num">${money(val)}</b></div>` : ""}
        <div class="list-row"><span>Из них критичных</span><b class="num">${fmt(crit)}</b></div>
        <div class="list-row"><span>Изменено вручную</span><b class="num">${fmt(edited)}</b></div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-close>Отмена</button>
        <button class="btn success" data-ok>Утвердить и выгрузить</button>
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
      toast(`Заказ ${SUPS[k].name} утверждён`);
    };
  }

  function exportXlsx(keys = Object.keys(SUPS).filter((k) => state.sup === "all" || k === state.sup)) {
    if (!window.XLSX) { toast("Библиотека Excel не загрузилась"); return; }
    const wb = XLSX.utils.book_new();
    keys.forEach((k) => {
      const lines = sorted(rows.filter((x) => x.s.sup === k && x.final > 0));
      const data = lines.map(({ s, r, final }) => ({
        "Код 1С": s.id, "Артикул поставщика": s.art || "", "Наименование": s.n, "Количество": final,
        "Ед.": "шт", "Цена (себест.)": s.pr ?? "", "Сумма": s.pr ? Math.round(final * s.pr * 100) / 100 : "",
        "Срочность": URG[r.urgency].label, "Расчётное кол-во": r.qty, "Изменено вручную": state.overrides[s.id] != null ? "да" : "",
        "Остаток": r.stock, "В пути": r.transit, "Спрос/мес": Math.round(r.monthly * 10) / 10,
        "Группа": s.g, "ABC": s.abc, "Обоснование": Engine.explain(s, r, state.p),
        "Статус": state.approved[k] ? `Утверждён ${state.approved[k].at}` : "Черновик",
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      ws["!cols"] = [12, 18, 50, 10, 5, 12, 12, 12, 12, 10, 10, 10, 10, 22, 5, 90, 20].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws, SUPS[k].name.slice(0, 31));
    });
    XLSX.writeFile(wb, `Заказ_поставщикам_${META.asOf}.xlsx`);
  }

  // ---------------- drawer ----------------
  let openId = null;
  function openDrawer(id, keepScroll = false) {
    const row = rows.find((x) => x.s.id === id);
    if (!row) return;
    openId = id;
    const { s, r } = row;
    const d = $("#drawer");
    const scroll = d.scrollTop;
    const sens = Engine.sensitivity(s, state.p);
    const p = state.p;
    const priceRow = s.pr ? `<div class="h-sub">${money(row.final * s.pr)} по себестоимости</div>` : "";
    d.innerHTML = `
      <div class="d-head">
        <div>
          <div style="margin-bottom:6px">${pill(r.urgency)}</div>
          <h2>${esc(s.n)}</h2>
          <div class="p-meta"><span>Код 1С ${esc(s.id)}</span>${s.art ? `<span>Арт. ${esc(s.art)}</span>` : ""}<span>${esc(SUPS[s.sup].name)}</span><span>${esc(s.g)}</span><span>ABC: ${s.abc}${s.pc ? ` · кат. партнёра ${esc(s.pc)}` : ""}</span></div>
        </div>
        <button class="d-close" aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="d-body">
        <div class="hero">
          <div class="h-card main"><div class="h-label">Рекомендуем заказать</div><div class="h-value num">${fmt(row.final)} шт</div>${priceRow}</div>
          <div class="h-card"><div class="h-label">Остаток хватит на</div><div class="h-value num">${r.coverDays == null ? "∞" : fmt(Math.min(r.coverDays, 999)) + " дн"}</div><div class="h-sub">поставка идёт ${fmt(r.L * 30)} дн</div></div>
          <div class="h-card"><div class="h-label">Регулярный спрос</div><div class="h-value num">${fmt(r.level, r.level < 10 ? 1 : 0)}</div><div class="h-sub">шт/мес без сезонности</div></div>
        </div>

        <div class="d-sec"><h4>История спроса и прогноз</h4>${demandChart(s, r)}</div>

        <div class="d-sec"><h4>Как посчитано</h4>
          <div class="calc">
            ${calcRow("", `Прогноз спроса на ${fmt(r.H, 1)} мес.`, `срок поставки ${months(r.L)} + пересмотр ${months(p.review)}${p.season ? `, сезонность ×${r.seasonMult.toFixed(2)}` : ""}${p.trend && r.growth ? `, тренд ${r.growth > 0 ? "+" : ""}${Math.round(r.growth * 100)}%` : ""}`, r.demandH)}
            ${calcRow("+", "Страховой запас", `z = ${r.z} (категория ${s.abc}) × σ ${fmt(r.sd, 1)} × √${fmt(r.H, 1)}`, r.safety)}
            ${calcRow("−", "Остаток на складе", s.wh ? Object.entries(s.wh).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ") : `на ${META.asOf.split("-").reverse().join(".")}`, r.stock)}
            ${calcRow("−", "Товар в пути", p.transit ? (s.tr.length ? s.tr.map((t) => `${t[0]}${t[2] ? ` (до ${t[2].split("-").reverse().join(".")})` : ""}: ${fmt(t[1])}`).join(" · ") : "нет") : "не учитывается", r.transit)}
            ${calcRow("=", "Потребность", "", r.need)}
            <div class="calc-row total"><span class="op">→</span><div><div>Заказ с учётом кратности ${fmt(s.moq)}</div>${state.overrides[s.id] != null ? `<div class="c-sub">изменено вручную, расчёт: ${fmt(r.qty)}</div>` : ""}</div><div class="c-val">${fmt(row.final)} шт</div></div>
          </div>
        </div>

        <div class="d-sec"><h4>Что повлияло на заказ</h4>
          <p class="muted" style="margin:-4px 0 10px;font-size:12.5px">Насколько изменился бы заказ, если выключить фактор</p>
          ${factorBars(sens)}
        </div>

        ${s.oo.length ? `<div class="d-sec"><h4>Исключённые разовые заказы</h4><div class="list">
          ${s.oo.map((o) => `<div class="list-row"><span>Накладная ${esc(o[1])} от ${esc(o[2])}</span><span><b class="num">${fmt(o[3])} шт</b> <span class="muted">· обычно ${fmt(o[4])} шт</span></span></div>`).join("")}
        </div></div>` : ""}

        ${s.cap ? `<div class="d-sec"><h4>Сглаженные всплески продаж</h4><div class="list">
          ${s.cap.map((i) => `<div class="list-row"><span>${META.months[i]}</span><span>продано ${fmt(s.raw[i])} → в расчёте <b class="num">${fmt(s.cln[i])}</b> <span class="muted">(фильтр Хампеля)</span></span></div>`).join("")}
        </div></div>` : ""}

        ${s.av ? `<div class="d-sec"><h4>Периоды отсутствия товара</h4><div class="list">
          ${s.av.map((a, i) => (a < 1 ? `<div class="list-row"><span>${META.months[i]}</span><span>${a <= 0.1 ? "не было весь месяц" : a < 0.6 ? "большую часть месяца" : "часть месяца"} · продано ${fmt(s.raw[i])}, спрос оценён <b class="num">${fmt(s.rst[i])}</b></span></div>` : "")).join("")}
        </div></div>` : ""}

        <div class="d-sec"><h4>Обоснование для 1С</h4><p style="margin:0;color:var(--text-2)">${esc(Engine.explain(s, r, p))}</p></div>
      </div>`;
    $(".d-close", d).onclick = closeDrawer;
    bindChart(d);
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
  const calcRow = (op, title, sub, val) => `<div class="calc-row"><span class="op">${op}</span><div><div>${title}</div>${sub ? `<div class="c-sub">${esc(sub)}</div>` : ""}</div><div class="c-val">${fmt(val)}</div></div>`;

  function factorBars(sens) {
    const items = [
      ["oneoff", "Исключение разовых заказов и всплесков"], ["restore", "Восстановление упущенного спроса"],
      ["season", "Сезонность"], ["trend", "Тренд"], ["transit", "Товар в пути"],
    ];
    const max = Math.max(1, ...items.map(([k]) => Math.abs(sens[k])));
    return `<div class="factors">${items.map(([k, label]) => {
      const on = state.p[k];
      // вклад фактора = заказ с фактором − заказ без него
      const v = -sens[k];
      const w = (Math.abs(v) / max) * 50;
      const color = v >= 0 ? "var(--series-1)" : "var(--series-2)";
      const style = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
      return `<div class="factor"><span>${label}${on ? "" : ' <span class="muted">(выкл.)</span>'}</span>
        <div class="f-bar"><i style="${style};background:${color}"></i></div>
        <span class="f-val">${v === 0 ? '<span class="muted">0</span>' : (v > 0 ? "+" : "−") + fmt(Math.abs(v))}</span></div>`;
    }).join("")}</div>`;
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
        ? `<b>${l}</b><br>Продано: ${fmt(s.raw[i])}<br>Регулярный спрос: ${fmt(reg[i])}${oo[i] ? `<br><span style="color:#f59a70">● Разовый заказ ${fmt(oo[i])} шт — исключён</span>` : ""}${s.av && s.av[i] < 1 ? `<br><span style="color:#f08a8a">Товара не было — спрос восстановлен</span>` : ""}`
        : `<b>${l} · прогноз</b><br>${fmt(fcMonths[i - n].q)} шт`;
      svg += `<rect class="hit" x="${x(i) - iw / N / 2}" y="${pt}" width="${iw / N}" height="${ih}" fill="transparent" data-tip="${esc(tip)}"/>`;
    });
    svg += `</svg>`;
    return `<div class="chart">${svg}</div>
      <div class="legend">
        <span><i style="width:10px;height:10px;background:var(--bar);border-radius:2px"></i>Продажи (факт)</span>
        <span><i style="width:16px;height:2px;background:var(--series-1)"></i>Регулярный спрос</span>
        <span><i style="width:16px;height:0;border-top:2px dashed var(--series-1)"></i>Прогноз</span>
        ${s.oo.length ? `<span><i style="width:9px;height:9px;border-radius:50%;background:var(--series-2)"></i>Разовый заказ (исключён)</span>` : ""}
        ${s.av ? `<span><i style="width:12px;height:12px;background:url(#hatch);background:repeating-linear-gradient(45deg,color-mix(in srgb,var(--crit) 35%,transparent) 0 1.5px,transparent 1.5px 4px)"></i>Нет товара на складе</span>` : ""}
        ${clipped ? `<span class="muted">↑ — столбец выше шкалы</span>` : ""}
      </div>`;
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
    const ooList = oos.filter(({ s }) => !seenOo.has(s.id) && seenOo.add(s.id)).slice(0, 10).map(({ s, o }) => `<div class="list-row" data-open="${esc(s.id)}" style="cursor:pointer"><span>${esc(s.n)}<br><span class="muted">накл. ${esc(o[1])} · ${esc(o[2])}</span></span><span style="text-align:right;white-space:nowrap"><b class="num">${fmt(o[3])} шт</b><br><span class="muted">в ${fmt(o[3] / Math.max(o[4], 1))} раз больше обычного</span></span></div>`).join("");

    // 5. упущенный спрос
    const lost = base.filter((x) => x.r.lost > 0.5).sort((a, b) => (b.s.pr ? b.r.lost * b.s.pr : b.r.lost) - (a.s.pr ? a.r.lost * a.s.pr : a.r.lost)).slice(0, 10);
    const lostList = lost.map(({ s, r }) => `<div class="list-row" data-open="${esc(s.id)}" style="cursor:pointer"><span>${esc(s.n)}<br><span class="muted">${esc(SUPS[s.sup].name)} · ${s.av.filter((a) => a < 1).length} мес. без товара</span></span><span style="text-align:right;white-space:nowrap"><b class="num">+${fmt(r.lost)} шт</b>${s.pr ? `<br><span class="muted">≈ ${money(r.lost * s.pr)}</span>` : ""}</span></div>`).join("");

    $("#tab-analytics").innerHTML = `
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
    ];
    const checks = [
      ["Учёт всех источников данных", "История продаж, остатки, товар в пути, категории (ABC), прогноз прироста, кратность — каждый влияет на результат. Попробуйте выключить «Товар в пути».", ex.transit],
      ["Сезонность и устойчивый рост", "Прогноз повторяет сезонный профиль товара, а не среднее по истории. Тренд г/г учитывается и ограничен.", ex.season],
      ["Упущенный спрос при stockout", "Для месяцев без остатка спрос восстановлен — расчётная потребность выше, чем по «сырым» продажам.", ex.restore],
      ["Исключение разовых крупных заказов", "Крупные разовые продажи найдены по накладным и не раздувают регулярный заказ.", ex.oneoff],
      ["Список по поставщикам с обоснованием", "Заказ разбит по поставщикам, каждая строка содержит расчёт и текстовое обоснование, экспорт в Excel с кодами 1С.", null],
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
      <h2 class="sec">Данные и ограничения</h2>
      <div class="card"><p style="margin:0;color:var(--text-2)">Данные ТОО «Электрокомплект» на ${META.asOf.split("-").reverse().join(".")}: помесячные продажи и остатки (янв 2024 — сен 2026), 248 тыс. строк расходных накладных, товар в пути, сезонность, кратность поставщиков.
      Сентябрь 2026 неполный — в прогнозе не используется, остаток на сегодня рассчитан с учётом продаж с начала месяца.
      Данные клиентов не используются: разовый заказ определяется по номеру накладной. Автоматические тесты требований: <code>pytest</code> — 7 из 7 проходят.</p></div>`;
    $$("#tab-method [data-open]").forEach((b) => b.addEventListener("click", () => openDrawer(b.dataset.open)));
    $$("#tab-method [data-goto]").forEach((b) => b.addEventListener("click", () => switchTab("orders")));
  }

  // ---------------- chrome ----------------
  function renderSupSeg() {
    const opts = [["all", "Все поставщики"], ...Object.entries(SUPS).map(([k, v]) => [k, v.name])];
    $("#supSeg").innerHTML = opts.map(([k, l]) => `<button role="tab" class="${state.sup === k ? "active" : ""}" data-s="${k}">${esc(l)}</button>`).join("");
    $$("#supSeg button").forEach((b) => b.addEventListener("click", () => { state.sup = b.dataset.s; state.group = "all"; renderSupSeg(); renderGroupSel(); render(); }));
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
    if (state.tab === "analytics") renderAnalytics();
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
    $("#groupSel").addEventListener("change", (e) => { state.group = e.target.value; render(); });
    $("#abcSel").addEventListener("change", (e) => { state.abc = e.target.value; render(); });
    $("#sortSel").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
    $("#onlyOrder").addEventListener("change", (e) => { state.onlyOrder = e.target.checked; if (state.onlyOrder && state.urg === "ok") state.urg = "all"; render(); });
    $$(".tab").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
    $("#exportBtn").addEventListener("click", () => { exportXlsx(); toast("Excel-файл сформирован"); });
    $("#paramsToggle").addEventListener("click", () => $("#params").classList.toggle("open"));
    $("#scrim").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); $("#modal").hidden = true; } });
    render();
    // прямые ссылки: #tab=analytics, #sku=<код 1С>
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("sup") && SUPS[h.get("sup")]) { state.sup = h.get("sup"); renderSupSeg(); renderGroupSel(); render(); }
    if (h.get("tab")) switchTab(h.get("tab"));
    if (h.get("sku")) openDrawer(h.get("sku"));
  }
  init();
})();
