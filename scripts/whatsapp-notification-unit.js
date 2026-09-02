const assert = require("assert");
const { normalizeEgyptWhatsAppRecipient } = require("../utils/whatsappPhone");
const { formatOrderCreated, formatOrderStatusChanged } = require("../services/whatsappMessageFormatter");
const { retryDelay } = require("../services/notificationDispatcher");
const { config } = require("../config/appConfig");
const notificationOutboxModel = require("../models/notificationOutbox");
const { enqueueOrderCreated, enqueueOrderStatusChanged } = require("../services/orderNotificationService");
const { sendText } = require("../services/whatsappService");

function throwsInvalid(value) {
  assert.throws(() => normalizeEgyptWhatsAppRecipient(value), (err) => err.code === "INVALID_RECIPIENT");
}

const order = {
  _id: "order-test",
  orderNumber: "RTEST123",
  items: [{ name: "منتج تجريبي", quantity: 2 }],
  total: 250,
  currency: "EGP",
  paymentMethod: "cash_on_delivery",
  orderStatus: "pending",
};

assert.strictEqual(normalizeEgyptWhatsAppRecipient("01012345678"), "201012345678");
assert.strictEqual(normalizeEgyptWhatsAppRecipient("201012345678"), "201012345678");
assert.strictEqual(normalizeEgyptWhatsAppRecipient("+201012345678"), "201012345678");
assert.strictEqual(normalizeEgyptWhatsAppRecipient("00201012345678"), "201012345678");
throwsInvalid("0112345678");
assert.match(formatOrderCreated(order), /RTEST123/);
assert.match(formatOrderStatusChanged(order, "shipped"), /تم شحن الطلب/);
assert.strictEqual(retryDelay(1), 60 * 1000);
assert.strictEqual(retryDelay(2), 5 * 60 * 1000);
assert(notificationOutboxModel.schema.indexes().some(([fields, options]) => fields.eventKey === 1 && options.unique));

async function main() {
  const original = {
    openwaEnabled: config.openwaEnabled,
    openwaBaseUrl: config.openwaBaseUrl,
    openwaApiKey: config.openwaApiKey,
    openwaSessionId: config.openwaSessionId,
    openwaTimeoutMs: config.openwaTimeoutMs,
    create: notificationOutboxModel.create,
    fetch: global.fetch,
  };
  try {
    let createCalls = 0;
    notificationOutboxModel.create = async () => { createCalls += 1; return {}; };
    config.openwaEnabled = false;
    await enqueueOrderCreated({ ...order, shippingAddress: { phone: "01012345678" } });
    assert.strictEqual(createCalls, 0, "disabled OpenWA must not create outbox events");

    config.openwaEnabled = true;
    config.openwaBaseUrl = "https://openwa.example.test";
    config.openwaApiKey = "test-key";
    config.openwaSessionId = "11111111-1111-4111-8111-111111111111";
    config.openwaTimeoutMs = 1000;
    let request;
    global.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 201, headers: { "content-type": "application/json" } });
    };
    const sent = await sendText({ recipient: "201012345678", message: "test" });
    assert.strictEqual(sent.providerMessageId, "message-1");
    assert.match(request.url, /\/api\/sessions\/11111111-1111-4111-8111-111111111111\/messages\/send-text$/);
    assert.strictEqual(request.options.headers["X-API-Key"], "test-key");
    assert.deepStrictEqual(JSON.parse(request.options.body), { chatId: "201012345678@c.us", text: "test" });

    global.fetch = async () => new Response(JSON.stringify({ message: "not ready" }), { status: 409 });
    await assert.rejects(() => sendText({ recipient: "201012345678", message: "test" }), (err) => err.retryable === true);
    global.fetch = async () => new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    await assert.rejects(() => sendText({ recipient: "201012345678", message: "test" }), (err) => err.code === "OPENWA_AUTH_FAILED" && err.retryable === false);

    let invalidEvent;
    notificationOutboxModel.create = async (event) => { invalidEvent = event; return event; };
    await enqueueOrderCreated({ ...order, shippingAddress: { phone: "invalid" } });
    assert.strictEqual(invalidEvent.status, "dead");
    assert.strictEqual(invalidEvent.lastErrorCode, "INVALID_RECIPIENT");

    notificationOutboxModel.create = async () => { const err = new Error("duplicate"); err.code = 11000; throw err; };
    const duplicate = await enqueueOrderCreated({ ...order, shippingAddress: { phone: "01012345678" } });
    assert.strictEqual(duplicate.duplicate, true);
    const statusDuplicate = await enqueueOrderStatusChanged({ ...order, shippingAddress: { phone: "01012345678" } }, "pending", "confirmed");
    assert.strictEqual(statusDuplicate.duplicate, true);
  } finally {
    config.openwaEnabled = original.openwaEnabled;
    config.openwaBaseUrl = original.openwaBaseUrl;
    config.openwaApiKey = original.openwaApiKey;
    config.openwaSessionId = original.openwaSessionId;
    config.openwaTimeoutMs = original.openwaTimeoutMs;
    notificationOutboxModel.create = original.create;
    global.fetch = original.fetch;
  }
  console.log("WHATSAPP_NOTIFICATION_UNIT_PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
