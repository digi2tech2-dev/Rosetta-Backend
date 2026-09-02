const crypto = require("crypto");
const { config } = require("../config/appConfig");
const notificationOutboxModel = require("../models/notificationOutbox");
const whatsappService = require("./whatsappService");

const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

function safeErrorMessage(err) {
  return String(err && err.message || "WhatsApp delivery failed").slice(0, 500);
}

function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

async function claimNextEvent(now = new Date()) {
  const lockToken = crypto.randomBytes(16).toString("hex");
  const staleBefore = new Date(now.getTime() - config.whatsappLockTimeoutMs);
  return notificationOutboxModel.findOneAndUpdate(
    {
      channel: "whatsapp",
      $or: [
        { status: "pending", nextAttemptAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: now, lockToken, lastAttemptAt: now },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
  ).select("+lockToken");
}

async function markSent(event, result, now = new Date()) {
  return notificationOutboxModel.updateOne(
    { _id: event._id, status: "processing", lockToken: event.lockToken },
    { $set: { status: "sent", sentAt: now, lockedAt: null, lockToken: null, providerMessageId: result.providerMessageId || null, lastErrorCode: null, lastErrorMessage: null } }
  );
}

async function markFailure(event, err, now = new Date()) {
  const terminal = err.retryable === false || event.attempts >= event.maxAttempts;
  const update = terminal
    ? { status: "dead", failedAt: now, lockedAt: null, lockToken: null }
    : { status: "pending", nextAttemptAt: new Date(now.getTime() + retryDelay(event.attempts)), lockedAt: null, lockToken: null };
  return notificationOutboxModel.updateOne(
    { _id: event._id, status: "processing", lockToken: event.lockToken },
    { $set: { ...update, lastErrorCode: err.code || "OPENWA_DELIVERY_FAILED", lastErrorMessage: safeErrorMessage(err) } }
  );
}

async function dispatchOne() {
  if (!config.openwaEnabled) return { skipped: "disabled" };
  const event = await claimNextEvent();
  if (!event) return { empty: true };
  try {
    const result = await whatsappService.sendText({ recipient: event.recipient, message: event.message });
    await markSent(event, result);
    return { sent: true, eventKey: event.eventKey };
  } catch (err) {
    await markFailure(event, err);
    console.error("WhatsApp delivery failed", event.eventKey, err.code || "OPENWA_DELIVERY_FAILED", safeErrorMessage(err));
    return { failed: true, eventKey: event.eventKey, retryable: err.retryable !== false };
  }
}

async function dispatchBatch(limit = config.whatsappDispatchBatchSize) {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await dispatchOne();
    results.push(result);
    if (result.empty || result.skipped) break;
  }
  return results;
}

module.exports = { claimNextEvent, dispatchOne, dispatchBatch, markFailure, markSent, retryDelay };
