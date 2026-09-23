/* Блок «Охват данных»: путь от исходного каталога до рекомендаций и причины исключения SKU. */
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const n = (x) => (x == null ? "—" : Number(x).toLocaleString("ru-RU"));
  const pct = (x, of) => (x == null || !of ? "" : `${Math.round((100 * x) / of)}% каталога`);

  window.renderCoverage = function (el, cov) {
    if (!el) return;
    if (!cov) { el.innerHTML = '<div class="card"><p class="muted" style="margin:0">Нет данных об охвате: пересоберите данные (python -m engine.build).</p></div>'; return; }
    const steps = [
      ["Исходный каталог", cov.catalog, "все коды 1С из файлов продаж и остатков"],
      ["Есть данные", cov.withData, "хотя бы одна продажа или остаток"],
      ["Опубликовано", cov.published, "есть спрос за 6 мес., остаток или товар в пути"],
      ["В прогнозе", cov.forecastable, "3+ месяцев истории и ненулевой спрос"],
      ["Рекомендовано к заказу", cov.recommended, "базовый сценарий"],
    ];
    const sups = Object.entries(cov.bySupplier || {});
    el.innerHTML = `<div class="card">
      <p class="c-desc" style="margin-bottom:12px">Сервис охватывает не весь каталог: часть кодов не продаётся и не лежит на складе. Здесь видно, сколько товаров дошло до прогноза и почему остальные исключены.</p>
      <div class="bstats">${steps.map(([l, v, s]) => `<div class="fact"><div class="f-l">${esc(l)}</div><div class="f-v num">${n(v)}</div><div class="f-s">${esc(s)}${v != null && l !== "Исходный каталог" ? ` · ${pct(v, cov.catalog)}` : ""}</div></div>`).join("")}</div>
      <h4 style="margin:6px 0 8px">Исключено из сервиса: ${n(cov.excluded)}</h4>
      <div class="list">${(cov.reasons || []).filter((r) => r.count).map((r) => `<div class="list-row"><span>${esc(r.label)}</span><b class="num">${n(r.count)}</b></div>`).join("") || '<div class="list-row"><span>Нет</span></div>'}</div>
      <h4 style="margin:14px 0 8px">Опубликованы с пометкой</h4>
      <div class="list">${(cov.notices || []).map((r) => `<div class="list-row"><span>${esc(r.label)}</span><b class="num">${n(r.count)}</b></div>`).join("")}</div>
      ${sups.length ? `<div class="table-wrap" style="margin-top:14px"><table class="cmp"><thead><tr><th>Поставщик</th><th>Каталог</th><th>Опубликовано</th><th>Исключено</th></tr></thead><tbody>
        ${sups.map(([k, v]) => `<tr><td>${esc(k === "SE" ? "Systeme Electric" : k)}</td><td class="num">${n(v.catalog)}</td><td class="num">${n(v.published)}</td><td class="num">${n(v.excluded)}</td></tr>`).join("")}
      </tbody></table></div>` : ""}
    </div>`;
  };
})();
