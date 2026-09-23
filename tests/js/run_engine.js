// Запускает web/engine.js в Node на наборе случаев из stdin и печатает результаты в JSON.
// Используется tests/test_parity.py для сверки с эталоном на Python.
const fs = require("fs");
const path = require("path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
globalThis.DATA = { meta: input.meta, skus: [] };
const Engine = require(path.join(__dirname, "..", "..", "web", "engine.js"));
const out = input.cases.map(({ sku, p }) => {
  const r = Engine.plan(sku, p);
  return { qty: r.qty, need: r.need, safety: r.safety, stockout: r.stockoutDay, safe: r.safeDay,
           status: r.status, urgency: r.urgency, deficit: r.deficit, transit: r.transit, noEta: r.transitNoEta };
});
let extra = {};
if (input.unit) extra = require(path.join(__dirname, "unit.js"))(Engine, input);
process.stdout.write(JSON.stringify({ out, extra }));
