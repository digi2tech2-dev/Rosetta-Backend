const assert = require("assert");
const { createDispatcher } = require("../services/notificationDispatcher");
const { createDispatcherLeaseManager } = require("../services/notificationDispatcherLease");
const { classifyHttpFailure } = require("../services/whatsappService");

function createLeaseModel() {
  let document = null;
  return {
    async findOneAndUpdate(filter, update, options) {
      const now = filter.$or[0].expiresAt.$lte;
      const available = !document || !document.expiresAt || document.expiresAt <= now;
      if (!available) {
        if (options.upsert) {
          const err = new Error("duplicate lease key");
          err.code = 11000;
          throw err;
        }
        return null;
      }
      document = { ...(document || {}), key: update.$setOnInsert.key, ...update.$set };
      return { ...document };
    },
    async updateOne(filter, update) {
      const owned = document
        && document.key === filter.key
        && document.ownerToken === filter.ownerToken
        && (!filter.expiresAt || document.expiresAt > filter.expiresAt.$gt);
      if (!owned) return { matchedCount: 0 };
      if (update.$set) Object.assign(document, update.$set);
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete document[key];
      }
      return { matchedCount: 1 };
    },
  };
}

function createOutbox(events, updates) {
  return {
    findOneAndUpdate() {
      const event = events.shift();
      if (event) event.attempts += 1;
      return { select: async () => event || null };
    },
    async updateOne(filter, update) {
      updates.push({ filter, update });
      return { matchedCount: 1 };
    },
  };
}

function createRuntimeConfig() {
  return {
    openwaEnabled: true,
    openwaTimeoutMs: 1000,
    whatsappMaxAttempts: 5,
    whatsappDispatchBatchSize: 10,
    whatsappLockTimeoutMs: 2000,
    whatsappMinSendIntervalMs: 25000,
    whatsappDispatchLeaseTimeoutMs: 600000,
  };
}

function event(index) {
  return {
    _id: "event-" + index,
    eventKey: "order:" + index + ":created",
    recipient: "201012345678",
    message: "test",
    attempts: 0,
    maxAttempts: 5,
  };
}

function fakeClock() {
  let milliseconds = 0;
  const sleeps = [];
  return {
    now: () => new Date(milliseconds),
    sleep: async (duration) => {
      sleeps.push(duration);
      milliseconds += duration;
    },
    milliseconds: () => milliseconds,
    sleeps,
  };
}

function leaseServiceForTests() {
  return createDispatcherLeaseManager({
    model: createLeaseModel(),
    createToken: (() => { let index = 0; return () => "lease-" + (++index); })(),
  });
}

async function assertFailureCase({ status, retryable, shouldStop }) {
  const clock = fakeClock();
  const updates = [];
  const events = [event("failure-" + status), event("following-" + status)];
  const leaseService = leaseServiceForTests();
  let sendCalls = 0;
  const error = classifyHttpFailure(status, { message: "status " + status });
  if (retryable !== undefined) error.retryable = retryable;
  const dispatcher = createDispatcher({
    runtimeConfig: createRuntimeConfig(),
    outboxModel: createOutbox(events, updates),
    whatsappClient: {
      sendText: async () => {
        sendCalls += 1;
        if (sendCalls === 1) throw error;
        return { providerMessageId: "following-message" };
      },
    },
    leaseService,
    ensureLeaseReady: async () => {},
  });
  const results = await dispatcher.dispatchBatch(2, clock);
  const failureUpdate = updates.find((entry) => entry.update.$set.lastErrorCode);
  assert(failureUpdate, "status " + status + " must mutate the current event");
  if (retryable) {
    assert.strictEqual(failureUpdate.update.$set.status, "pending", "status " + status + " must reschedule");
    assert.strictEqual(failureUpdate.update.$set.nextAttemptAt.getTime(), 60 * 1000);
  } else {
    assert.strictEqual(failureUpdate.update.$set.status, "dead", "status " + status + " must be terminal");
  }
  if (shouldStop) {
    assert.strictEqual(results.length, 1, "status " + status + " must stop the batch");
    assert.strictEqual(sendCalls, 1, "status " + status + " must not send the following event");
    assert.strictEqual(events.length, 1, "status " + status + " must not claim the following event");
  } else {
    assert.strictEqual(results.length, 2, "status " + status + " must continue the batch");
    assert.strictEqual(sendCalls, 2, "status " + status + " must send the following event");
    assert.strictEqual(events.length, 0, "status " + status + " must claim the following event");
    assert.deepStrictEqual(clock.sleeps, [25000]);
  }
}

async function main() {
  const leaseService = leaseServiceForTests();
  const [firstLease, secondLease] = await Promise.all([
    leaseService.acquireGlobalDispatcherLease({ now: new Date(0), leaseTimeoutMs: 600000 }),
    leaseService.acquireGlobalDispatcherLease({ now: new Date(0), leaseTimeoutMs: 600000 }),
  ]);
  assert(firstLease, "first dispatcher must acquire the global lease");
  assert.strictEqual(secondLease, null, "active lease cannot be stolen");

  await leaseService.recordDispatcherAttempt(firstLease, { now: new Date(10), leaseTimeoutMs: 600000 });
  await leaseService.releaseGlobalDispatcherLease(firstLease, { now: new Date(10) });
  const reclaimedLease = await leaseService.acquireGlobalDispatcherLease({ now: new Date(10), leaseTimeoutMs: 600000 });
  assert(reclaimedLease, "expired lease must be reclaimed");
  assert.strictEqual(reclaimedLease.lastAttemptAt.getTime(), 10, "release must preserve pacing state");
  assert.strictEqual(await leaseService.renewGlobalDispatcherLease(firstLease, { now: new Date(10), leaseTimeoutMs: 600000 }), false, "old owner cannot renew a reclaimed lease");
  await leaseService.releaseGlobalDispatcherLease(firstLease, { now: new Date(10) });
  assert.strictEqual(await leaseService.renewGlobalDispatcherLease(reclaimedLease, { now: new Date(10), leaseTimeoutMs: 600000 }), true, "old owner cannot release a newer owner's lease");
  await leaseService.releaseGlobalDispatcherLease(reclaimedLease, { now: new Date(10) });

  const clock = fakeClock();
  const pacingLeaseService = leaseServiceForTests();
  const sentAt = [];
  let activeSends = 0;
  let maximumActiveSends = 0;
  const firstDispatcher = createDispatcher({
    runtimeConfig: createRuntimeConfig(),
    outboxModel: createOutbox([event(1)], []),
    whatsappClient: {
      sendText: async () => {
        activeSends += 1;
        maximumActiveSends = Math.max(maximumActiveSends, activeSends);
        sentAt.push(clock.milliseconds());
        await Promise.resolve();
        activeSends -= 1;
        return { providerMessageId: "first" };
      },
    },
    leaseService: pacingLeaseService,
    ensureLeaseReady: async () => {},
  });
  await firstDispatcher.dispatchBatch(1, clock);
  const secondDispatcher = createDispatcher({
    runtimeConfig: createRuntimeConfig(),
    outboxModel: createOutbox([event(2)], []),
    whatsappClient: {
      sendText: async () => {
        activeSends += 1;
        maximumActiveSends = Math.max(maximumActiveSends, activeSends);
        sentAt.push(clock.milliseconds());
        activeSends -= 1;
        return { providerMessageId: "second" };
      },
    },
    leaseService: pacingLeaseService,
    ensureLeaseReady: async () => {},
  });
  await secondDispatcher.dispatchBatch(1, clock);
  assert.strictEqual(maximumActiveSends, 1, "dispatcher sends must be sequential");
  assert.deepStrictEqual(sentAt, [0, 25000], "separate invocations must use persisted pacing state");
  assert.deepStrictEqual(clock.sleeps, [25000]);

  await assertFailureCase({ status: 400, retryable: false, shouldStop: false });
  await assertFailureCase({ status: 422, retryable: false, shouldStop: false });
  await assertFailureCase({ status: 401, retryable: false, shouldStop: true });
  await assertFailureCase({ status: 403, retryable: false, shouldStop: true });
  await assertFailureCase({ status: 404, retryable: false, shouldStop: true });
  await assertFailureCase({ status: 501, retryable: false, shouldStop: true });
  await assertFailureCase({ status: 409, retryable: true, shouldStop: true });
  await assertFailureCase({ status: 429, retryable: true, shouldStop: true });
  await assertFailureCase({ status: 500, retryable: true, shouldStop: true });
  await assertFailureCase({ status: 502, retryable: true, shouldStop: true });
  await assertFailureCase({ status: 503, retryable: true, shouldStop: true });

  for (const [code, message] of [
    ["OPENWA_TIMEOUT", "OpenWA timed out"],
    ["OPENWA_NETWORK_FAILURE", "OpenWA network request failed"],
  ]) {
    const clockForFailure = fakeClock();
    const updates = [];
    const events = [event(code), event("following-" + code)];
    const dispatcher = createDispatcher({
      runtimeConfig: createRuntimeConfig(),
      outboxModel: createOutbox(events, updates),
      whatsappClient: { sendText: async () => { throw Object.assign(new Error(message), { code, retryable: true }); } },
      leaseService: leaseServiceForTests(),
      ensureLeaseReady: async () => {},
    });
    const results = await dispatcher.dispatchBatch(2, clockForFailure);
    assert.strictEqual(results.length, 1, code + " must stop the batch");
    assert.strictEqual(events.length, 1, code + " must not claim the following event");
    assert.strictEqual(updates.find((entry) => entry.update.$set.status === "pending").update.$set.nextAttemptAt.getTime(), 60 * 1000);
  }

  console.log("NOTIFICATION_DISPATCHER_UNIT_PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
