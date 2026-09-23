// Проверки функций интерфейса, которых нет в Python: цены, бюджет, экспорт.
module.exports = (Engine, input) => {
  const p = input.unit.p;
  const mk = (id, pr, final, status, urgency, stockout) => ({
    s: { id, pr, abc: "A", n: "Товар " + id, art: "0012", sup: "SE", tr: [], mq: 1 },
    r: { status, urgency, stockoutDay: stockout, deficitLead: 10, qty: final, stock: 0, transit: 0, transitNoEta: 0,
         monthly: 10, safeDay: -3, moq: 1, demandH: 1, safety: 1, need: 1, leadDays: 45 },
    final,
  });
  const rows = [
    mk("0001234_", 100, 10, "now", "critical", 0),        // 1 000 ₸
    mk("0005678_", null, 50, "now", "critical", 0),       // цены нет — критичная
    mk("0009999_", 0, 5, "overdue", "critical", 2),       // цена 0 = нет цены
    mk("0000042_", 200, 20, "later", "planned", 90),      // 4 000 ₸
  ];
  const cov = Engine.priceCoverage(rows);
  const budget = Engine.allocateBudget(rows, 1500);
  const noBudget = Engine.allocateBudget(rows, 0);
  const ctx = { supName: () => "Systeme Electric", urgLabel: (u) => u, approval: () => "Черновик" };
  const exp = Engine.exportRows(rows.map((x) => ({ ...x, r: { ...x.r, status: x.r.status } })), p, ctx);
  const today = (safeDay, final) => Engine.isOrderToday({ final, r: { safeDay } });
  return {
    orderToday: [today(-1, 0), today(0, 5), today(3, 5), today(null, 5), today(-10, 1)],
    coverage: cov,
    budget: { mark: budget.mark, spent: budget.spent, criticalNoPrice: budget.criticalNoPrice.map((x) => x.s.id) },
    noBudget,
    exportRows: exp,
  };
};
