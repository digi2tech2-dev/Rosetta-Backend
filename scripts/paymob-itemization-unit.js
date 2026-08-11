const assert = require("assert");
const { buildProviderItemsForCheckout } = require("../services/payments/paymentService");

function cents(value) {
  return Math.round(Number(value) * 100);
}

function sum(items) {
  return items.reduce((total, item) => total + item.amountMinor, 0);
}

function checkout({ items, grandTotal, shippingFee }) {
  return {
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      lineTotalCents: cents(item.lineTotal),
    })),
    summary: {
      grandTotal,
      shippingFee,
    },
  };
}

function assertReconciles(name, input, expected) {
  const rows = buildProviderItemsForCheckout(input);
  assert.strictEqual(sum(rows), cents(input.summary.grandTotal), `${name}: item rows must equal grand total`);
  if (expected.shippingCents !== undefined) {
    const shipping = rows.find((item) => item.name === "Shipping");
    assert.strictEqual(shipping ? shipping.amountMinor : 0, expected.shippingCents, `${name}: shipping row mismatch`);
  }
  if (expected.productCents !== undefined) {
    const productTotal = rows.filter((item) => item.name !== "Shipping").reduce((total, item) => total + item.amountMinor, 0);
    assert.strictEqual(productTotal, expected.productCents, `${name}: product row total mismatch`);
  }
  assert(rows.every((item) => item.amountMinor >= 0 && item.quantity === 1), `${name}: rows must be non-negative single rows`);
}

assertReconciles(
  "normal order 500 + 90",
  checkout({
    items: [{ name: "Normal Product", quantity: 1, lineTotal: 500 }],
    shippingFee: 90,
    grandTotal: 590,
  }),
  { productCents: 50000, shippingCents: 9000 }
);

assertReconciles(
  "bundle 145 + 199 => 300 + 90",
  checkout({
    items: [
      { name: "Product A", quantity: 1, lineTotal: 145 },
      { name: "Product B", quantity: 1, lineTotal: 199 },
    ],
    shippingFee: 90,
    grandTotal: 390,
  }),
  { productCents: 30000, shippingCents: 9000 }
);

assertReconciles(
  "bundle quantity 2 with 50 percent shipping",
  checkout({
    items: [
      { name: "Product A", quantity: 2, lineTotal: 290 },
      { name: "Product B", quantity: 2, lineTotal: 398 },
    ],
    shippingFee: 45,
    grandTotal: 645,
  }),
  { productCents: 60000, shippingCents: 4500 }
);

assertReconciles(
  "bundle plus coupon",
  checkout({
    items: [
      { name: "Product A", quantity: 1, lineTotal: 145 },
      { name: "Product B", quantity: 1, lineTotal: 199 },
    ],
    shippingFee: 90,
    grandTotal: 360,
  }),
  { productCents: 27000, shippingCents: 9000 }
);

assertReconciles(
  "bundle with free shipping",
  checkout({
    items: [
      { name: "Product A", quantity: 2, lineTotal: 290 },
      { name: "Product B", quantity: 2, lineTotal: 398 },
    ],
    shippingFee: 0,
    grandTotal: 600,
  }),
  { productCents: 60000, shippingCents: 0 }
);

console.log("PAYMOB_ITEMIZATION_UNIT_PASS");
