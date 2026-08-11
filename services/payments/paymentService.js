const crypto = require("crypto");
const mongoose = require("mongoose");
const userModel = require("../../models/users");
const orderModel = require("../../models/orders");
const paymentAttemptModel = require("../../models/paymentAttempts");
const { config } = require("../../config/appConfig");
const {
  calculateCheckoutPricing,
  calculateGuestCheckoutPricing,
  reserveCouponUsage,
  releaseCouponUsage,
  toCents,
  fromCents,
} = require("../pricingService");
const orderService = require("../orderService");
const {
  assertGuestNotBlocked,
  generateTrackingToken,
  guestIdentityHash,
  normalizeGuestCartItems,
  normalizeGuestCustomer,
  verifyTrackingToken,
} = require("../guestCheckoutService");
const { PaymobAdapter, buildCheckoutUrl } = require("./paymobAdapter");
const { FakePaymobAdapter } = require("./fakePaymobAdapter");

const PAYMENT_METHODS = {
  card: { orderMethod: "paymob_card", integration: () => config.paymobCardIntegrationId },
  wallet: { orderMethod: "paymob_wallet", integration: () => config.paymobWalletIntegrationId },
};

const PAYMOB_HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
];

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function amountMinor(value) {
  return toCents(value || 0);
}

function terminal(status) {
  return ["paid", "failed", "expired", "cancelled", "manual_review"].includes(status);
}

function encrypt(value) {
  if (!value) return "";
  const key = crypto.createHash("sha256").update(config.jwtSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(value) {
  if (!value || typeof value !== "string" || !value.startsWith("v1:")) return "";
  const [, ivRaw, tagRaw, encryptedRaw] = value.split(":");
  const key = crypto.createHash("sha256").update(config.jwtSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function getAdapter() {
  if (config.paymobAdapter === "fake") return new FakePaymobAdapter();
  return new PaymobAdapter();
}

function assertProviderAvailable(method) {
  if (!config.paymobEnabled) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Online payment is temporarily unavailable");
  }
  const methodConfig = PAYMENT_METHODS[method];
  if (!methodConfig) throw httpError(400, "UNSUPPORTED_PAYMENT_METHOD", "Unsupported payment method");
  const integration = methodConfig.integration();
  if (!integration) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Online payment is temporarily unavailable");
  }
  if (!config.paymobHmacSecret || !config.paymobMerchantId) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Online payment is temporarily unavailable");
  }
  return String(integration);
}

function requestFingerprint({ method, shippingAddress, savedAddressId, couponCode, cartItems, pricing }) {
  return digest({
    method,
    shippingAddress,
    savedAddressId: savedAddressId || "",
    couponCode: String(couponCode || "").trim().toUpperCase(),
    cart: cartItems.map((item) => ({
      productId: String(item.productId),
      quantity: item.quantity,
      selectedColor: item.selectedColor || null,
      selectedSize: item.selectedSize || null,
      bundleOfferId: item.bundleOfferId || null,
      bundleGroupId: item.bundleGroupId || null,
      bundleRole: item.bundleRole || null,
      unitPriceCents: item.unitPriceCents,
      lineTotalCents: item.lineTotalCents,
    })),
    pricing: {
      amountMinor: amountMinor(pricing.grandTotal),
      currency: pricing.currency,
    },
  });
}

function snapshots(checkout) {
  return checkout.items.map((item) => ({
    product: item.productId,
    name: item.name,
    image: item.image,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    selectedColor: item.selectedColor || null,
    selectedSize: item.selectedSize || null,
    bundleOfferId: item.bundleOfferId || null,
    bundleGroupId: item.bundleGroupId || null,
    bundleRole: item.bundleRole || null,
    merchantName: item.merchantName || null,
  }));
}

function providerItemName(value, fallback) {
  const name = String(value || "").trim();
  return (name || fallback).slice(0, 120);
}

function sumProviderItems(items) {
  return items.reduce((total, item) => total + amountMinor(fromCents(item.amountMinor)), 0);
}

function providerItems(checkout) {
  const expectedCents = amountMinor(checkout && checkout.summary && checkout.summary.grandTotal);
  const shippingCents = amountMinor(checkout && checkout.summary && checkout.summary.shippingFee);
  const paidMerchandiseCents = Math.max(0, expectedCents - shippingCents);
  const productLines = (checkout.items || [])
    .map((item) => ({
      name: providerItemName(
        Number(item.quantity) > 1 ? `${item.name} x${item.quantity}` : item.name,
        "Rosetta order item"
      ),
      baseCents: Math.max(0, Number(item.lineTotalCents) || 0),
    }))
    .filter((item) => item.baseCents > 0);

  const rows = [];
  const baseTotalCents = productLines.reduce((total, item) => total + item.baseCents, 0);
  if (paidMerchandiseCents > 0 && baseTotalCents > 0) {
    let allocatedCents = 0;
    productLines.forEach((item, index) => {
      const isLast = index === productLines.length - 1;
      const amount = isLast
        ? paidMerchandiseCents - allocatedCents
        : Math.floor((paidMerchandiseCents * item.baseCents) / baseTotalCents);
      allocatedCents += amount;
      if (amount > 0) rows.push({ name: item.name, amountMinor: amount, quantity: 1 });
    });
  } else if (paidMerchandiseCents > 0) {
    rows.push({ name: "Rosetta merchandise", amountMinor: paidMerchandiseCents, quantity: 1 });
  }

  if (shippingCents > 0) {
    rows.push({ name: "Shipping", amountMinor: shippingCents, quantity: 1 });
  }

  const actualCents = sumProviderItems(rows);
  if (rows.length && actualCents !== expectedCents) {
    rows[rows.length - 1].amountMinor = Math.max(0, rows[rows.length - 1].amountMinor + (expectedCents - actualCents));
  }
  return rows;
}

function safeAttemptResponse(attempt, order, guestTracking) {
  const clientSecret = !terminal(attempt.status) ? decrypt(attempt.checkoutReferenceProtected) : "";
  const response = {
    paymentAttemptId: String(attempt._id),
    orderId: String(order._id || order.id),
    orderNumber: order.orderNumber || "",
    checkoutUrl: clientSecret ? buildCheckoutUrl(clientSecret) : undefined,
    expiresAt: attempt.expiresAt,
    paymentStatus: attempt.status,
    orderStatus: order.orderStatus || "pending",
    amount: fromCents(attempt.amountMinor),
    currency: attempt.currency,
  };
  if (guestTracking) {
    response.guestTracking = guestTracking;
  }
  return response;
}

async function createPaymobIntention(customerId, body, idempotencyHeader) {
  const method = body.paymentMethod === "card" || body.paymentMethod === "paymob_card"
    ? "card"
    : body.paymentMethod === "wallet" || body.paymentMethod === "paymob_wallet"
      ? "wallet"
      : "";
  const integrationId = assertProviderAvailable(method);
  const idempotencyKey = orderService.validateIdempotencyKey(idempotencyHeader || body.idempotencyKey);
  const shippingAddress = orderService.validateShippingAddress(body.shippingAddress || {});
  const couponCode = String(body.couponCode || "").trim();
  const customerNote = orderService.cleanText(body.customerNote, 500, false);

  const existing = await paymentAttemptModel.findOne({ customer: customerId, idempotencyKey });
  if (existing) {
    const order = await orderModel.findById(existing.order);
    if (!order) throw httpError(409, "IDEMPOTENCY_CONFLICT", "Idempotent payment order is missing");
    const cartItems = (order.items || []).map((item) => ({
      productId: item.product,
      quantity: item.quantity,
      selectedColor: item.selectedColor || null,
      selectedSize: item.selectedSize || null,
      bundleOfferId: item.bundleOfferId || null,
      bundleGroupId: item.bundleGroupId || null,
      bundleRole: item.bundleRole || null,
      unitPriceCents: amountMinor(item.unitPrice),
      lineTotalCents: amountMinor(item.lineTotal),
    }));
    const fingerprint = requestFingerprint({
      method,
      shippingAddress,
      savedAddressId: body.savedAddressId,
      couponCode,
      cartItems,
      pricing: { grandTotal: order.total, currency: order.currency },
    });
    if (existing.requestFingerprint !== fingerprint) {
      throw httpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different payment request");
    }
    if (terminal(existing.status)) {
      throw httpError(409, "IDEMPOTENCY_TERMINAL", "This payment attempt is terminal; start a new payment");
    }
    return { reused: true, ...safeAttemptResponse(existing, order) };
  }

  const checkout = await calculateCheckoutPricing({ customerId, shippingAddress, savedAddressId: body.savedAddressId, couponCode });
  const currency = String(checkout.summary.currency || config.storeCurrency).toUpperCase();
  if (currency !== config.paymobCurrency) {
    throw httpError(409, "PAYMENT_CURRENCY_MISMATCH", "Payment currency is not available");
  }
  const minor = amountMinor(checkout.summary.grandTotal);
  const fingerprint = requestFingerprint({ method, shippingAddress, savedAddressId: body.savedAddressId, couponCode, cartItems: checkout.items, pricing: checkout.summary });
  const customer = await userModel.findById(customerId);
  const customerSnapshot = await orderService.buildRegisteredCustomerSnapshot(customerId, checkout.shippingAddress);
  const orderId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();
  const internalReference = `rosetta_${orderId}_${attemptId}`;
  const expiresAt = new Date(Date.now() + config.paymobPaymentTtlMinutes * 60 * 1000);
  let redemption = null;
  const deducted = [];
  let order;
  let attempt;
  try {
    redemption = await reserveCouponUsage({
      coupon: checkout.coupon,
      customerId,
      orderId,
      amount: checkout.pricingSnapshot.discountTotal,
    });
    deducted.push(...(await orderService.deductStock(checkout.items)));
    order = await orderModel.create({
      _id: orderId,
      user: customerId,
      customerType: "registered",
      customerSnapshot,
      orderNumber: orderService.generateOrderNumber(),
      items: snapshots(checkout),
      allProduct: checkout.items.map((item) => ({
        id: item.productId,
        quantitiy: item.quantity,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
        bundleOfferId: item.bundleOfferId || null,
        bundleGroupId: item.bundleGroupId || null,
        bundleRole: item.bundleRole || null,
      })),
      subtotal: checkout.summary.merchandiseSubtotal,
      discountTotal: checkout.summary.discountTotal,
      discountSource: checkout.pricingSnapshot.discountSource,
      shippingFee: checkout.summary.shippingFee,
      total: checkout.summary.grandTotal,
      amount: checkout.summary.grandTotal,
      currency,
      shippingAddress: checkout.shippingAddress,
      address: [checkout.shippingAddress.street, checkout.shippingAddress.city, checkout.shippingAddress.governorate].filter(Boolean).join(", "),
      phone: Number(String(checkout.shippingAddress.phone).replace(/\D/g, "").slice(0, 15)) || 0,
      paymentMethod: PAYMENT_METHODS[method].orderMethod,
      paymentStatus: "pending",
      paymentProvider: "paymob",
      paymentAttempt: attemptId,
      paymentExpiresAt: expiresAt,
      orderStatus: "pending",
      status: "Not processed",
      customerNote,
      coupon: checkout.coupon ? checkout.coupon._id : null,
      couponCode: checkout.pricingSnapshot.couponSnapshot?.code || "",
      couponRedemption: redemption ? redemption._id : null,
      pricingSnapshot: checkout.pricingSnapshot,
      idempotencyKey: `paymob:${idempotencyKey}`,
      idempotencyPayloadHash: fingerprint,
      inventoryApplied: true,
      inventoryRestored: false,
      statusHistory: [{ status: "pending", paymentStatus: "pending", changedBy: customerId, note: "Paymob payment order reserved" }],
    });
    attempt = await paymentAttemptModel.create({
      _id: attemptId,
      customer: customerId,
      customerType: "registered",
      order: orderId,
      provider: "paymob",
      method,
      status: "creating",
      idempotencyKey,
      requestFingerprint: fingerprint,
      internalReference,
      amountMinor: minor,
      currency,
      expiresAt,
    });
    const provider = await getAdapter().createIntention({
      amountMinor: minor,
      currency,
      integrations: [Number(integrationId)],
      internalReference,
      customer,
      shippingAddress: checkout.shippingAddress,
      items: providerItems(checkout),
      notificationUrl: config.paymobWebhookUrl,
      redirectionUrl: config.paymobSuccessReturnUrl || config.paymobFailureReturnUrl,
    });
    if (!provider.providerIntentionId || !provider.clientSecret || !provider.checkoutUrl) {
      throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider response was incomplete");
    }
    attempt.providerIntentionId = provider.providerIntentionId;
    attempt.providerOrderId = provider.providerOrderId || "";
    attempt.checkoutReferenceProtected = encrypt(provider.clientSecret);
    attempt.status = "pending";
    await attempt.save();
    checkout.cart.items = [];
    await checkout.cart.save();
    return { reused: false, ...safeAttemptResponse(attempt, order) };
  } catch (err) {
    await orderService.restoreStock(deducted);
    if (redemption && checkout.coupon) {
      await releaseCouponUsage({ couponId: checkout.coupon._id, customerId, orderId });
    }
    if (attempt) {
      attempt.status = "failed";
      attempt.failureCode = err.code || "PAYMENT_PROVIDER_UNAVAILABLE";
      attempt.failureMessageSafe = "Payment could not be started";
      attempt.failedAt = new Date();
      attempt.reservationReleased = true;
      attempt.reservationReleasedAt = new Date();
      await attempt.save().catch(() => {});
    }
    if (order) {
      order.paymentStatus = "failed";
      order.inventoryRestored = true;
      order.statusHistory = order.statusHistory || [];
      order.statusHistory.push({ status: order.orderStatus || "pending", paymentStatus: "failed", changedBy: customerId, note: "Paymob intention creation failed; reservation released" });
      await order.save().catch(() => {});
    }
    throw err;
  }
}

async function createGuestPaymobIntention(body, idempotencyHeader) {
  const method = body.paymentMethod === "card" || body.paymentMethod === "paymob_card"
    ? "card"
    : body.paymentMethod === "wallet" || body.paymentMethod === "paymob_wallet"
      ? "wallet"
      : "";
  const integrationId = assertProviderAvailable(method);
  const idempotencyKey = orderService.validateIdempotencyKey(idempotencyHeader || body.idempotencyKey);
  const guestCustomer = normalizeGuestCustomer(body.guestCustomer || {});
  await assertGuestNotBlocked(guestCustomer);
  const shippingAddress = orderService.validateShippingAddress(body.shippingAddress || {});
  const cartItems = normalizeGuestCartItems(body.cartItems);
  const couponCode = String(body.couponCode || "").trim();
  const customerNote = orderService.cleanText(body.customerNote, 500, false);
  const idempotencyScope = `guest:${guestIdentityHash(guestCustomer)}:${method}`;

  const existing = await paymentAttemptModel.findOne({ customerType: "guest", idempotencyScope, idempotencyKey });
  if (existing) {
    const order = await orderModel.findById(existing.order);
    if (!order) throw httpError(409, "IDEMPOTENCY_CONFLICT", "Idempotent payment order is missing");
    const orderCartItems = (order.items || []).map((item) => ({
      productId: item.product,
      quantity: item.quantity,
      selectedColor: item.selectedColor || null,
      selectedSize: item.selectedSize || null,
      bundleOfferId: item.bundleOfferId || null,
      bundleGroupId: item.bundleGroupId || null,
      bundleRole: item.bundleRole || null,
      unitPriceCents: amountMinor(item.unitPrice),
      lineTotalCents: amountMinor(item.lineTotal),
    }));
    const fingerprint = requestFingerprint({
      method,
      shippingAddress,
      savedAddressId: "",
      couponCode,
      cartItems: orderCartItems,
      pricing: { grandTotal: order.total, currency: order.currency },
    });
    if (existing.requestFingerprint !== fingerprint) {
      throw httpError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different payment request");
    }
    if (terminal(existing.status)) {
      throw httpError(409, "IDEMPOTENCY_TERMINAL", "This payment attempt is terminal; start a new payment");
    }
    return { reused: true, ...safeAttemptResponse(existing, order) };
  }

  const checkout = await calculateGuestCheckoutPricing({ cartItems, shippingAddress, couponCode });
  const currency = String(checkout.summary.currency || config.storeCurrency).toUpperCase();
  if (currency !== config.paymobCurrency) {
    throw httpError(409, "PAYMENT_CURRENCY_MISMATCH", "Payment currency is not available");
  }
  const minor = amountMinor(checkout.summary.grandTotal);
  const fingerprint = requestFingerprint({
    method,
    shippingAddress,
    savedAddressId: "",
    couponCode,
    cartItems: checkout.items,
    pricing: checkout.summary,
  });
  const orderId = new mongoose.Types.ObjectId();
  const attemptId = new mongoose.Types.ObjectId();
  const internalReference = `rosetta_${orderId}_${attemptId}`;
  const expiresAt = new Date(Date.now() + config.paymobPaymentTtlMinutes * 60 * 1000);
  const tracking = generateTrackingToken();
  const customerSnapshot = orderService.guestCustomerSnapshot(guestCustomer, shippingAddress);
  let redemption = null;
  const deducted = [];
  let order;
  let attempt;
  try {
    redemption = await reserveCouponUsage({
      coupon: checkout.coupon,
      customerId: null,
      orderId,
      amount: checkout.pricingSnapshot.discountTotal,
    });
    deducted.push(...(await orderService.deductStock(checkout.items)));
    order = await orderModel.create({
      _id: orderId,
      customerType: "guest",
      guestCustomer,
      customerSnapshot,
      guestTrackingTokenHash: tracking.hash,
      guestTrackingTokenCreatedAt: new Date(),
      orderNumber: orderService.generateOrderNumber(),
      items: snapshots(checkout),
      allProduct: checkout.items.map((item) => ({
        id: item.productId,
        quantitiy: item.quantity,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
        bundleOfferId: item.bundleOfferId || null,
        bundleGroupId: item.bundleGroupId || null,
        bundleRole: item.bundleRole || null,
      })),
      subtotal: checkout.summary.merchandiseSubtotal,
      discountTotal: checkout.summary.discountTotal,
      discountSource: checkout.pricingSnapshot.discountSource,
      shippingFee: checkout.summary.shippingFee,
      total: checkout.summary.grandTotal,
      amount: checkout.summary.grandTotal,
      currency,
      shippingAddress: checkout.shippingAddress,
      address: [checkout.shippingAddress.street, checkout.shippingAddress.city, checkout.shippingAddress.governorate].filter(Boolean).join(", "),
      phone: Number(String(checkout.shippingAddress.phone).replace(/\D/g, "").slice(0, 15)) || 0,
      paymentMethod: PAYMENT_METHODS[method].orderMethod,
      paymentStatus: "pending",
      paymentProvider: "paymob",
      paymentAttempt: attemptId,
      paymentExpiresAt: expiresAt,
      orderStatus: "pending",
      status: "Not processed",
      customerNote,
      coupon: checkout.coupon ? checkout.coupon._id : null,
      couponCode: checkout.pricingSnapshot.couponSnapshot?.code || "",
      couponRedemption: redemption ? redemption._id : null,
      pricingSnapshot: checkout.pricingSnapshot,
      idempotencyKey: `paymob:${idempotencyKey}`,
      idempotencyScope,
      idempotencyPayloadHash: fingerprint,
      inventoryApplied: true,
      inventoryRestored: false,
      statusHistory: [{ status: "pending", paymentStatus: "pending", note: "Guest Paymob payment order reserved" }],
    });
    attempt = await paymentAttemptModel.create({
      _id: attemptId,
      customer: null,
      customerType: "guest",
      idempotencyScope,
      order: orderId,
      provider: "paymob",
      method,
      status: "creating",
      idempotencyKey,
      requestFingerprint: fingerprint,
      internalReference,
      amountMinor: minor,
      currency,
      expiresAt,
    });
    const provider = await getAdapter().createIntention({
      amountMinor: minor,
      currency,
      integrations: [Number(integrationId)],
      internalReference,
      customer: {
        name: guestCustomer.fullName,
        email: guestCustomer.email,
        phoneNumber: guestCustomer.phone,
        phone: guestCustomer.phone,
      },
      shippingAddress: checkout.shippingAddress,
      items: providerItems(checkout),
      notificationUrl: config.paymobWebhookUrl,
      redirectionUrl: config.paymobSuccessReturnUrl || config.paymobFailureReturnUrl,
    });
    if (!provider.providerIntentionId || !provider.clientSecret || !provider.checkoutUrl) {
      throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider response was incomplete");
    }
    attempt.providerIntentionId = provider.providerIntentionId;
    attempt.providerOrderId = provider.providerOrderId || "";
    attempt.checkoutReferenceProtected = encrypt(provider.clientSecret);
    attempt.status = "pending";
    await attempt.save();
    return {
      reused: false,
      ...safeAttemptResponse(attempt, order, {
        orderNumber: order.orderNumber,
        trackingToken: tracking.token,
      }),
    };
  } catch (err) {
    await orderService.restoreStock(deducted);
    if (redemption && checkout.coupon) {
      await releaseCouponUsage({ couponId: checkout.coupon._id, customerId: null, orderId });
    }
    if (attempt) {
      attempt.status = "failed";
      attempt.failureCode = err.code || "PAYMENT_PROVIDER_UNAVAILABLE";
      attempt.failureMessageSafe = "Payment could not be started";
      attempt.failedAt = new Date();
      attempt.reservationReleased = true;
      attempt.reservationReleasedAt = new Date();
      await attempt.save().catch(() => {});
    }
    if (order) {
      order.paymentStatus = "failed";
      order.inventoryRestored = true;
      order.statusHistory = order.statusHistory || [];
      order.statusHistory.push({ status: order.orderStatus || "pending", paymentStatus: "failed", note: "Paymob intention creation failed; reservation released" });
      await order.save().catch(() => {});
    }
    throw err;
  }
}

function boolValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function getPath(obj, path) {
  return path.split(".").reduce((current, key) => (current && current[key] !== undefined ? current[key] : ""), obj);
}

function calculateHmac(obj) {
  const text = PAYMOB_HMAC_FIELDS.map((field) => String(getPath(obj, field) ?? "")).join("");
  return crypto.createHmac("sha512", config.paymobHmacSecret).update(text).digest("hex");
}

function timingSafeEqualHex(received, calculated) {
  const a = Buffer.from(String(received || ""), "hex");
  const b = Buffer.from(String(calculated || ""), "hex");
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(calculated));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function extractWebhook(body, query = {}) {
  const obj = body && body.obj ? body.obj : body;
  const hmac = query.hmac || body.hmac || (body && body.obj && body.obj.hmac);
  if (!obj || typeof obj !== "object") throw httpError(400, "INVALID_WEBHOOK", "Invalid webhook payload");
  return { obj, hmac };
}

async function releaseReservation(order, attempt, note) {
  if (attempt.reservationReleased) return false;
  if (order.inventoryApplied && !order.inventoryRestored) {
    await orderService.restoreStock((order.items || []).map((item) => ({ productId: item.product, quantity: item.quantity })));
    order.inventoryRestored = true;
  }
  if (order.coupon && order.couponRedemption) {
    await releaseCouponUsage({ couponId: order.coupon, customerId: order.user || null, orderId: order._id });
  }
  attempt.reservationReleased = true;
  attempt.reservationReleasedAt = new Date();
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({ status: order.orderStatus || "pending", paymentStatus: attempt.status, note });
  return true;
}

async function markManualReview(attempt, order, code, message) {
  if (attempt.status !== "paid") {
    attempt.status = "manual_review";
    attempt.failureCode = code;
    attempt.failureMessageSafe = message;
    attempt.checkoutReferenceProtected = "";
    order.paymentStatus = "manual_review";
  }
  return { accepted: true, manualReview: true };
}

function webhookDigest(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

async function processPaymobWebhook(body, query = {}) {
  if (!config.paymobEnabled || !config.paymobHmacSecret) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider is unavailable");
  }
  const { obj, hmac } = extractWebhook(body, query);
  if (!hmac) throw httpError(401, "PAYMENT_HMAC_MISSING", "Webhook HMAC is required");
  const calculated = calculateHmac(obj);
  if (!timingSafeEqualHex(hmac, calculated)) {
    throw httpError(401, "PAYMENT_HMAC_INVALID", "Webhook HMAC is invalid");
  }
  const reference = obj.order?.merchant_order_id || obj.order?.merchant_order_id_extra || obj.order?.id || obj.merchant_order_id || obj.extra?.rosetta_reference || "";
  const transactionId = String(obj.id || "");
  const attempt = await paymentAttemptModel.findOne({
    $or: [
      { internalReference: reference },
      { providerOrderId: String(obj.order?.id || "") },
      { providerTransactionId: transactionId },
    ],
  });
  if (!attempt) throw httpError(202, "PAYMENT_ATTEMPT_UNKNOWN", "Payment attempt is unknown");
  const order = await orderModel.findById(attempt.order);
  if (!order) throw httpError(202, "PAYMENT_ORDER_UNKNOWN", "Payment order is unknown");
  const eventId = `${transactionId}:${obj.success}:${obj.pending}:${obj.amount_cents}`;
  if ((attempt.webhookEvents || []).some((event) => event.providerEventId === eventId)) {
    return { accepted: true, duplicate: true };
  }
  attempt.webhookEvents.push({
    providerEventId: eventId,
    transactionId,
    result: boolValue(obj.success) ? "success" : boolValue(obj.pending) ? "pending" : "failed",
    payloadDigest: webhookDigest(obj),
  });
  const integrationOk = String(obj.integration_id) === String(PAYMENT_METHODS[attempt.method].integration());
  const merchantOk = String(obj.merchant?.id || obj.merchant_id || "") === String(config.paymobMerchantId);
  const amountOk = Number(obj.amount_cents) === Number(attempt.amountMinor);
  const currencyOk = String(obj.currency || "").toUpperCase() === attempt.currency;
  const referenceOk = reference === attempt.internalReference || (!!attempt.providerOrderId && String(obj.order?.id || "") === String(attempt.providerOrderId));
  if (!merchantOk || !integrationOk || !amountOk || !currencyOk || !referenceOk) {
    await markManualReview(attempt, order, "PAYMENT_WEBHOOK_MISMATCH", "Payment callback needs manual review");
    await attempt.save();
    await order.save();
    return { accepted: true, manualReview: true };
  }
  if (terminal(attempt.status)) {
    if (attempt.status === "paid" && !boolValue(obj.success)) {
      attempt.failureCode = "PAYMENT_CONTRADICTION_AFTER_PAID";
    }
    if (attempt.status !== "paid" && boolValue(obj.success)) {
      attempt.status = "manual_review";
      order.paymentStatus = "manual_review";
      attempt.failureCode = "PAYMENT_SUCCESS_AFTER_RELEASE";
    }
    await attempt.save();
    await order.save();
    return { accepted: true, duplicate: false };
  }
  if (boolValue(obj.success) && !boolValue(obj.pending)) {
    attempt.status = "paid";
    attempt.providerTransactionId = transactionId;
    attempt.paidAt = new Date();
    attempt.checkoutReferenceProtected = "";
    order.paymentStatus = "paid";
    order.orderStatus = "confirmed";
    order.status = orderService.canonicalToLegacyStatus("confirmed");
    order.providerTransactionId = transactionId;
    order.transactionId = transactionId;
    order.statusHistory = order.statusHistory || [];
    order.statusHistory.push({ status: "confirmed", paymentStatus: "paid", note: "Verified Paymob webhook confirmed payment" });
  } else if (!boolValue(obj.pending)) {
    attempt.status = "failed";
    attempt.failedAt = new Date();
    attempt.failureCode = obj.data?.message || "PAYMENT_DECLINED";
    attempt.failureMessageSafe = "Payment was declined";
    attempt.checkoutReferenceProtected = "";
    order.paymentStatus = "failed";
    await releaseReservation(order, attempt, "Verified Paymob failure; reservation released");
  }
  await attempt.save();
  await order.save();
  return { accepted: true };
}

async function expirePendingAttempts({ now = new Date(), dryRun = true, limit = 50 } = {}) {
  const attempts = await paymentAttemptModel
    .find({ status: "pending", expiresAt: { $lte: now } })
    .sort({ expiresAt: 1 })
    .limit(limit);
  let expired = 0;
  for (const attempt of attempts) {
    if (dryRun) {
      expired += 1;
      continue;
    }
    const order = await orderModel.findById(attempt.order);
    if (!order || attempt.status !== "pending") continue;
    attempt.status = "expired";
    attempt.expiredAt = now;
    attempt.checkoutReferenceProtected = "";
    order.paymentStatus = "expired";
    await releaseReservation(order, attempt, "Payment attempt expired; reservation released");
    await attempt.save();
    await order.save();
    expired += 1;
  }
  return { scanned: attempts.length, expired, dryRun };
}

async function getPaymentStatus(actor, attemptId) {
  if (!mongoose.Types.ObjectId.isValid(attemptId)) {
    throw httpError(400, "VALIDATION_ERROR", "paymentAttemptId must be valid");
  }
  await expirePendingAttempts({ dryRun: false, limit: 10 });
  const attempt = await paymentAttemptModel.findById(attemptId);
  if (!attempt) throw httpError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "Payment attempt was not found");
  const isAdmin = actor && Number(actor.role) === 1;
  if (!isAdmin && String(attempt.customer) !== String(actor.userId)) {
    throw httpError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "Payment attempt was not found");
  }
  const order = await orderModel.findById(attempt.order);
  return {
    paymentAttemptId: String(attempt._id),
    orderId: String(attempt.order),
    paymentMethod: attempt.method,
    paymentStatus: attempt.status,
    orderStatus: order ? order.orderStatus || "pending" : "pending",
    amount: fromCents(attempt.amountMinor),
    currency: attempt.currency,
    paidAt: attempt.paidAt || null,
    expiresAt: attempt.expiresAt,
    safeMessage:
      attempt.status === "paid"
        ? "Payment confirmed"
        : attempt.status === "manual_review"
          ? "Payment is under review"
          : attempt.status === "failed"
            ? "Payment failed"
            : attempt.status === "expired"
              ? "Payment expired"
              : "Payment pending",
  };
}

async function getGuestPaymentStatus({ orderNumber, trackingToken }) {
  const normalizedOrderNumber = String(orderNumber || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{8,40}$/.test(normalizedOrderNumber)) {
    throw httpError(400, "VALIDATION_ERROR", "orderNumber is invalid");
  }
  if (!trackingToken || typeof trackingToken !== "string" || trackingToken.length < 32 || trackingToken.length > 200) {
    throw httpError(400, "VALIDATION_ERROR", "trackingToken is invalid");
  }
  await expirePendingAttempts({ dryRun: false, limit: 10 });
  const order = await orderModel
    .findOne({ customerType: "guest", orderNumber: normalizedOrderNumber })
    .select("+guestTrackingTokenHash");
  if (!order || !verifyTrackingToken(order, trackingToken)) {
    throw httpError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "Payment attempt was not found");
  }
  const attempt = await paymentAttemptModel.findOne({ order: order._id });
  if (!attempt) throw httpError(404, "PAYMENT_ATTEMPT_NOT_FOUND", "Payment attempt was not found");
  return {
    paymentAttemptId: String(attempt._id),
    orderId: String(attempt.order),
    orderNumber: order.orderNumber,
    paymentMethod: attempt.method,
    paymentStatus: attempt.status,
    orderStatus: order.orderStatus || "pending",
    amount: fromCents(attempt.amountMinor),
    currency: attempt.currency,
    paidAt: attempt.paidAt || null,
    expiresAt: attempt.expiresAt,
    safeMessage:
      attempt.status === "paid"
        ? "Payment confirmed"
        : attempt.status === "manual_review"
          ? "Payment is under review"
          : attempt.status === "failed"
            ? "Payment failed"
            : attempt.status === "expired"
              ? "Payment expired"
              : "Payment pending",
  };
}

module.exports = {
  PAYMOB_HMAC_FIELDS,
  calculateHmac,
  createGuestPaymobIntention,
  createPaymobIntention,
  expirePendingAttempts,
  getGuestPaymentStatus,
  getPaymentStatus,
  processPaymobWebhook,
  buildProviderItemsForCheckout: providerItems,
  timingSafeEqualHex,
};
