const assert = require("assert");
const { calculateAnalytics, orderFinancials } = require("../services/analyticsService");

const deliveredAt = new Date("2026-09-06T10:00:00.000Z");
const baseOrder = {
  _id: "delivered-1", orderStatus: "delivered", deliveredAt, paymentMethod: "cash_on_delivery",
  total: 320, shippingFee: 50, subtotal: 200, discountTotal: 30,
  items: [
    { unitPrice: 100, lineTotal: 100, costPrice: 40, quantity: 1 },
    { unitPrice: 100, lineTotal: 100, costPrice: 50, quantity: 1 },
  ],
  packaging: { assignments: [{ unitPrice: 100, costPrice: 35, quantity: 1 }] },
};

function test(name, callback) {
  callback();
  process.stdout.write(`✓ ${name}\n`);
}

test("discounts are allocated proportionally and shipping is excluded", () => {
  const result = orderFinancials(baseOrder);
  assert.deepStrictEqual(result.itemRevenue, [85, 85]);
  assert.strictEqual(result.productRevenue, 170);
  assert.strictEqual(result.productCost, 90);
  assert.strictEqual(result.packagingRevenue, 100);
  assert.strictEqual(result.packagingCost, 35);
  assert.strictEqual(result.realizedSales, 270);
  assert.strictEqual(result.costOfGoods, 125);
  assert.strictEqual(result.realizedProfit, 145);
  assert.strictEqual(result.shippingRevenue, 50);
});

test("free packaging with a cost reduces profit", () => {
  const result = orderFinancials({ ...baseOrder, packaging: { assignments: [{ unitPrice: 0, costPrice: 10, quantity: 1 }] } });
  assert.strictEqual(result.realizedSales, 170);
  assert.strictEqual(result.costOfGoods, 100);
  assert.strictEqual(result.realizedProfit, 70);
});

test("only delivered orders contribute realized values while returned orders count separately", () => {
  const returned = { ...baseOrder, _id: "returned-1", orderStatus: "returned", returnedAt: new Date("2026-09-06T11:00:00.000Z"), total: 320 };
  const pending = { ...baseOrder, _id: "pending", orderStatus: "pending", createdAt: deliveredAt };
  const shipped = { ...baseOrder, _id: "shipped", orderStatus: "shipped", createdAt: deliveredAt };
  const cancelled = { ...baseOrder, _id: "cancelled", orderStatus: "cancelled", createdAt: deliveredAt };
  const result = calculateAnalytics([baseOrder, returned, pending, shipped, cancelled], { range: "today" }, deliveredAt);
  assert.strictEqual(result.totals.realizedSales, 270);
  assert.strictEqual(result.totals.realizedProfit, 145);
  assert.strictEqual(result.totals.deliveredOrders, 1);
  assert.strictEqual(result.totals.returnedOrders, 1);
  assert.strictEqual(result.totals.returnedOrderValue, 320);
  assert.strictEqual(result.totals.returnRate, 50);
});

test("date, status, and payment method filters are server-calculated", () => {
  const cardOrder = { ...baseOrder, _id: "card", paymentMethod: "paymob_card", deliveredAt: new Date("2026-09-05T10:00:00.000Z") };
  const walletOrder = { ...baseOrder, _id: "wallet", paymentMethod: "paymob_wallet", deliveredAt: new Date("2026-08-31T10:00:00.000Z") };
  const all = [baseOrder, cardOrder, walletOrder];
  const card = calculateAnalytics(all, { range: "last_7_days", paymentMethod: "card" }, deliveredAt);
  assert.strictEqual(card.totals.deliveredOrders, 1);
  const custom = calculateAnalytics(all, { range: "custom", startDate: "2026-08-31", endDate: "2026-08-31" }, deliveredAt);
  assert.strictEqual(custom.totals.deliveredOrders, 1);
  const month = calculateAnalytics(all, { range: "this_month" }, deliveredAt);
  assert.strictEqual(month.totals.deliveredOrders, 2);
  const status = calculateAnalytics(all, { range: "today", orderStatus: "returned" }, deliveredAt);
  assert.strictEqual(status.totals.realizedSales, 0);
});

test("legacy missing cost snapshots contribute sales but never inflate realized profit", () => {
  const legacyOrder = { orderStatus: "delivered", deliveredAt, subtotal: 100, discountTotal: 10, items: [{ unitPrice: 100, quantity: 1 }] };
  const legacy = orderFinancials(legacyOrder);
  assert.strictEqual(legacy.productRevenue, 90);
  assert.strictEqual(legacy.productCost, null);
  assert.strictEqual(legacy.realizedProfit, null);
  assert.strictEqual(legacy.incompleteProfitItems, 1);
  const analytics = calculateAnalytics([legacyOrder], { range: "today" }, deliveredAt);
  assert.strictEqual(analytics.totals.realizedSales, 90);
  assert.strictEqual(analytics.totals.realizedProfit, 0);
  assert.strictEqual(analytics.totals.incompleteProfitOrders, 1);
  assert.strictEqual(analytics.totals.incompleteProfitItems, 1);
});

test("historical cost snapshots ignore later catalog cost edits", () => {
  const afterCatalogEdit = {
    ...baseOrder,
    items: baseOrder.items.map((item) => ({ ...item, product: { pCost: 9999, pPrice: 9999 } })),
  };
  assert.strictEqual(orderFinancials(afterCatalogEdit).realizedProfit, 145);
});

process.stdout.write("Realized analytics unit tests passed.\n");
