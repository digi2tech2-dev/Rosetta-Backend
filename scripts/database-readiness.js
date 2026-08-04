require("dotenv").config();

const mongoose = require("mongoose");
const { config, validateConfig } = require("../config/appConfig");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");

const models = [
  require("../models/users"),
  require("../models/products"),
  require("../models/carts"),
  require("../models/orders"),
  require("../models/coupons"),
  require("../models/couponRedemptions"),
  require("../models/shippingRules"),
  require("../models/paymentAttempts"),
  require("../models/commerceSettings"),
];

const expectedIndexes = {
  users: ["email_1"],
  products: ["pBarcode_1"],
  carts: ["user_1"],
  orders: ["user_1_idempotencyKey_1"],
  coupons: ["code_1"],
  couponredemptions: ["coupon_1_order_1", "coupon_1_customer_1_status_1"],
  shippingrules: ["governorate_1_city_1_active_1_priority_-1"],
  paymentattempts: [
    "customer_1_idempotencyKey_1",
    "internalReference_1",
    "providerTransactionId_1",
    "expiresAt_1",
    "webhookEvents.providerEventId_1",
    "order_1",
  ],
  commercesettings: ["singletonKey_1"],
};

function hasFlag(name) {
  return process.argv.includes(name);
}

async function inspectCollectionIndexes() {
  const rows = [];
  for (const model of models) {
    const collection = model.collection.collectionName;
    let indexes = [];
    try {
      indexes = await model.collection.indexes();
    } catch (err) {
      if (err.codeName !== "NamespaceNotFound") {
        throw err;
      }
    }
    const names = indexes.map((index) => index.name).sort();
    const missing = (expectedIndexes[collection] || []).filter((name) => !names.includes(name));
    rows.push({ collection, indexes: names, missing });
  }
  return rows;
}

async function countDuplicateGroups(model, key, match = {}) {
  const id = {};
  for (const field of Object.keys(key)) {
    id[field.replace(/\./g, "_")] = `$${field}`;
  }
  const rows = await model.aggregate([
    { $match: match },
    { $group: { _id: id, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ]);
  return rows.length;
}

async function inspectDuplicateIndexBlockers() {
  const byName = new Map(models.map((model) => [model.collection.collectionName, model]));
  return [
    ["users.email", await countDuplicateGroups(byName.get("users"), { email: 1 })],
    ["products.pBarcode", await countDuplicateGroups(byName.get("products"), { pBarcode: 1 }, { pBarcode: { $type: "string" } })],
    ["carts.user", await countDuplicateGroups(byName.get("carts"), { user: 1 })],
    ["orders.user_idempotencyKey", await countDuplicateGroups(byName.get("orders"), { user: 1, idempotencyKey: 1 }, { idempotencyKey: { $type: "string" } })],
    ["coupons.code", await countDuplicateGroups(byName.get("coupons"), { code: 1 })],
    ["couponredemptions.coupon_order", await countDuplicateGroups(byName.get("couponredemptions"), { coupon: 1, order: 1 })],
    ["paymentattempts.customer_idempotencyKey", await countDuplicateGroups(byName.get("paymentattempts"), { customer: 1, idempotencyKey: 1 })],
    ["paymentattempts.internalReference", await countDuplicateGroups(byName.get("paymentattempts"), { internalReference: 1 })],
    ["paymentattempts.providerTransactionId", await countDuplicateGroups(byName.get("paymentattempts"), { providerTransactionId: 1 }, { providerTransactionId: { $type: "string" } })],
    ["commercesettings.singletonKey", await countDuplicateGroups(byName.get("commercesettings"), { singletonKey: 1 })],
  ].filter((row) => row[1] > 0);
}

async function main() {
  validateConfig();
  if (config.nodeEnv === "production" && !hasFlag("--allow-production-inspection")) {
    throw new Error("--allow-production-inspection is required when NODE_ENV=production");
  }
  if (hasFlag("--apply-indexes")) {
    assertLocalMongoDatabase(config.databaseUrl);
  }

  await mongoose.connect(config.databaseUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });

  if (hasFlag("--apply-indexes")) {
    await Promise.all(models.map((model) => model.createIndexes()));
  }

  const hello = await mongoose.connection.db.admin().command({ hello: 1 }).catch(() => ({}));
  const rows = await inspectCollectionIndexes();
  const duplicateBlockers = await inspectDuplicateIndexBlockers();
  const missing = rows.flatMap((row) => row.missing.map((name) => `${row.collection}.${name}`));
  const transactionReady = Boolean(hello.setName || hello.msg === "isdbgrid");

  console.log(`database=${mongoose.connection.name}`);
  console.log(`topology=${transactionReady ? "transaction_capable" : "standalone_or_unknown"}`);
  for (const row of rows) {
    console.log(`${row.collection}: indexes=${row.indexes.length} missing=${row.missing.length ? row.missing.join(",") : "none"}`);
  }
  if (missing.length) {
    console.log(`missing_expected_indexes=${missing.join(",")}`);
  }
  if (duplicateBlockers.length) {
    console.log(`duplicate_index_blockers=${duplicateBlockers.map(([name, count]) => `${name}:${count}`).join(",")}`);
  } else {
    console.log("duplicate_index_blockers=none");
  }
  console.log("DATABASE_READINESS_PASS");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
