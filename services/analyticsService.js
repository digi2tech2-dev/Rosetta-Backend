const DAY_MS = 24 * 60 * 60 * 1000;

const ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "returned"];
const PAYMENT_METHOD_FILTERS = {
  cash_on_delivery: ["cash_on_delivery", "cash", "cod"],
  card: ["paymob_card", "card", "legacy_braintree"],
  wallet: ["paymob_wallet", "wallet"],
};

function moneyCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

function money(cents) {
  return Number((cents / 100).toFixed(2));
}

function canonicalStatus(order = {}) {
  if (order.orderStatus) return String(order.orderStatus).toLowerCase();
  return ({
    "Not processed": "pending", Processing: "processing", Shipped: "shipped",
    Delivered: "delivered", Cancelled: "cancelled", Returned: "returned",
  })[order.status] || "pending";
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function statusTimestamp(order, status) {
  const field = status === "delivered" ? order.deliveredAt : status === "returned" ? order.returnedAt : null;
  if (validDate(field)) return new Date(field);
  const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (String(history[index]?.status || "").toLowerCase() === status && validDate(history[index].changedAt)) {
      return new Date(history[index].changedAt);
    }
  }
  return validDate(order.createdAt) || validDate(order.updatedAt) || new Date(0);
}

function finiteCost(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? moneyCents(amount) : null;
}

function itemLineCents(item = {}) {
  const line = Number(item.lineTotal);
  if (Number.isFinite(line) && line >= 0) return moneyCents(line);
  return Math.max(0, moneyCents(item.unitPrice) * Math.max(0, Number(item.quantity) || 0));
}

function allocateProportionally(lines, totalCents) {
  const rawTotal = lines.reduce((sum, line) => sum + line, 0);
  if (!rawTotal || totalCents <= 0) return lines.map(() => 0);
  const target = Math.min(rawTotal, Math.max(0, totalCents));
  const allocations = lines.map((line, index) => {
    const exact = (target * line) / rawTotal;
    return { index, cents: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = target - allocations.reduce((sum, item) => sum + item.cents, 0);
  allocations.sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < allocations.length && remainder > 0; index += 1, remainder -= 1) allocations[index].cents += 1;
  return allocations.sort((left, right) => left.index - right.index).map((item) => item.cents);
}

// This reads only order snapshots. Missing historical costs are explicitly
// incomplete, never treated as zero or looked up from the mutable catalog.
function orderFinancials(order = {}) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemLines = items.map(itemLineCents);
  const persistedMerchandise = order.pricingSnapshot?.merchandiseSubtotal ?? order.subtotal;
  const rawProductRevenue = itemLines.reduce((sum, value) => sum + value, 0)
    || Math.max(0, moneyCents(persistedMerchandise ?? ((Number(order.total ?? order.amount ?? 0) || 0) - (Number(order.shippingFee) || 0) - (Number(order.packagingTotal) || 0))));
  const storedMerchandise = persistedMerchandise;
  const merchandiseBeforeOrderDiscount = Number.isFinite(Number(storedMerchandise))
    ? Math.min(rawProductRevenue, Math.max(0, moneyCents(storedMerchandise)))
    : rawProductRevenue;
  const discount = moneyCents(order.discountTotal ?? order.pricingSnapshot?.discountTotal ?? 0);
  const productRevenue = Math.max(0, merchandiseBeforeOrderDiscount - discount);
  const itemRevenue = allocateProportionally(itemLines, productRevenue);
  const knownProductCost = items.reduce((sum, item) => sum + (finiteCost(item.costPrice) ?? 0) * Math.max(0, Number(item.quantity) || 0), 0);
  const incompleteProfitItems = items.filter((item) => finiteCost(item.costPrice) === null).length
    || (!items.length && Array.isArray(order.allProduct) ? order.allProduct.length : 0)
    || (!items.length && rawProductRevenue > 0 ? 1 : 0);

  const assignments = Array.isArray(order.packaging?.assignments) ? order.packaging.assignments : [];
  const packagingRevenue = assignments.length
    ? assignments.reduce((sum, item) => sum + moneyCents(item.unitPrice) * Math.max(1, Number(item.quantity) || 1), 0)
    : moneyCents(order.packagingTotal ?? order.pricingSnapshot?.packagingTotal ?? order.packaging?.total ?? 0);
  const knownPackagingCost = assignments.reduce((sum, item) => sum + (finiteCost(item.costPrice) ?? 0) * Math.max(1, Number(item.quantity) || 1), 0);
  const incompletePackagingCostItems = assignments.filter((item) => finiteCost(item.costPrice) === null).length
    || (!assignments.length && packagingRevenue > 0 ? 1 : 0);
  const realizedSales = productRevenue + packagingRevenue;
  const profitComplete = incompleteProfitItems === 0 && incompletePackagingCostItems === 0;
  const costOfGoods = profitComplete ? knownProductCost + knownPackagingCost : null;

  return {
    itemRevenue: itemRevenue.map(money),
    productRevenue: money(productRevenue), productCost: profitComplete ? money(knownProductCost) : null,
    packagingRevenue: money(packagingRevenue), packagingCost: profitComplete ? money(knownPackagingCost) : null,
    realizedSales: money(realizedSales), costOfGoods: costOfGoods === null ? null : money(costOfGoods),
    realizedProfit: profitComplete ? money(realizedSales - costOfGoods) : null,
    shippingRevenue: money(moneyCents(order.shippingFee ?? order.pricingSnapshot?.shippingFee ?? 0)),
    profitComplete,
    incompleteProfitItems,
    incompletePackagingCostItems,
  };
}

function dayStart(value) {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function dayKey(value) {
  return dayStart(value).toISOString().slice(0, 10);
}

function chartGrouping(start, end) {
  const days = Math.floor((dayStart(end).getTime() - dayStart(start).getTime()) / DAY_MS) + 1;
  if (days > 366) return "monthly";
  if (days > 92) return "weekly";
  return "daily";
}

function chartBucket(value, grouping) {
  const date = dayStart(value);
  if (grouping === "monthly") return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  if (grouping === "weekly") {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    return new Date(date.getTime() - mondayOffset * DAY_MS);
  }
  return date;
}

function parseDateOnly(value, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function analyticsRange(query = {}, now = new Date()) {
  const range = String(query.range || "last_7_days").toLowerCase();
  const today = dayStart(now);
  let start; let end;
  if (range === "today") { start = today; end = new Date(today.getTime() + DAY_MS - 1); }
  else if (range === "yesterday") { start = new Date(today.getTime() - DAY_MS); end = new Date(today.getTime() - 1); }
  else if (range === "this_month") { start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)); end = new Date(today.getTime() + DAY_MS - 1); }
  else if (range === "previous_month") { start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)); end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 1); }
  else if (range === "custom") {
    start = parseDateOnly(query.startDate);
    end = parseDateOnly(query.endDate, true);
    if (!start || !end || end < start) throw Object.assign(new Error("A valid custom date range is required"), { status: 400, code: "VALIDATION_ERROR" });
  } else {
    start = new Date(today.getTime() - 6 * DAY_MS); end = new Date(today.getTime() + DAY_MS - 1);
  }
  return { range: ["today", "yesterday", "last_7_days", "this_month", "previous_month", "custom"].includes(range) ? range : "last_7_days", start, end };
}

function matchesPaymentMethod(order, paymentMethod) {
  if (!paymentMethod || paymentMethod === "all") return true;
  return (PAYMENT_METHOD_FILTERS[paymentMethod] || []).includes(order.paymentMethod);
}

function zeroTotals() {
  return { realizedSales: 0, realizedProfit: 0, costOfGoods: 0, deliveredOrders: 0, returnedOrders: 0, returnedOrderValue: 0, averageDeliveredOrderValue: 0, returnRate: 0, incompleteProfitOrders: 0, incompleteProfitItems: 0, incompletePackagingCostItems: 0 };
}

function calculateAnalytics(orders = [], query = {}, now = new Date()) {
  const { range, start, end } = analyticsRange(query, now);
  const statusFilter = !query.orderStatus || query.orderStatus === "all" ? "all" : String(query.orderStatus).toLowerCase();
  if (statusFilter !== "all" && !ORDER_STATUSES.includes(statusFilter)) throw Object.assign(new Error("Invalid orderStatus filter"), { status: 400, code: "VALIDATION_ERROR" });
  const paymentMethod = !query.paymentMethod || query.paymentMethod === "all" ? "all" : String(query.paymentMethod).toLowerCase();
  if (paymentMethod !== "all" && !PAYMENT_METHOD_FILTERS[paymentMethod]) throw Object.assign(new Error("Invalid payment method filter"), { status: 400, code: "VALIDATION_ERROR" });

  const selected = orders.filter((order) => {
    const status = canonicalStatus(order);
    const at = statusTimestamp(order, status);
    return (statusFilter === "all" || status === statusFilter) && matchesPaymentMethod(order, paymentMethod) && at >= start && at <= end;
  });
  const totalsCents = { sales: 0, profit: 0, cost: 0, returnedValue: 0 };
  let deliveredOrders = 0; let returnedOrders = 0; let incompleteProfitOrders = 0; let incompleteProfitItems = 0; let incompletePackagingCostItems = 0;
  const chart = new Map();
  const grouping = chartGrouping(start, end);
  selected.forEach((order) => {
    const status = canonicalStatus(order);
    const financials = orderFinancials(order);
    if (status === "delivered") {
      deliveredOrders += 1;
      totalsCents.sales += moneyCents(financials.realizedSales);
      if (financials.profitComplete) {
        totalsCents.profit += moneyCents(financials.realizedProfit);
        totalsCents.cost += moneyCents(financials.costOfGoods);
      } else {
        incompleteProfitOrders += 1;
        incompleteProfitItems += financials.incompleteProfitItems;
        incompletePackagingCostItems += financials.incompletePackagingCostItems;
      }
      const key = dayKey(chartBucket(statusTimestamp(order, status), grouping));
      const row = chart.get(key) || { date: key, sales: 0, profit: 0 };
      row.sales += moneyCents(financials.realizedSales);
      row.profit += financials.profitComplete ? moneyCents(financials.realizedProfit) : 0;
      chart.set(key, row);
    }
    if (status === "returned") {
      returnedOrders += 1;
      totalsCents.returnedValue += moneyCents(order.total ?? order.amount ?? 0);
    }
  });
  const days = [];
  for (let date = chartBucket(start, grouping); date <= end; date = grouping === "monthly"
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
    : new Date(date.getTime() + (grouping === "weekly" ? 7 : 1) * DAY_MS)) {
    const key = dayKey(date); const row = chart.get(key);
    days.push({ date: key, sales: money(row?.sales || 0), profit: money(row?.profit || 0) });
  }
  const totals = zeroTotals();
  totals.realizedSales = money(totalsCents.sales); totals.realizedProfit = money(totalsCents.profit); totals.costOfGoods = money(totalsCents.cost);
  totals.deliveredOrders = deliveredOrders; totals.returnedOrders = returnedOrders; totals.returnedOrderValue = money(totalsCents.returnedValue);
  totals.averageDeliveredOrderValue = deliveredOrders ? money(Math.round(totalsCents.sales / deliveredOrders)) : 0;
  totals.returnRate = deliveredOrders + returnedOrders ? Number(((returnedOrders / (deliveredOrders + returnedOrders)) * 100).toFixed(2)) : 0;
  totals.incompleteProfitOrders = incompleteProfitOrders;
  totals.incompleteProfitItems = incompleteProfitItems;
  totals.incompletePackagingCostItems = incompletePackagingCostItems;
  return { success: true, filters: { range, startDate: dayKey(start), endDate: dayKey(end), orderStatus: statusFilter, paymentMethod, grouping, dateBasis: "UTC day boundaries; current delivered/returned status timestamp, with creation time only when a legacy timestamp is unavailable" }, totals, chart: days, statusCounts: selected.reduce((counts, order) => { const status = canonicalStatus(order); counts[status] = (counts[status] || 0) + 1; return counts; }, {}) };
}

module.exports = { ORDER_STATUSES, PAYMENT_METHOD_FILTERS, analyticsRange, calculateAnalytics, canonicalStatus, orderFinancials, statusTimestamp };
