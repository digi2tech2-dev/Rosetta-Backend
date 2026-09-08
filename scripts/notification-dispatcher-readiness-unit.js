const assert = require("assert");
const { createLeaseIndexReadiness } = require("../services/notificationDispatcherLease");
const { createDispatcher } = require("../services/notificationDispatcher");

function indexModel(indexes, calls) {
  return {
    async init() { calls.push("init"); },
    async createIndexes() { calls.push("createIndexes"); },
    async listIndexes() {
      calls.push("listIndexes");
      return indexes;
    },
  };
}

function runtimeConfig() {
  return {
    openwaEnabled: true,
    whatsappLockTimeoutMs: 120000,
    whatsappDispatchBatchSize: 1,
    whatsappMinSendIntervalMs: 25000,
    whatsappDispatchLeaseTimeoutMs: 600000,
  };
}

async function main() {
  const acceptedCalls = [];
  const accepted = createLeaseIndexReadiness({
    model: indexModel([{ name: "key_1", key: { key: 1 }, unique: true }], acceptedCalls),
  });
  await accepted();
  await accepted();
  assert.deepStrictEqual(acceptedCalls, ["init", "createIndexes", "listIndexes"], "readiness must initialize, create, verify, and cache the unique index");

  const rejectedCalls = [];
  const rejected = createLeaseIndexReadiness({
    model: indexModel([{ name: "key_1", key: { key: 1 }, unique: false }], rejectedCalls),
  });
  await assert.rejects(
    () => rejected(),
    (err) => err.code === "WHATSAPP_DISPATCH_LEASE_INDEX_UNAVAILABLE"
  );
  assert.deepStrictEqual(rejectedCalls, ["init", "createIndexes", "listIndexes"]);

  const buildFailure = createLeaseIndexReadiness({
    model: {
      async init() {},
      async createIndexes() { throw new Error("index build failed"); },
      async listIndexes() { throw new Error("must not list after index build failure"); },
    },
  });
  await assert.rejects(
    () => buildFailure(),
    (err) => err.code === "WHATSAPP_DISPATCH_LEASE_INDEX_UNAVAILABLE"
  );

  let acquireCalls = 0;
  let sendCalls = 0;
  const dispatcher = createDispatcher({
    runtimeConfig: runtimeConfig(),
    outboxModel: {
      findOneAndUpdate() {
        throw new Error("outbox must not be claimed when lease readiness fails");
      },
      async updateOne() {},
    },
    whatsappClient: {
      sendText: async () => { sendCalls += 1; },
    },
    leaseService: {
      acquireGlobalDispatcherLease: async () => {
        acquireCalls += 1;
        return null;
      },
    },
    ensureLeaseReady: rejected,
  });
  await assert.rejects(
    () => dispatcher.dispatchBatch(1),
    (err) => err.code === "WHATSAPP_DISPATCH_LEASE_INDEX_UNAVAILABLE"
  );
  assert.strictEqual(acquireCalls, 0, "missing/non-unique index must fail before lease acquisition");
  assert.strictEqual(sendCalls, 0, "missing/non-unique index must fail before any send");

  const order = [];
  const readyDispatcher = createDispatcher({
    runtimeConfig: runtimeConfig(),
    outboxModel: {
      findOneAndUpdate() {
        return { select: async () => null };
      },
      async updateOne() {},
    },
    whatsappClient: { sendText: async () => { throw new Error("no event should be sent"); } },
    leaseService: {
      acquireGlobalDispatcherLease: async () => {
        order.push("acquire");
        return { key: "whatsapp-dispatcher", ownerToken: "owner", lastAttemptAt: null };
      },
      renewGlobalDispatcherLease: async () => true,
      recordDispatcherAttempt: async () => true,
      releaseGlobalDispatcherLease: async () => { order.push("release"); },
    },
    ensureLeaseReady: async () => { order.push("ready"); },
  });
  await readyDispatcher.dispatchBatch(1);
  assert.deepStrictEqual(order, ["ready", "acquire", "release"], "readiness must run before acquisition");

  console.log("NOTIFICATION_DISPATCHER_READINESS_UNIT_PASS");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
