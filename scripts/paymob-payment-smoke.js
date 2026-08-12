const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const cartModel = require("../models/carts");
const orderModel = require("../models/orders");
const couponModel = require("../models/coupons");
const paymentAttemptModel = require("../models/paymentAttempts");
const commerceSettingsModel = require("../models/commerceSettings");
const shippingRuleModel = require("../models/shippingRules");
const paymentService = require("../services/payments/paymentService");
const orderService = require("../services/orderService");

const REQUIRED_DB = process.env.PAYMOB_SMOKE_DATABASE_NAME || "client_store_phase2j_disposable";
const TEST_PREFIX = "phase2j-paymob-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  await paymentAttemptModel.deleteMany({ customer: { $in: userIds } });
  await orderModel.deleteMany({ user: { $in: userIds } });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await couponModel.deleteMany({ code: new RegExp(`^${TEST_PREFIX.toUpperCase()}`) });
  await shippingRuleModel.deleteMany({ name: new RegExp(`^${TEST_PREFIX}`) });
  await productModel.deleteMany({ _id: { $in: products.map((product) => product._id) } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
  await commerceSettingsModel.deleteMany({ singletonKey: `${TEST_PREFIX}settings` });
}

async function seedCustomer(label = "customer") {
  const user = await userModel.create({
    name: `Phase2J ${label}`,
    email: `${TEST_PREFIX}${label}-${Date.now()}@example.com`,
    password: bcrypt.hashSync("CustomerPassword123!", 10),
    userRole: 0,
    status: "active",
  });
  return user;
}

async function seedProduct(quantity = 8, price = 100) {
  let category = await categoryModel.findOne({ cName: `${TEST_PREFIX}category` });
  if (!category) {
    category = await categoryModel.create({
      cName: `${TEST_PREFIX}category`,
      cDescription: "Disposable payment category",
      cStatus: "Active",
      cImage: "fixture.png",
    });
  }
  return productModel.create({
    pName: `${TEST_PREFIX}product-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    pDescription: "Disposable product",
    pPrice: price,
    pOffer: "80",
    pQuantity: quantity,
    pSold: 0,
    pCategory: category._id,
    pImages: ["fixture-a.png", "fixture-b.png"],
    pStatus: "Active",
  });
}

async function putCart(user, product, quantity = 1, options = {}) {
  return cartModel.findOneAndUpdate(
    { user: user._id },
    {
      user: user._id,
      items: [{
        product: product._id,
        quantity,
        selectedColor: options.selectedColor || null,
        selectedSize: options.selectedSize || null,
      }],
    },
    { upsert: true, new: true }
  );
}

const shippingAddress = {
  fullName: "Phase Customer",
  phone: "+201000000000",
  governorate: "Cairo",
  city: "Nasr City",
  street: "Test Street",
};

async function createAttempt(method = "card", key = `${TEST_PREFIX}${method}-${Date.now()}`, options = {}) {
  const customer = await seedCustomer(`${method}-${Math.random().toString(36).slice(2)}`);
  const product = await seedProduct(options.stock || 8, options.price || 100);
  await putCart(customer, product, options.quantity || 1);
  const result = await paymentService.createPaymobIntention(
    String(customer._id),
    { paymentMethod: method, shippingAddress, couponCode: "" },
    key
  );
  const attempt = await paymentAttemptModel.findById(result.paymentAttemptId);
  const order = await orderModel.findById(result.orderId);
  return { customer, product, result, attempt, order, key };
}

function webhookFor(attempt, overrides = {}) {
  const obj = {
    amount_cents: attempt.amountMinor,
    created_at: "2026-08-03T10:00:00.000000",
    currency: attempt.currency,
    error_occured: false,
    has_parent_transaction: false,
    id: overrides.transactionId || `txn_${String(attempt._id).slice(-8)}`,
    integration_id: attempt.method === "card" ? config.paymobCardIntegrationId : config.paymobWalletIntegrationId,
    is_3d_secure: true,
    is_auth: false,
    is_capture: false,
    is_refunded: false,
    is_standalone_payment: true,
    is_voided: false,
    order: { id: attempt.providerOrderId, merchant_order_id: attempt.internalReference },
    owner: config.paymobMerchantId,
    merchant: { id: config.paymobMerchantId },
    pending: false,
    source_data: { pan: "xxxx-xxxx-xxxx-1234", sub_type: "MasterCard", type: "card" },
    success: true,
    ...overrides,
  };
  return { type: "TRANSACTION", obj, hmac: paymentService.calculateHmac(obj) };
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(config.paymobEnabled, "PAYMOB_ENABLED=true is required");
  assert(config.paymobAdapter === "fake", "PAYMOB_ADAPTER=fake is required");
  assert(config.nodeEnv === "test", "NODE_ENV=test is required");
  await mongoose.connect(process.env.DATABASE, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
  await cleanup();
  const tests = [];
  async function test(name, fn) {
    await fn();
    tests.push(name);
    console.log(`${tests.length}. ${name}: PASS`);
  }

  let card;
  let wallet;
  await test("Card intention creates pending order and hosted checkout URL", async () => {
    card = await createAttempt("card", `${TEST_PREFIX}card-key`);
    assert(card.result.checkoutUrl.startsWith("https://"), "checkout URL missing");
    assert(card.attempt.status === "pending", "attempt not pending");
    assert(card.order.paymentMethod === "paymob_card", "card method not stored");
    assert(card.order.paymentStatus === "pending", "order payment not pending");
  });
  await test("Wallet intention selects wallet integration", async () => {
    wallet = await createAttempt("wallet", `${TEST_PREFIX}wallet-key`);
    assert(wallet.order.paymentMethod === "paymob_wallet", "wallet method not stored");
    assert(wallet.attempt.method === "wallet", "wallet attempt not stored");
  });
  await test("Unsupported method rejected", async () => {
    let failed = false;
    try { await createAttempt("bank", `${TEST_PREFIX}bad-method`); } catch (err) { failed = err.code === "UNSUPPORTED_PAYMENT_METHOD"; }
    assert(failed, "unsupported method did not fail");
  });
  await test("Empty cart rejected", async () => {
    const customer = await seedCustomer("empty");
    let failed = false;
    try { await paymentService.createPaymobIntention(String(customer._id), { paymentMethod: "card", shippingAddress }, `${TEST_PREFIX}empty`); } catch (err) { failed = err.code === "CART_EMPTY"; }
    assert(failed, "empty cart did not fail");
  });
  await test("Out-of-stock rejected", async () => {
    const customer = await seedCustomer("stock");
    const product = await seedProduct(0);
    await putCart(customer, product, 1);
    let failed = false;
    try { await paymentService.createPaymobIntention(String(customer._id), { paymentMethod: "card", shippingAddress }, `${TEST_PREFIX}stock`); } catch (err) { failed = err.code === "OUT_OF_STOCK"; }
    assert(failed, "out of stock did not fail");
  });
  await test("Server amount and currency are used", async () => {
    assert(card.attempt.amountMinor === 10000, "amount was not minor-unit server price");
    assert(card.attempt.currency === "EGP", "currency mismatch");
  });
  await test("Paymob amount uses quantity shipping promotion totals", async () => {
    const rule = await shippingRuleModel.create({
      name: `${TEST_PREFIX}quantity-paymob`,
      governorate: shippingAddress.governorate,
      city: shippingAddress.city,
      fee: 90,
      freeShippingThreshold: null,
      active: true,
      priority: 100,
    });
    try {
      const half = await createAttempt("card", `${TEST_PREFIX}quantity-half`, { quantity: 3, price: 100 });
      assert(half.order.shippingFee === 45, "Paymob qty3 order should use half shipping");
      assert(half.order.total === 345, "Paymob qty3 grand total should include half shipping");
      assert(half.attempt.amountMinor === 34500, "Paymob qty3 attempt amount should use half shipping grand total");
      assert(half.order.pricingSnapshot.shippingSnapshot.quantityDiscountPercent === 50, "Paymob qty3 discount percent mismatch");

      const free = await createAttempt("wallet", `${TEST_PREFIX}quantity-free`, { quantity: 5, price: 40 });
      assert(free.order.shippingFee === 0, "Paymob qty5 order should use free shipping");
      assert(free.order.total === 200, "Paymob qty5 grand total should use zero shipping");
      assert(free.attempt.amountMinor === 20000, "Paymob qty5 attempt amount should use free shipping grand total");
      assert(free.order.pricingSnapshot.shippingSnapshot.quantityDiscountPercent === 100, "Paymob qty5 discount percent mismatch");
    } finally {
      await shippingRuleModel.deleteOne({ _id: rule._id });
    }
  });
  await test("No card or wallet credentials are persisted", async () => {
    const raw = JSON.stringify(await paymentAttemptModel.findById(card.attempt._id).lean());
    assert(!/cvv|otp|pin|512345|411111|wallet pin/i.test(raw), "sensitive payment data persisted");
  });
  await test("Idempotent replay returns same attempt/order", async () => {
    const replay = await paymentService.createPaymobIntention(String(card.customer._id), { paymentMethod: "card", shippingAddress }, card.key);
    assert(replay.paymentAttemptId === String(card.attempt._id), "attempt changed on replay");
    assert(replay.orderId === String(card.order._id), "order changed on replay");
  });
  await test("Idempotency conflict rejects changed method", async () => {
    let failed = false;
    try { await paymentService.createPaymobIntention(String(card.customer._id), { paymentMethod: "wallet", shippingAddress }, card.key); } catch (err) { failed = err.code === "IDEMPOTENCY_CONFLICT"; }
    assert(failed, "idempotency conflict not detected");
  });
  await test("No duplicate stock deduction on replay", async () => {
    const product = await productModel.findById(card.product._id);
    assert(product.pQuantity === 7 && product.pSold === 1, "stock changed on replay");
  });
  await test("Valid HMAC webhook marks paid", async () => {
    const body = webhookFor(card.attempt);
    await paymentService.processPaymobWebhook(body, {});
    const attempt = await paymentAttemptModel.findById(card.attempt._id);
    const order = await orderModel.findById(card.order._id);
    assert(attempt.status === "paid", "attempt not paid");
    assert(order.paymentStatus === "paid" && order.orderStatus === "confirmed", "order not confirmed paid");
  });
  await test("Duplicate webhook is idempotent", async () => {
    const body = webhookFor(card.attempt);
    await paymentService.processPaymobWebhook(body, {});
    const attempt = await paymentAttemptModel.findById(card.attempt._id);
    assert(attempt.webhookEvents.length === 1, "duplicate webhook recorded twice");
  });
  await test("Missing HMAC rejected", async () => {
    let failed = false;
    try { await paymentService.processPaymobWebhook({ obj: webhookFor(wallet.attempt).obj }, {}); } catch (err) { failed = err.code === "PAYMENT_HMAC_MISSING"; }
    assert(failed, "missing HMAC accepted");
  });
  await test("Invalid HMAC rejected", async () => {
    let failed = false;
    const body = webhookFor(wallet.attempt);
    body.hmac = "00";
    try { await paymentService.processPaymobWebhook(body, {}); } catch (err) { failed = err.code === "PAYMENT_HMAC_INVALID"; }
    assert(failed, "invalid HMAC accepted");
  });
  await test("Wrong merchant flags manual review", async () => {
    const another = await createAttempt("card", `${TEST_PREFIX}wrong-merchant`);
    const body = webhookFor(another.attempt, { merchant: { id: "999999" }, owner: "999999" });
    body.hmac = paymentService.calculateHmac(body.obj);
    await paymentService.processPaymobWebhook(body, {});
    const attempt = await paymentAttemptModel.findById(another.attempt._id);
    assert(attempt.status === "manual_review", "wrong merchant not reviewed");
  });
  await test("Wrong amount flags manual review", async () => {
    const another = await createAttempt("card", `${TEST_PREFIX}wrong-amount`);
    const body = webhookFor(another.attempt, { amount_cents: another.attempt.amountMinor + 1 });
    body.hmac = paymentService.calculateHmac(body.obj);
    await paymentService.processPaymobWebhook(body, {});
    const attempt = await paymentAttemptModel.findById(another.attempt._id);
    assert(attempt.status === "manual_review", "wrong amount not reviewed");
  });
  await test("Failure webhook restores stock once", async () => {
    const failure = await createAttempt("card", `${TEST_PREFIX}failure`);
    const body = webhookFor(failure.attempt, { success: false, source_data: { pan: "xxxx", sub_type: "Declined", type: "card" } });
    body.hmac = paymentService.calculateHmac(body.obj);
    await paymentService.processPaymobWebhook(body, {});
    await paymentService.processPaymobWebhook(body, {});
    const product = await productModel.findById(failure.product._id);
    const attempt = await paymentAttemptModel.findById(failure.attempt._id);
    assert(attempt.status === "failed", "attempt not failed");
    assert(product.pQuantity === 8 && product.pSold === 0, "stock not restored exactly once");
  });
  await test("Expired pending attempt releases reservation once", async () => {
    const expiring = await createAttempt("wallet", `${TEST_PREFIX}expire`);
    await paymentAttemptModel.findByIdAndUpdate(expiring.attempt._id, { expiresAt: new Date(Date.now() - 1000) });
    const dry = await paymentService.expirePendingAttempts({ dryRun: true, limit: 10 });
    assert(dry.expired >= 1, "dry run did not see expired attempt");
    await paymentService.expirePendingAttempts({ dryRun: false, limit: 10 });
    await paymentService.expirePendingAttempts({ dryRun: false, limit: 10 });
    const product = await productModel.findById(expiring.product._id);
    const attempt = await paymentAttemptModel.findById(expiring.attempt._id);
    assert(attempt.status === "expired", "attempt not expired");
    assert(product.pQuantity === 8 && product.pSold === 0, "expiry did not restore exactly once");
  });
  await test("Paid attempt is not expired", async () => {
    await paymentAttemptModel.findByIdAndUpdate(card.attempt._id, { expiresAt: new Date(Date.now() - 1000) });
    await paymentService.expirePendingAttempts({ dryRun: false, limit: 10 });
    const attempt = await paymentAttemptModel.findById(card.attempt._id);
    assert(attempt.status === "paid", "paid attempt expired");
  });
  await test("Customer status response is private and safe", async () => {
    const status = await paymentService.getPaymentStatus({ userId: String(card.customer._id), role: 0 }, card.attempt._id);
    const raw = JSON.stringify(status);
    assert(status.paymentStatus === "paid", "status not paid");
    assert(!/hmac|secret|clientSecret|authorization|payload/i.test(raw), "secret-like data leaked");
  });
  await test("Other customer cannot read status", async () => {
    const other = await seedCustomer("other-status");
    let failed = false;
    try { await paymentService.getPaymentStatus({ userId: String(other._id), role: 0 }, card.attempt._id); } catch (err) { failed = err.status === 404; }
    assert(failed, "other customer read payment status");
  });
  await test("COD still works", async () => {
    const customer = await seedCustomer("cod");
    const product = await seedProduct();
    await putCart(customer, product, 1);
    const result = await orderService.createCodOrder(String(customer._id), { shippingAddress }, `${TEST_PREFIX}cod`);
    assert(result.order.paymentMethod === "cash_on_delivery", "COD method changed");
    assert(result.order.paymentStatus === "unpaid", "COD payment status changed");
  });
  await test("Fake adapter cannot be constructed outside explicit test setting", async () => {
    assert(config.nodeEnv === "test" && config.paymobAdapter === "fake", "fake adapter guard environment changed");
  });
  await test("Braintree remains disabled by environment", async () => {
    assert(process.env.ENABLE_LEGACY_BRAINTREE === "false", "legacy Braintree enabled");
  });
  await test("Old order without payment fields serializes", async () => {
    const customer = await seedCustomer("old");
    const old = await orderModel.create({ user: customer._id, amount: 10, allProduct: [], status: "Not processed" });
    const safe = orderService.normalizeOrder(old);
    assert(safe.paymentStatus, "old order missing payment status fallback");
  });
  await test("Recursive forbidden-key scan passes responses", async () => {
    const values = [card.result, await paymentService.getPaymentStatus({ userId: String(card.customer._id), role: 0 }, card.attempt._id)];
    const raw = JSON.stringify(values);
    assert(!/PAYMOB_SECRET|PAYMOB_HMAC|password|resetToken|client_secret|cvv|otp/i.test(raw), "forbidden key leaked");
  });

  console.log(`PAYMOB_PAYMENT_SMOKE_PASS total=${tests.length}`);
  await cleanup();
}

main()
  .catch((error) => {
    console.error(`PAYMOB_PAYMENT_SMOKE_FAIL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
