const crypto = require("crypto");
const dispatcherLeaseModel = require("../models/notificationDispatcherLease");

const DISPATCHER_LEASE_KEY = "whatsapp-dispatcher";

function isDuplicateKeyError(err) {
  return err && err.code === 11000;
}

function leaseIndexError(message) {
  return Object.assign(new Error(message), { code: "WHATSAPP_DISPATCH_LEASE_INDEX_UNAVAILABLE" });
}

function hasRequiredLeaseIndex(indexes) {
  return indexes.some((index) => {
    const fields = index && index.key ? Object.keys(index.key) : [];
    return fields.length === 1 && index.key.key === 1 && index.unique === true;
  });
}

function createLeaseIndexReadiness({ model = dispatcherLeaseModel } = {}) {
  let ready;
  return async function ensureDispatcherLeaseIndex() {
    if (!ready) {
      ready = (async () => {
        try {
          // init() waits for any automatic index work; createIndexes() is still
          // required because init() is a no-op when autoIndex is disabled.
          await model.init();
          await model.createIndexes();
          const indexes = await model.listIndexes();
          if (!hasRequiredLeaseIndex(indexes)) {
            throw leaseIndexError("WhatsApp dispatcher lease requires a unique { key: 1 } MongoDB index");
          }
        } catch (err) {
          if (err.code === "WHATSAPP_DISPATCH_LEASE_INDEX_UNAVAILABLE") throw err;
          throw Object.assign(
            leaseIndexError("WhatsApp dispatcher lease index initialization or verification failed"),
            { cause: err }
          );
        }
      })();
    }
    return ready;
  };
}

const ensureDispatcherLeaseIndex = createLeaseIndexReadiness();

function createDispatcherLeaseManager({ model = dispatcherLeaseModel, createToken = () => crypto.randomBytes(16).toString("hex") } = {}) {
  async function acquireGlobalDispatcherLease({ now = new Date(), leaseTimeoutMs }) {
    const ownerToken = createToken();
    const expiresAt = new Date(now.getTime() + leaseTimeoutMs);
    try {
      const lease = await model.findOneAndUpdate(
        {
          key: DISPATCHER_LEASE_KEY,
          $or: [
            { expiresAt: { $lte: now } },
            { expiresAt: null },
            { expiresAt: { $exists: false } },
          ],
        },
        {
          $set: { ownerToken, acquiredAt: now, expiresAt },
          $setOnInsert: { key: DISPATCHER_LEASE_KEY },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
      return {
        key: DISPATCHER_LEASE_KEY,
        ownerToken,
        acquiredAt: now,
        expiresAt,
        lastAttemptAt: lease.lastAttemptAt || null,
      };
    } catch (err) {
      // A concurrent upsert of the singleton key means another dispatcher won.
      if (isDuplicateKeyError(err)) return null;
      throw err;
    }
  }

  async function renewGlobalDispatcherLease(lease, { now = new Date(), leaseTimeoutMs }) {
    const expiresAt = new Date(now.getTime() + leaseTimeoutMs);
    const result = await model.updateOne(
      { key: lease.key, ownerToken: lease.ownerToken, expiresAt: { $gt: now } },
      { $set: { expiresAt } }
    );
    const matched = result.matchedCount === undefined ? result.n : result.matchedCount;
    if (matched !== 1) return false;
    lease.expiresAt = expiresAt;
    return true;
  }

  async function recordDispatcherAttempt(lease, { now = new Date(), leaseTimeoutMs }) {
    const expiresAt = new Date(now.getTime() + leaseTimeoutMs);
    const result = await model.updateOne(
      { key: lease.key, ownerToken: lease.ownerToken, expiresAt: { $gt: now } },
      { $set: { lastAttemptAt: now, expiresAt } }
    );
    const matched = result.matchedCount === undefined ? result.n : result.matchedCount;
    if (matched !== 1) return false;
    lease.lastAttemptAt = now;
    lease.expiresAt = expiresAt;
    return true;
  }

  async function releaseGlobalDispatcherLease(lease, { now = new Date() } = {}) {
    return model.updateOne(
      { key: lease.key, ownerToken: lease.ownerToken },
      { $set: { expiresAt: now }, $unset: { ownerToken: "", acquiredAt: "" } }
    );
  }

  return {
    acquireGlobalDispatcherLease,
    renewGlobalDispatcherLease,
    recordDispatcherAttempt,
    releaseGlobalDispatcherLease,
  };
}

module.exports = {
  DISPATCHER_LEASE_KEY,
  createLeaseIndexReadiness,
  createDispatcherLeaseManager,
  ensureDispatcherLeaseIndex,
  hasRequiredLeaseIndex,
  ...createDispatcherLeaseManager(),
};
