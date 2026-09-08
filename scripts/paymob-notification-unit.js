const assert = require("assert");
const paymentService = require("../services/payments/paymentService");
const orderNotificationService = require("../services/orderNotificationService");

async function main() {
  const original = orderNotificationService.enqueueOrderCreated;
  const calls = [];
  orderNotificationService.enqueueOrderCreated = async (...args) => {
    calls.push(args);
    return { enqueued: true };
  };
  try {
    const order = { _id: "paymob-order", orderNumber: "RPAYMOB" };
    const unpaid = await paymentService.notifyVerifiedPaymobPayment(order, false);
    assert.strictEqual(unpaid.skipped, "payment_not_confirmed");
    assert.strictEqual(calls.length, 0, "unpaid Paymob order must not enqueue WhatsApp");

    await paymentService.notifyVerifiedPaymobPayment(order, true);
    assert.strictEqual(calls.length, 1, "verified Paymob payment must enqueue one initial notification");
    assert.strictEqual(calls[0][0], order);
    assert.deepStrictEqual(calls[0][1], { paymentPending: false });
    console.log("PAYMOB_NOTIFICATION_UNIT_PASS");
  } finally {
    orderNotificationService.enqueueOrderCreated = original;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
