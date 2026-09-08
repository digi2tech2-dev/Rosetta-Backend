const assert = require("assert");
const orderModel = require("../models/orders");
const notificationOutboxModel = require("../models/notificationOutbox");
const { ordersController } = require("../controller/orders");
const whatsappService = require("../services/whatsappService");
const { config } = require("../config/appConfig");
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
  const original = {
    findById: orderModel.findById,
    create: notificationOutboxModel.create,
    sendText: whatsappService.sendText,
    openwaEnabled: config.openwaEnabled,
  };
  let currentOrder = baseOrder();
  const queuedEvents = [];

  orderModel.findById = () => ({ lean: async () => currentOrder });
  notificationOutboxModel.create = async (event) => {
    if (queuedEvents.some((queued) => queued.eventKey === event.eventKey)) {
      const err = new Error("duplicate");
      err.code = 11000;
      throw err;
    }
    queuedEvents.push(event);
    return event;
  };
  whatsappService.sendText = async () => {
    throw new Error("manual confirmation must not call OpenWA directly");
  };
  config.openwaEnabled = true;

  try {
    const before = JSON.parse(JSON.stringify(currentOrder));
    const success = await send();
    assert.strictEqual(success.statusCode, 202);
    assert.strictEqual(success.body.success, true);
    assert.strictEqual(success.body.queued, true);
    assert.strictEqual(success.body.duplicate, false);
    assert.strictEqual(queuedEvents.length, 1);
    assert.strictEqual(queuedEvents[0].eventType, "admin_order_confirmation");
    assert.strictEqual(queuedEvents[0].eventKey, `order:${ORDER_ID}:admin-confirmation`);
    assert.strictEqual(queuedEvents[0].recipient, "201012345678");
    assert.match(queuedEvents[0].message, /#ROS-12345/);
    assert.match(queuedEvents[0].message, /✅ تأكيد/);
    assert.match(queuedEvents[0].message, /❌ رفض/);
    assert.deepStrictEqual(currentOrder, before, "confirmation queuing must not change the order");

    const duplicate = await send();
    assert.strictEqual(duplicate.statusCode, 200);
    assert.strictEqual(duplicate.body.success, true);
    assert.strictEqual(duplicate.body.queued, true);
    assert.strictEqual(duplicate.body.duplicate, true);
    assert.strictEqual(queuedEvents.length, 1, "duplicate confirmation must not create another event");

    const forbidden = response();
    let nextCalled = false;
    await requireRole("admin")({ auth: { role: 0 } }, forbidden, () => { nextCalled = true; });
    assert.strictEqual(forbidden.statusCode, 403);
    assert.strictEqual(nextCalled, false);

    currentOrder = { ...baseOrder(), shippingAddress: { phone: "invalid" } };
    const invalidPhone = await send();
    assert.strictEqual(invalidPhone.statusCode, 400);
    assert.strictEqual(invalidPhone.body.code, "INVALID_RECIPIENT");
    assert.strictEqual(queuedEvents.length, 1);

    console.log("ADMIN_WHATSAPP_CONFIRMATION_UNIT_PASS");
  } finally {
    orderModel.findById = original.findById;
    notificationOutboxModel.create = original.create;
    whatsappService.sendText = original.sendText;
    config.openwaEnabled = original.openwaEnabled;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
