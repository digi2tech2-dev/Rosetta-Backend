const assert = require("assert");
const orderModel = require("../models/orders");
const { ordersController } = require("../controller/orders");
const whatsappService = require("../services/whatsappService");
const { requireRole } = require("../middleware/auth");

const ORDER_ID = "507f1f77bcf86cd799439011";
const baseOrder = () => ({
  _id: ORDER_ID,
  orderNumber: "ROS-12345",
  orderStatus: "pending",
  shippingAddress: { phone: "+20 101 234 5678" },
});

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function send(orderId = ORDER_ID) {
  const res = response();
  await ordersController.sendAdminWhatsappConfirmation({ params: { orderId } }, res);
  return res;
}

async function main() {
  const originalFindById = orderModel.findById;
  const originalSendText = whatsappService.sendText;
  let currentOrder = baseOrder();
  let sendCalls = [];

  orderModel.findById = () => ({ lean: async () => currentOrder });
  whatsappService.sendText = async (payload) => {
    sendCalls.push(payload);
    return { providerMessageId: "message-1" };
  };

  try {
    const before = JSON.parse(JSON.stringify(currentOrder));
    const success = await send();
    assert.strictEqual(success.statusCode, 200);
    assert.strictEqual(success.body.success, true);
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(sendCalls[0].recipient, "201012345678");
    assert.match(sendCalls[0].message, /#ROS-12345/);
    assert.match(sendCalls[0].message, /✅ تأكيد/);
    assert.match(sendCalls[0].message, /❌ رفض/);
    assert.deepStrictEqual(currentOrder, before, "confirmation sending must not change the order");

    const forbidden = response();
    let nextCalled = false;
    await requireRole("admin")({ auth: { role: 0 } }, forbidden, () => { nextCalled = true; });
    assert.strictEqual(forbidden.statusCode, 403);
    assert.strictEqual(nextCalled, false);

    currentOrder = { ...baseOrder(), shippingAddress: { phone: "invalid" } };
    sendCalls = [];
    const invalidPhone = await send();
    assert.strictEqual(invalidPhone.statusCode, 400);
    assert.strictEqual(invalidPhone.body.code, "INVALID_RECIPIENT");
    assert.strictEqual(sendCalls.length, 0);

    currentOrder = baseOrder();
    whatsappService.sendText = async () => {
      throw Object.assign(new Error("OpenWA authentication failed"), { code: "OPENWA_AUTH_FAILED", status: 401 });
    };
    const openwaFailure = await send();
    assert.strictEqual(openwaFailure.statusCode, 502);
    assert.strictEqual(openwaFailure.body.code, "OPENWA_AUTH_FAILED");
    assert.strictEqual(currentOrder.orderStatus, "pending");

    currentOrder = baseOrder();
    let releaseSend;
    let concurrentCalls = 0;
    whatsappService.sendText = () => {
      concurrentCalls += 1;
      return new Promise((resolve) => { releaseSend = () => resolve({ providerMessageId: "message-2" }); });
    };
    const first = send();
    await Promise.resolve();
    await Promise.resolve();
    const second = await send();
    assert.strictEqual(second.statusCode, 409);
    assert.strictEqual(second.body.code, "WHATSAPP_CONFIRMATION_IN_PROGRESS");
    assert.strictEqual(concurrentCalls, 1);
    releaseSend();
    const firstResult = await first;
    assert.strictEqual(firstResult.statusCode, 200);

    console.log("ADMIN_WHATSAPP_CONFIRMATION_UNIT_PASS");
  } finally {
    orderModel.findById = originalFindById;
    whatsappService.sendText = originalSendText;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
