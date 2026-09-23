// Проверка онлайн-версии «Умного Закупа». Запускается GitHub Actions каждые 3 часа
// (работает на серверах GitHub, компьютер разработчика не нужен).
//   node scripts/check_site.js [https://umny-zakup.vercel.app]
// Код выхода 1 — сайт недоступен, данные битые или онлайн-версия отличается от репозитория.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const BASE = (process.argv[2] || process.env.SITE_URL || "https://umny-zakup.vercel.app").replace(/\/$/, "");
const ROOT = path.join(__dirname, "..");
const problems = [];
const report = [];
const ok = (msg) => report.push(`✅ ${msg}`);
const fail = (msg) => { problems.push(msg); report.push(`❌ ${msg}`); };

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, { redirect: "follow", headers: { "cache-control": "no-cache" } });
      const body = Buffer.from(await res.arrayBuffer());
      return { res, body, ms: Date.now() - t0 };
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

(async () => {
  // 1. страницы и файлы доступны
  const files = ["/", "/styles.css", "/app.js", "/engine.js", "/data.js", "/vendor/xlsx.full.min.js", "/sw.js", "/manifest.webmanifest"];
  const got = {};
  for (const f of files) {
    try {
      const { res, body, ms } = await get(BASE + f);
      got[f] = { res, body };
      if (res.status === 200 && body.length > 0) ok(`${f} — 200, ${Math.round(body.length / 1024)} КБ, ${ms} мс`);
      else fail(`${f} — HTTP ${res.status}`);
    } catch (e) {
      fail(`${f} — нет ответа (${e.message})`);
    }
  }
  const home = got["/"];
  if (home && home.res.status === 200) {
    const html = home.body.toString("utf8");
    html.includes("Умный Закуп") ? ok("главная страница содержит «Умный Закуп»") : fail("на главной нет заголовка «Умный Закуп»");
    (home.res.headers.get("x-robots-tag") || "").includes("noindex") ? ok("индексация поисковиками отключена") : fail("нет заголовка noindex");
  }

  // 2. данные на сайте совпадают с репозиторием
  const live = got["/data.js"];
  const localPath = path.join(ROOT, "web", "data.js");
  if (live && live.res.status === 200 && fs.existsSync(localPath)) {
    const h = (b) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 12);
    const a = h(live.body), b = h(fs.readFileSync(localPath));
    a === b ? ok(`data.js на сайте совпадает с репозиторием (${a})`)
            : fail(`data.js на сайте (${a}) отличается от репозитория (${b}) — обновите онлайн-версию: npx vercel deploy --prod`);
  }

  // 3. расчёт работает на живых файлах: прогон всех товаров
  if (live && got["/engine.js"] && live.res.status === 200) {
    try {
      const ctx = { console };
      ctx.window = ctx; ctx.globalThis = ctx;
      vm.createContext(ctx);
      vm.runInContext(live.body.toString("utf8"), ctx);
      vm.runInContext(got["/engine.js"].body.toString("utf8") + "\n;globalThis.__E = Engine;", ctx);
      const E = ctx.__E, D = ctx.DATA;
      const p = { lead: Object.fromEntries(Object.entries(D.meta.suppliers).map(([k, v]) => [k, v.lead])), review: 1, growth: 0,
        oneoff: true, restore: true, season: true, trend: true, transit: true, scenario: "base", buffer: D.meta.buffer };
      let order = 0, bad = 0;
      for (const s of D.skus) {
        const r = E.calc(s, p);
        if (![r.qty, r.need, r.safety, r.stock].every(Number.isFinite)) bad++;
        if (r.qty > 0) order++;
      }
      D.skus.length > 1000 ? ok(`в данных ${D.skus.length} артикулов, дата выгрузки ${D.meta.asOf}`) : fail(`слишком мало артикулов: ${D.skus.length}`);
      bad === 0 ? ok("расчёт по всем артикулам без ошибок (нет NaN/Infinity)") : fail(`расчёт дал некорректные числа по ${bad} артикулам`);
      order > 0 ? ok(`рекомендовано к заказу: ${order} позиций`) : fail("расчёт не рекомендовал ни одной позиции");
    } catch (e) {
      fail(`расчёт на живых файлах упал: ${e.message}`);
    }
  }

  const title = problems.length ? `❌ Сайт ${BASE}: проблем — ${problems.length}` : `✅ Сайт ${BASE} работает`;
  const text = [`## ${title}`, "", `Проверка: ${new Date().toISOString()}`, "", ...report].join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
  process.exit(problems.length ? 1 : 0);
})();
