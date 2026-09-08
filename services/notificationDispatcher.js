const crypto = require("crypto");
const { config } = require("../config/appConfig");
const notificationOutboxModel = require("../models/notificationOutbox");
const whatsappService = require("./whatsappService");
const dispatcherLeaseService = require("./notificationDispatcherLease");

const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];
const GLOBAL_PROVIDER_FAILURE_STATUSES = new Set([401, 403, 404, 501]);

function safeErrorMessage(err) {
  return String(err && err.message || "WhatsApp delivery failed").slice(0, 500);
}

function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function isGlobalProviderFailure(err) {
  return GLOBAL_PROVIDER_FAILURE_STATUSES.has(Number(err && err.status));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDispatcher({
  runtimeConfig = config,
  outboxModel = notificationOutboxModel,
  whatsappClient = whatsappService,
  leaseService = dispatcherLeaseService,
  ensureLeaseReady = dispatcherLeaseService.ensureDispatcherLeaseIndex,
} = {}) {
  async function claimNextEvent(now = new Date()) {
    const lockToken = crypto.randomBytes(16).toString("hex");
    const staleBefore = new Date(now.getTime() - runtimeConfig.whatsappLockTimeoutMs);
    return outboxModel.findOneAndUpdate(
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
    return outboxModel.updateOne(
      { _id: event._id, status: "processing", lockToken: event.lockToken },
      { $set: { status: "sent", sentAt: now, lockedAt: null, lockToken: null, providerMessageId: result.providerMessageId || null, lastErrorCode: null, lastErrorMessage: null } }
    );
  }

  async function markFailure(event, err, now = new Date()) {
    const terminal = err.retryable === false || event.attempts >= event.maxAttempts;
    const update = terminal
      ? { status: "dead", failedAt: now, lockedAt: null, lockToken: null }
      : { status: "pending", nextAttemptAt: new Date(now.getTime() + retryDelay(event.attempts)), lockedAt: null, lockToken: null };
    return outboxModel.updateOne(
      { _id: event._id, status: "processing", lockToken: event.lockToken },
      { $set: { ...update, lastErrorCode: err.code || "OPENWA_DELIVERY_FAILED", lastErrorMessage: safeErrorMessage(err) } }
    );
  }

  async function dispatchOne(attemptNow = new Date()) {
    if (!runtimeConfig.openwaEnabled) return { skipped: "disabled" };
    const event = await claimNextEvent(attemptNow);
    if (!event) return { empty: true };
    try {
      const result = await whatsappClient.sendText({ recipient: event.recipient, message: event.message });
      await markSent(event, result, attemptNow);
      return { sent: true, attempted: true, eventKey: event.eventKey };
    } catch (err) {
      await markFailure(event, err, attemptNow);
      console.error("WhatsApp delivery failed", event.eventKey, err.code || "OPENWA_DELIVERY_FAILED", safeErrorMessage(err));
      return {
        failed: true,
        attempted: true,
        eventKey: event.eventKey,
        retryable: err.retryable !== false,
        globalProviderFailure: isGlobalProviderFailure(err),
      };
    }
  }

  async function dispatchBatch(limit = runtimeConfig.whatsappDispatchBatchSize, { now = () => new Date(), sleep = wait } = {}) {
    if (!runtimeConfig.openwaEnabled) return [{ skipped: "disabled" }];

    // Fail closed: the global singleton index must be physically present
    // before any worker can acquire a lease or claim an outbox event.
    await ensureLeaseReady();

    const lease = await leaseService.acquireGlobalDispatcherLease({
      now: now(),
      leaseTimeoutMs: runtimeConfig.whatsappDispatchLeaseTimeoutMs,
    });
    if (!lease) return [{ skipped: "lease_held" }];

    const results = [];
    try {
      for (let index = 0; index < limit; index += 1) {
        if (lease.lastAttemptAt) {
          const elapsed = now().getTime() - new Date(lease.lastAttemptAt).getTime();
          const remaining = runtimeConfig.whatsappMinSendIntervalMs - elapsed;
          if (remaining > 0) await sleep(remaining);
        }

        const stillOwnLease = await leaseService.renewGlobalDispatcherLease(lease, {
          now: now(),
          leaseTimeoutMs: runtimeConfig.whatsappDispatchLeaseTimeoutMs,
        });
        if (!stillOwnLease) {
          results.push({ skipped: "lease_lost" });
          break;
        }

        const result = await dispatchOne(now());
        results.push(result);
        if (result.attempted) {
          const recorded = await leaseService.recordDispatcherAttempt(lease, {
            now: now(),
            leaseTimeoutMs: runtimeConfig.whatsappDispatchLeaseTimeoutMs,
          });
          if (!recorded) {
            results.push({ skipped: "lease_lost" });
            break;
          }
        }
        if (result.empty || result.skipped) break;
        // Retryable and global permanent provider failures are batch-level circuit breaks.
        if (result.failed && (result.retryable || result.globalProviderFailure)) break;
      }
      return results;
    } finally {
      await leaseService.releaseGlobalDispatcherLease(lease, { now: now() });
    }
  }

  return { claimNextEvent, dispatchOne, dispatchBatch, markFailure, markSent };
}

const dispatcher = createDispatcher();

module.exports = { ...dispatcher, createDispatcher, isGlobalProviderFailure, retryDelay };
