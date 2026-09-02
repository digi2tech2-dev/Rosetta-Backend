const { config } = require("../config/appConfig");
const notificationOutboxModel = require("../models/notificationOutbox");
const { normalizeOrderWhatsAppRecipient } = require("../utils/whatsappPhone");
const { formatOrderCreated, formatOrderStatusChanged } = require("./whatsappMessageFormatter");

function orderId(order) {
  return String(order && (order._id || order.id) || "");
}

function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}

function safeErrorMessage(err) {
  return String(err && err.message || "Notification event could not be created").slice(0, 500);
}

async function createEvent({ eventKey, eventType, order, message, payload }) {
  if (!config.openwaEnabled) return { skipped: "disabled" };
  const id = orderId(order);
  if (!id) {
    console.error("WhatsApp notification enqueue skipped: order ID is missing");
    return { skipped: "missing_order" };
  }

  let recipient;
  try {
    recipient = normalizeOrderWhatsAppRecipient(order);
  } catch (err) {
    try {
      await notificationOutboxModel.create({
        eventKey,
        eventType,
        order: id,
        recipient: "invalid",
        message,
        payload,
        status: "dead",
        maxAttempts: config.whatsappMaxAttempts,
        failedAt: new Date(),
        lastErrorCode: err.code || "INVALID_RECIPIENT",
        lastErrorMessage: safeErrorMessage(err),
      });
    } catch (createErr) {
      if (!isDuplicateKeyError(createErr)) console.error("WhatsApp notification enqueue failed", createErr.message);
    }
    return { skipped: "invalid_recipient" };
  }

  try {
    const event = await notificationOutboxModel.create({
      eventKey,
      eventType,
      order: id,
      recipient,
      message,
      payload,
      maxAttempts: config.whatsappMaxAttempts,
    });
    return { event, enqueued: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) return { duplicate: true };
    console.error("WhatsApp notification enqueue failed", err.message);
    return { skipped: "enqueue_error" };
  }
}

async function safeEnqueue(buildEvent) {
  try {
    return await buildEvent();
  } catch (err) {
    console.error("WhatsApp notification enqueue failed", safeErrorMessage(err));
    return { skipped: "enqueue_error" };
  }
}

function enqueueOrderCreated(order, context = {}) {
  return safeEnqueue(() => {
    const id = orderId(order);
    return createEvent({
      eventKey: `order:${id}:created`,
      eventType: "order_created",
      order,
      message: formatOrderCreated(order, context),
      payload: { paymentPending: Boolean(context.paymentPending), orderNumber: order.orderNumber || "" },
    });
  });
}

function enqueueOrderStatusChanged(order, previousStatus, nextStatus, context = {}) {
  return safeEnqueue(() => {
    const id = orderId(order);
    return createEvent({
      eventKey: `order:${id}:status:${previousStatus}:${nextStatus}`,
      eventType: "order_status_changed",
      order,
      message: formatOrderStatusChanged(order, nextStatus),
      payload: { previousStatus, nextStatus, orderNumber: order.orderNumber || "", ...context },
    });
  });
}

module.exports = {
  enqueueOrderCreated,
  enqueueOrderStatusChanged,
};
