const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, connectDatabase } = require("../app");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const orderModel = require("../models/orders");
const couponModel = require("../models/coupons");
const couponRedemptionModel = require("../models/couponRedemptions");
const paymentAttemptModel = require("../models/paymentAttempts");
const cartModel = require("../models/carts");
const commerceSettingsModel = require("../models/commerceSettings");
const shippingRuleModel = require("../models/shippingRules");
const paymentService = require("../services/payments/paymentService");

const REQUIRED_DB = process.env.GUEST_CHECKOUT_SMOKE_DATABASE_NAME || "client_store_phase2m_disposable";
const PORT = Number(process.env.PORT || 8090);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2m-guest-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tokenFor(user, expiresIn = config.jwtExpiresIn) {
  return jwt.sign(
    { _id: user._id, role: user.userRole, tokenVersion: user.tokenVersion || 0 },
    config.jwtSecret,
    { expiresIn }
  );
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function cleanup() {
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const productIds = products.map((product) => product._id);
  const coupons = await couponModel.find({ code: new RegExp(`^${TEST_PREFIX}`, "i") }).select("_id");
  const couponIds = coupons.map((coupon) => coupon._id);
  await paymentAttemptModel.deleteMany({ $or: [{ customer: { $in: userIds } }, { idempotencyScope: new RegExp(`^guest:`) }] });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await couponRedemptionModel.deleteMany({ $or: [{ coupon: { $in: couponIds } }, { customer: { $in: userIds } }] });
  await orderModel.deleteMany({
    $or: [
      { user: { $in: userIds } },
      { idempotencyKey: new RegExp(`^${TEST_PREFIX}`) },
      { idempotencyScope: new RegExp(`^guest:`) },
      { "guestCustomer.email": new RegExp(`^${TEST_PREFIX}`) },
    ],
  });
  await couponModel.deleteMany({ _id: { $in: couponIds } });
  await shippingRuleModel.deleteMany({ name: new RegExp(`^${TEST_PREFIX}`) });
  await commerceSettingsModel.deleteMany({ singletonKey: "commerce" });
  await productModel.deleteMany({ _id: { $in: productIds } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
}

async function seed() {
  const category = await categoryModel.create({
    cName: `${TEST_PREFIX}category`,
    cDescription: "Disposable guest checkout category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const [product, optionProduct, disabledProduct] = await productModel.create([
    {
      pName: `${TEST_PREFIX}product`,
      pDescription: "Server priced guest product",
      pPrice: 100,
      pOffer: "80",
      pQuantity: 12,
      pSold: 0,
      pCategory: category._id,
      pImages: ["fixture-a.png"],
      pStatus: "Active",
    },
    {
      pName: `${TEST_PREFIX}option-product`,
      pDescription: "Guest options product",
      pPrice: 55,
      pOffer: "0",
      pQuantity: 1,
      pSold: 0,
      pCategory: category._id,
      pImages: ["fixture-b.png"],
      pStatus: "Active",
      pColors: ["Black"],
      pSizes: ["M"],
      inventoryMode: "shared_options",
    },
    {
      pName: `${TEST_PREFIX}disabled-product`,
      pDescription: "Disabled product",
      pPrice: 20,
      pOffer: "0",
      pQuantity: 5,
      pSold: 0,
      pCategory: category._id,
      pImages: ["fixture-c.png"],
      pStatus: "Disabled",
    },
  ]);
  const [admin, blocked, registered] = await userModel.create([
    {
      name: "Phase2M Admin",
      email: `${TEST_PREFIX}admin@example.com`,
      password: bcrypt.hashSync("AdminPassword123!", 10),
      userRole: 1,
      status: "active",
    },
    {
      name: "Phase2M Blocked",
      email: `${TEST_PREFIX}blocked@example.com`,
      password: bcrypt.hashSync("BlockedPassword123!", 10),
      userRole: 0,
      status: "blocked",
      phone: "01011112222",
      phoneNumber: 1011112222,
    },
    {
      name: "Phase2M Registered",
      email: `${TEST_PREFIX}registered@example.com`,
      password: bcrypt.hashSync("RegisteredPassword123!", 10),
      userRole: 0,
      status: "active",
    },
  ]);
  await commerceSettingsModel.create({
    singletonKey: "commerce",
    currency: "EGP",
    defaultShippingFee: 30,
    defaultFreeShippingThreshold: 500,
    automaticFirstOrderDiscountEnabled: true,
    automaticFirstOrderDiscountType: "percentage",
    automaticFirstOrderDiscountValue: 50,
  });
  await shippingRuleModel.create({
    name: `${TEST_PREFIX}nasr-city`,
    governorate: "Cairo",
    city: "Nasr City",
    fee: 12,
    active: true,
    priority: 10,
    createdBy: admin._id,
  });
  await couponModel.create([
    {
      code: `${TEST_PREFIX}SAVE`,
      type: "fixed",
      value: 10,
      active: true,
      createdBy: admin._id,
      updatedBy: admin._id,
    },
    {
      code: `${TEST_PREFIX}FIRST`,
      type: "fixed",
      value: 10,
      active: true,
      firstOrderOnly: true,
      createdBy: admin._id,
      updatedBy: admin._id,
    },
  ]);
  return {
    admin,
    blocked,
    registered,
    product,
    optionProduct,
    disabledProduct,
    adminToken: tokenFor(admin),
    registeredToken: tokenFor(registered),
    expiredToken: tokenFor(admin, "-1s"),
  };
}

const address = {
  fullName: "Guest Customer",
  phone: "+201000000000",
  governorate: "Cairo",
  city: "Nasr City",
  street: "Test Street",
};

const guestCustomer = {
  fullName: "Guest Customer",
  email: `${TEST_PREFIX}customer@example.com`,
  phone: "+201000000000",
};

function cart(product, quantity = 1, extra = {}) {
  return [{
    productId: String(product._id),
    quantity,
    selectedColor: extra.selectedColor || null,
    selectedSize: extra.selectedSize || null,
    price: 1,
    total: 1,
  }];
}

function webhookFor(attempt, overrides = {}) {
  const obj = {
    amount_cents: attempt.amountMinor,
    created_at: "2026-08-04T10:00:00.000000",
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

async function createGuestPaymob(seeded, method, key, email, couponCode = "") {
  const res = await request("/api/payments/paymob/intention", {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: {
      paymentMethod: method,
      guestCustomer: { ...guestCustomer, email },
      shippingAddress: address,
      cartItems: cart(seeded.product),
      couponCode,
    },
  });
  assert(res.status === 201 && res.body.success, `${method} guest Paymob failed`);
  const attempt = await paymentAttemptModel.findById(res.body.payment.paymentAttemptId);
  const order = await orderModel.findById(res.body.payment.orderId);
  assert(attempt && order, `${method} guest Paymob documents missing`);
  return { res, attempt, order };
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(config.nodeEnv === "test", "NODE_ENV=test is required");
  assert(config.paymobEnabled, "PAYMOB_ENABLED=true is required");
  assert(config.paymobAdapter === "fake", "PAYMOB_ADAPTER=fake is required");
  await connectDatabase();
  await cleanup();
  await Promise.all([
    orderModel.init(),
    paymentAttemptModel.init(),
    couponModel.init(),
    couponRedemptionModel.init(),
  ]);
  const server = app.listen(PORT);
  const tests = [];

  async function test(name, fn) {
    await fn();
    tests.push(name);
    console.log(`${tests.length}. ${name}: PASS`);
  }

  try {
    const seeded = await seed();

    await test("Guest quote is public and server-authoritative", async () => {
      const res = await request("/api/checkout/quote", {
        method: "POST",
        body: { shippingAddress: address, cartItems: cart(seeded.product) },
      });
      assert(res.status === 200 && res.body.success, "guest quote failed");
      assert(res.body.quote.items[0].unitPrice === 80, "submitted client price was trusted");
      assert(res.body.quote.summary.grandTotal === 92, "server total mismatch");
      assert(res.body.quote.firstOrderEligible === false, "guest first-order eligibility leaked true");
    });

    await test("Expired JWT on checkout fails instead of becoming guest", async () => {
      const res = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.expiredToken,
        body: { shippingAddress: address, cartItems: cart(seeded.product) },
      });
      assert(res.status === 401, "expired token did not fail closed");
    });

    await test("Admin JWT cannot use storefront checkout endpoints", async () => {
      const res = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.adminToken,
        body: { shippingAddress: address, cartItems: cart(seeded.product) },
      });
      assert(res.status === 403, "admin storefront quote was allowed");
    });

    let cod;
    await test("Guest COD creates a guest order and one-time tracking token", async () => {
      cod = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}cod-key` },
        body: { guestCustomer, shippingAddress: address, cartItems: cart(seeded.product), customerNote: "leave at door" },
      });
      assert(cod.status === 201 && cod.body.success, "guest COD failed");
      assert(cod.body.order.customerType === "guest", "order not marked guest");
      assert(cod.body.order.orderNumber, "order number missing");
      assert(cod.body.guestTracking?.trackingToken?.length >= 32, "tracking token missing");
      const stored = await orderModel.findById(cod.body.order.id).select("+guestTrackingTokenHash").lean();
      assert(!stored.user, "guest order linked to user");
      assert(stored.guestTrackingTokenHash && stored.guestTrackingTokenHash !== cod.body.guestTracking.trackingToken, "tracking token stored raw");
      assert(!JSON.stringify(stored).includes(cod.body.guestTracking.trackingToken), "raw tracking token leaked into order document");
    });

    await test("Guest COD replay is idempotent and does not return token again", async () => {
      const replay = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}cod-key` },
        body: { guestCustomer, shippingAddress: address, cartItems: cart(seeded.product), customerNote: "leave at door" },
      });
      assert(replay.status === 200 && replay.body.reused, "COD replay not reused");
      assert(!replay.body.guestTracking, "tracking token returned on replay");
      const product = await productModel.findById(seeded.product._id);
      assert(product.pSold === 1, "stock deducted twice");
    });

    await test("Guest COD idempotency conflict rejects changed cart", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}cod-key` },
        body: { guestCustomer, shippingAddress: address, cartItems: cart(seeded.product, 2) },
      });
      assert(res.status === 409, "changed idempotent guest COD was allowed");
    });

    await test("Guest tracking requires the exact token and returns safe fields", async () => {
      const wrong = await request("/api/order/guest/track", {
        method: "POST",
        body: { orderNumber: cod.body.order.orderNumber, trackingToken: "bad-token-bad-token-bad-token-bad-token" },
      });
      assert(wrong.status === 404, "wrong tracking token worked");
      const ok = await request("/api/order/guest/track", {
        method: "POST",
        body: cod.body.guestTracking,
      });
      const raw = JSON.stringify(ok.body);
      assert(ok.status === 200 && ok.body.order.orderNumber === cod.body.order.orderNumber, "tracking failed");
      assert(!raw.includes("guestTrackingTokenHash") && !raw.includes("normalizedEmail"), "tracking response exposed private fields");
    });

    await test("Blocked account details cannot bypass checkout as guest", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}blocked-key` },
        body: {
          guestCustomer: { fullName: "Blocked", email: seeded.blocked.email, phone: "01011112222" },
          shippingAddress: { ...address, phone: "01011112222" },
          cartItems: cart(seeded.product),
        },
      });
      assert(res.status === 403 && res.body.code === "CHECKOUT_UNAVAILABLE", "blocked guest bypass worked");
    });

    await test("Guest coupons reject first-order account-only coupon", async () => {
      const res = await request("/api/checkout/quote", {
        method: "POST",
        body: { shippingAddress: address, cartItems: cart(seeded.product), couponCode: `${TEST_PREFIX}FIRST` },
      });
      assert(res.status === 409 && res.body.code === "COUPON_ACCOUNT_REQUIRED", "first-order guest coupon was allowed");
    });

    await test("General guest coupon applies and records anonymous redemption", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}coupon-key` },
        body: {
          guestCustomer: { ...guestCustomer, email: `${TEST_PREFIX}coupon@example.com` },
          shippingAddress: address,
          cartItems: cart(seeded.product),
          couponCode: `${TEST_PREFIX}SAVE`,
        },
      });
      assert(res.status === 201, "coupon guest order failed");
      const redemption = await couponRedemptionModel.findOne({ order: res.body.order.id }).lean();
      assert(redemption && !redemption.customer, "guest coupon redemption linked to customer");
      assert(res.body.order.discountTotal === 10, "guest coupon discount mismatch");
    });

    await test("Unavailable and shared-stock guest cart items are rejected", async () => {
      const disabled = await request("/api/checkout/quote", {
        method: "POST",
        body: { shippingAddress: address, cartItems: cart(seeded.disabledProduct) },
      });
      const stock = await request("/api/checkout/quote", {
        method: "POST",
        body: {
          shippingAddress: address,
          cartItems: cart(seeded.optionProduct, 2, { selectedColor: "Black", selectedSize: "M" }),
        },
      });
      assert(disabled.status === 409 && stock.status === 409, "bad guest cart was allowed");
    });

    let paymob;
    await test("Guest Paymob intention creates pending order and guest attempt", async () => {
      paymob = await request("/api/payments/paymob/intention", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}paymob-key` },
        body: {
          paymentMethod: "card",
          guestCustomer: { ...guestCustomer, email: `${TEST_PREFIX}paymob@example.com` },
          shippingAddress: address,
          cartItems: cart(seeded.product),
        },
      });
      assert(paymob.status === 201 && paymob.body.payment.checkoutUrl.startsWith("https://"), "guest Paymob failed");
      assert(paymob.body.payment.guestTracking?.trackingToken, "guest payment tracking missing");
      const attempt = await paymentAttemptModel.findById(paymob.body.payment.paymentAttemptId).lean();
      assert(attempt.customerType === "guest" && !attempt.customer, "payment attempt not guest");
      const order = await orderModel.findById(paymob.body.payment.orderId).select("+guestTrackingTokenHash").lean();
      assert(order.paymentStatus === "pending" && order.customerType === "guest", "guest payment order not pending");
      assert(!JSON.stringify(order).includes(paymob.body.payment.guestTracking.trackingToken), "raw payment tracking token stored");
    });

    await test("Guest Paymob status requires tracking token", async () => {
      const wrong = await request("/api/payments/guest/status", {
        method: "POST",
        body: { orderNumber: paymob.body.payment.orderNumber, trackingToken: "bad-token-bad-token-bad-token-bad-token" },
      });
      const ok = await request("/api/payments/guest/status", {
        method: "POST",
        body: paymob.body.payment.guestTracking,
      });
      assert(wrong.status === 404, "wrong guest payment token worked");
      assert(ok.status === 200 && ok.body.payment.paymentStatus === "pending", "guest payment status failed");
    });

    await test("Guest Paymob replay is idempotent and does not return token again", async () => {
      const replay = await request("/api/payments/paymob/intention", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}paymob-key` },
        body: {
          paymentMethod: "card",
          guestCustomer: { ...guestCustomer, email: `${TEST_PREFIX}paymob@example.com` },
          shippingAddress: address,
          cartItems: cart(seeded.product),
        },
      });
      assert(replay.status === 200 && replay.body.reused, "Paymob replay not reused");
      assert(!replay.body.payment.guestTracking, "guest payment token returned on replay");
    });

    await test("Guest Paymob wallet intention creates a wallet attempt", async () => {
      const wallet = await createGuestPaymob(
        seeded,
        "wallet",
        `${TEST_PREFIX}wallet-key`,
        `${TEST_PREFIX}wallet@example.com`
      );
      assert(wallet.attempt.customerType === "guest" && !wallet.attempt.customer, "wallet attempt not guest");
      assert(wallet.attempt.method === "wallet", "wallet attempt method mismatch");
      assert(wallet.order.paymentMethod === "paymob_wallet", "wallet order method mismatch");
      assert(wallet.res.body.payment.guestTracking?.trackingToken, "wallet tracking token missing");
    });

    await test("Guest Paymob success webhook and replay are idempotent", async () => {
      const attemptBefore = await paymentAttemptModel.findById(paymob.body.payment.paymentAttemptId);
      const body = webhookFor(attemptBefore);
      const first = await request("/api/payments/paymob/webhook", { method: "POST", body });
      const second = await request("/api/payments/paymob/webhook", { method: "POST", body });
      const attempt = await paymentAttemptModel.findById(paymob.body.payment.paymentAttemptId).lean();
      const order = await orderModel.findById(paymob.body.payment.orderId).lean();
      assert(first.status === 200 && second.status === 200, "success webhook failed");
      assert(attempt.status === "paid" && attempt.webhookEvents.length === 1, "success webhook replay not idempotent");
      assert(order.paymentStatus === "paid" && order.orderStatus === "confirmed", "success webhook did not confirm order");
    });

    await test("Guest Paymob failure webhook releases stock and coupon once", async () => {
      const productBefore = await productModel.findById(seeded.product._id).lean();
      const failing = await createGuestPaymob(
        seeded,
        "card",
        `${TEST_PREFIX}fail-key`,
        `${TEST_PREFIX}fail@example.com`,
        `${TEST_PREFIX}SAVE`
      );
      const body = webhookFor(failing.attempt, {
        success: false,
        source_data: { pan: "xxxx", sub_type: "Declined", type: "card" },
        transactionId: `fail_${String(failing.attempt._id).slice(-8)}`,
      });
      const first = await request("/api/payments/paymob/webhook", { method: "POST", body });
      const second = await request("/api/payments/paymob/webhook", { method: "POST", body });
      const attempt = await paymentAttemptModel.findById(failing.attempt._id).lean();
      const order = await orderModel.findById(failing.order._id).lean();
      const productAfter = await productModel.findById(seeded.product._id).lean();
      const redemption = await couponRedemptionModel.findOne({ order: failing.order._id }).lean();
      assert(first.status === 200 && second.status === 200, "failure webhook failed");
      assert(attempt.status === "failed" && attempt.reservationReleased === true, "failure attempt was not released");
      assert(order.paymentStatus === "failed" && order.inventoryRestored === true, "failure order was not restored");
      assert(productAfter.pQuantity === productBefore.pQuantity, "failure stock release was not exact");
      assert(redemption && redemption.status === "released", "failure coupon redemption was not released");
    });

    await test("Guest Paymob expiry releases reservation exactly once", async () => {
      const productBefore = await productModel.findById(seeded.product._id).lean();
      const expiring = await createGuestPaymob(
        seeded,
        "wallet",
        `${TEST_PREFIX}expire-key`,
        `${TEST_PREFIX}expire@example.com`
      );
      await paymentAttemptModel.updateOne({ _id: expiring.attempt._id }, { expiresAt: new Date(Date.now() - 60 * 1000) });
      const first = await paymentService.expirePendingAttempts({ dryRun: false, limit: 10 });
      const second = await paymentService.expirePendingAttempts({ dryRun: false, limit: 10 });
      const attempt = await paymentAttemptModel.findById(expiring.attempt._id).lean();
      const order = await orderModel.findById(expiring.order._id).lean();
      const productAfter = await productModel.findById(seeded.product._id).lean();
      assert(first.expired >= 1 && second.expired === 0, "expiry sweep was not idempotent");
      assert(attempt.status === "expired" && attempt.reservationReleased === true, "expired attempt was not released");
      assert(order.paymentStatus === "expired" && order.inventoryRestored === true, "expired order was not restored");
      assert(productAfter.pQuantity === productBefore.pQuantity, "expiry stock release was not exact");
    });

    await test("Registered checkout still uses account cart without guest tracking", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.registered._id },
        { user: seeded.registered._id, items: [{ product: seeded.product._id, quantity: 1 }] },
        { upsert: true, new: true, runValidators: true }
      );
      const quote = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.registeredToken,
        body: { shippingAddress: address },
      });
      const order = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.registeredToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}registered-cod-key` },
        body: { shippingAddress: address },
      });
      assert(quote.status === 200 && quote.body.success, "registered checkout quote regressed");
      assert(order.status === 201 && order.body.order.customerType === "registered", "registered COD regressed");
      assert(!order.body.guestTracking, "registered checkout returned guest tracking");
    });
  } finally {
    await cleanup().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
  }

  console.log(`Guest checkout smoke completed: ${tests.length} checks passed.`);
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
