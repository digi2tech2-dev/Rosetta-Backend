const crypto = require("crypto");
const mongoose = require("mongoose");
const orderModel = require("../models/orders");
const productModel = require("../models/products");
const cartModel = require("../models/carts");
const userModel = require("../models/users");
const { config } = require("../config/appConfig");
const { isValidObjectId } = require("../utils/validation");
const { isProductActive } = require("./cartService");
const { validateProductOptions } = require("./productOptionService");
const {
  calculateCheckoutPricing,
  calculateGuestCheckoutPricing,
  fromCents,
  getEffectiveProductPriceCents,
  moneySummary,
  releaseCouponUsage,
  reserveCouponUsage,
} = require("./pricingService");
const {
  assertGuestNotBlocked,
  generateTrackingToken,
  guestIdentityHash,
  normalizeGuestCartItems,
  normalizeGuestCustomer,
  publicGuestCustomer,
  verifyTrackingToken,
} = require("./guestCheckoutService");

const ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
const PAYMENT_STATUSES = ["unpaid", "pending", "paid", "refunded", "failed", "expired", "cancelled", "manual_review"];
const ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered"],
  delivered: [],
  cancelled: [],
};

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function generateOrderNumber() {
  const time = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `R${time}${random}`;
}

function validateIdempotencyKey(key) {
  if (!key || typeof key !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw httpError(400, "VALIDATION_ERROR", "A valid Idempotency-Key is required");
  }
  return key;
}

function cleanText(value, max, required) {
  if (value === undefined || value === null) {
    if (required) {
      throw httpError(400, "VALIDATION_ERROR", "Missing required shipping field");
    }
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw httpError(400, "VALIDATION_ERROR", "Shipping fields must be plain text");
  }
  const text = String(value).trim();
  if (required && !text) {
    throw httpError(400, "VALIDATION_ERROR", "Missing required shipping field");
  }
  if (text.length > max) {
    throw httpError(400, "VALIDATION_ERROR", "Shipping field is too long");
  }
  return text;
}

function validateShippingAddress(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const allowed = new Set([
    "fullName",
    "phone",
    "alternatePhone",
    "governorate",
    "city",
    "area",
    "street",
    "building",
    "apartment",
    "postalCode",
    "notes",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw httpError(400, "VALIDATION_ERROR", `Unexpected shipping field: ${key}`);
    }
  }
  const phone = cleanText(value.phone, 32, true);
  if (!/^[0-9+\-\s()]{6,32}$/.test(phone)) {
    throw httpError(400, "VALIDATION_ERROR", "Phone number is invalid");
  }
  const governorate = cleanText(value.governorate || value.city, 120, true);
  const city = cleanText(value.governorate ? value.city : value.area, 120, true);
  return {
    fullName: cleanText(value.fullName, 120, true),
    phone,
    alternatePhone: cleanText(value.alternatePhone, 32, false),
    governorate,
    city,
    area: cleanText(value.area, 120, false),
    street: cleanText(value.street, 180, true),
    building: cleanText(value.building, 80, false),
    apartment: cleanText(value.apartment, 80, false),
    postalCode: cleanText(value.postalCode, 40, false),
    notes: cleanText(value.notes, 500, false),
  };
}

function validatePagination(query) {
  const page = Math.max(Number.parseInt(query.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit || "20", 10) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function legacyStatusToCanonical(status) {
  const map = {
    "Not processed": "pending",
    Processing: "processing",
    Shipped: "shipped",
    Delivered: "delivered",
    Cancelled: "cancelled",
  };
  return map[status] || status || "pending";
}

function canonicalToLegacyStatus(status) {
  const map = {
    pending: "Not processed",
    confirmed: "Processing",
    processing: "Processing",
    shipped: "Shipped",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };
  return map[status] || status;
}

function cleanSnapshotText(value, max = 120) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max) : "";
}

function orderCustomer(doc, options = {}) {
  const isGuest = doc.customerType === "guest";
  const snapshot = doc.customerSnapshot || {};
  const shipping = doc.shippingAddress || {};
  const guest = doc.guestCustomer || {};
  if (isGuest) {
    const fullName = snapshot.fullName || guest.fullName || shipping.fullName || (options.admin ? "زائر" : "");
    return {
      name: fullName,
      fullName,
      email: options.admin ? guest.email || snapshot.email || "" : "",
      phone: guest.phone || shipping.phone || (doc.phone ? String(doc.phone) : ""),
      type: "guest",
    };
  }
  const fullName = snapshot.fullName || shipping.fullName || (doc.user && doc.user.name) || "";
  return {
    name: fullName,
    fullName,
    email: snapshot.email || (doc.user && doc.user.email) || "",
    phone: snapshot.phone || shipping.phone || (doc.user && (doc.user.phoneNumber || doc.user.phone)) || (doc.phone ? String(doc.phone) : ""),
    type: "registered",
  };
}

async function buildRegisteredCustomerSnapshot(userId, shippingAddress) {
  const user = await userModel.findById(userId).select("name email phoneNumber phone").lean();
  return {
    fullName: cleanSnapshotText(shippingAddress.fullName || (user && user.name), 120),
    email: cleanSnapshotText(user && user.email, 254),
    phone: cleanSnapshotText(shippingAddress.phone || (user && (user.phone || user.phoneNumber)), 32),
  };
}

function guestCustomerSnapshot(guestCustomer, shippingAddress) {
  return {
    fullName: cleanSnapshotText(guestCustomer.fullName || shippingAddress.fullName, 120),
    email: cleanSnapshotText(guestCustomer.email, 254),
    phone: cleanSnapshotText(guestCustomer.phone || shippingAddress.phone, 32),
  };
}

function itemSnapshot(item) {
  return {
    product: item.productId,
    name: item.name,
    image: item.image,
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    lineTotal: item.lineTotal,
    selectedColor: item.selectedColor || null,
    selectedSize: item.selectedSize || null,
    merchantName: item.merchantName || null,
  };
}

function normalizeOrder(order, options = {}) {
  const doc = order && order.toObject ? order.toObject() : order;
  if (!doc) {
    return null;
  }
  const canonicalStatus = doc.orderStatus || legacyStatusToCanonical(doc.status);
  const paymentStatus = doc.paymentStatus || (canonicalStatus === "delivered" ? "paid" : "unpaid");
  const items = Array.isArray(doc.items) && doc.items.length > 0
    ? doc.items.map((item) => ({
        productId: String(item.product),
        name: item.name,
        image: item.image,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        lineTotal: item.lineTotal,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
        ...(options.admin ? { merchantName: item.merchantName || null, pMerchantName: item.merchantName || null } : {}),
      }))
    : (doc.allProduct || []).map((item) => ({
        productId: String(item.id && item.id._id ? item.id._id : item.id),
        name: item.id && item.id.pName ? item.id.pName : "Legacy product",
        image: item.id && item.id.pImages ? item.id.pImages[0] : null,
        unitPrice: item.id && item.id.pPrice ? item.id.pPrice : 0,
        quantity: item.quantitiy || 0,
        lineTotal: (item.quantitiy || 0) * (item.id && item.id.pPrice ? item.id.pPrice : 0),
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
        ...(options.admin ? { merchantName: item.id && item.id.pMerchantName ? item.id.pMerchantName : null, pMerchantName: item.id && item.id.pMerchantName ? item.id.pMerchantName : null } : {}),
      }));
  const customer = orderCustomer(doc, options);
  const shippingSnapshot = doc.pricingSnapshot?.shippingSnapshot || {};
  const totalQuantity = doc.pricingSnapshot?.totalQuantity ?? items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const finalShippingFee = doc.shippingFee ?? doc.pricingSnapshot?.shippingFee ?? shippingSnapshot.finalFee ?? shippingSnapshot.chargedFee ?? 0;

  return {
    _id: String(doc._id),
    id: String(doc._id),
    user: doc.user,
    customer,
    customerSnapshot: doc.customerSnapshot || null,
    customerType: doc.customerType || "registered",
    guestCustomer: doc.customerType === "guest"
      ? options.admin
        ? {
            fullName: doc.guestCustomer?.fullName || "",
            email: doc.guestCustomer?.email || "",
            phone: doc.guestCustomer?.phone || "",
          }
        : publicGuestCustomer(doc.guestCustomer || {})
      : null,
    orderNumber: doc.orderNumber || "",
    items,
    allProduct: doc.allProduct || [],
    subtotal: doc.subtotal !== undefined ? doc.subtotal : doc.amount || 0,
    merchandiseSubtotal: doc.pricingSnapshot?.merchandiseSubtotal ?? doc.subtotal ?? doc.amount ?? 0,
    discountTotal: doc.discountTotal || doc.pricingSnapshot?.discountTotal || 0,
    discount: doc.discountTotal || doc.pricingSnapshot?.discountTotal || 0,
    discountSource: doc.discountSource || doc.pricingSnapshot?.discountSource || "none",
    couponCode: doc.couponCode || doc.pricingSnapshot?.couponSnapshot?.code || "",
    couponSnapshot: doc.pricingSnapshot?.couponSnapshot || null,
    firstOrderPromotionSnapshot: doc.pricingSnapshot?.firstOrderPromotionSnapshot || null,
    pricingSnapshot: doc.pricingSnapshot || null,
    totalQuantity,
    shippingBaseCost: shippingSnapshot.baseFee ?? shippingSnapshot.chargedFee ?? finalShippingFee,
    shippingDiscountPercent: shippingSnapshot.quantityDiscountPercent ?? 0,
    shippingDiscountAmount: shippingSnapshot.quantityDiscountAmount ?? 0,
    finalShippingCost: finalShippingFee,
    shippingFee: finalShippingFee,
    total: doc.total !== undefined ? doc.total : doc.amount || 0,
    amount: doc.amount !== undefined ? doc.amount : doc.total || 0,
    currency: doc.currency || config.storeCurrency,
    shippingAddress: doc.shippingAddress || {
      fullName: doc.user && doc.user.name ? doc.user.name : "",
      phone: doc.phone ? String(doc.phone) : "",
      city: "",
      area: "",
      street: doc.address || "",
      building: "",
      apartment: "",
      postalCode: "",
      notes: "",
    },
    address: doc.address,
    phone: doc.phone,
    paymentMethod: doc.paymentMethod || "legacy_braintree",
    paymentProvider: doc.paymentProvider || null,
    paymentAttempt: doc.paymentAttempt ? String(doc.paymentAttempt) : null,
    paymentStatus,
    providerTransactionId: doc.providerTransactionId || doc.transactionId || "",
    paymentExpiresAt: doc.paymentExpiresAt || null,
    orderStatus: canonicalStatus,
    status: canonicalToLegacyStatus(canonicalStatus),
    transactionId: doc.transactionId || "",
    customerNote: doc.customerNote || "",
    statusHistory: doc.statusHistory || [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function buildCartOrder(userId) {
  const cart = await cartModel.findOne({ user: userId });
  if (!cart || !cart.items || cart.items.length === 0) {
    throw httpError(409, "CONFLICT", "Cart is empty");
  }
  const ids = cart.items.map((item) => item.product);
  const products = await productModel.find({ _id: { $in: ids } });
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const quantitiesByProduct = new Map();
  for (const cartItem of cart.items) {
    const productId = String(cartItem.product);
    quantitiesByProduct.set(productId, (quantitiesByProduct.get(productId) || 0) + (Number(cartItem.quantity) || 0));
  }

  let subtotalCents = 0;
  const items = [];
  for (const cartItem of cart.items) {
    const product = productMap.get(String(cartItem.product));
    const quantity = Number(cartItem.quantity) || 0;
    if (!product || !isProductActive(product)) {
      throw httpError(409, "CONFLICT", "A cart item is no longer available");
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxItemQuantity) {
      throw httpError(409, "CONFLICT", "A cart item has an invalid quantity");
    }
    if (Number(product.pQuantity) < quantity) {
      throw httpError(409, "CONFLICT", "A cart item exceeds available stock");
    }
    if (Number(product.pQuantity) < quantitiesByProduct.get(String(product._id))) {
      throw httpError(409, "CONFLICT", "Cart quantity exceeds shared product stock");
    }
    const options = validateProductOptions({
      product,
      selectedColor: cartItem.selectedColor,
      selectedSize: cartItem.selectedSize,
    });
    const unitPriceCents = getEffectiveProductPriceCents(product);
    const lineTotalCents = unitPriceCents * quantity;
    subtotalCents += lineTotalCents;
    items.push({
      product,
      productId: product._id,
      name: product.pName,
      image: Array.isArray(product.pImages) ? product.pImages[0] : null,
      merchantName: product.pMerchantName || null,
      unitPrice: fromCents(unitPriceCents),
      quantity,
      lineTotal: fromCents(lineTotalCents),
      selectedColor: options.selectedColor,
      selectedSize: options.selectedSize,
    });
  }

  return {
    cart,
    items,
    summary: moneySummary(
      subtotalCents,
      items.reduce((count, item) => count + item.quantity, 0)
    ),
  };
}

async function deductStock(items) {
  const deducted = [];
  try {
    for (const item of items) {
      const result = await productModel.updateOne(
        {
          _id: item.productId,
          pStatus: "Active",
          pQuantity: { $gte: item.quantity },
        },
        {
          $inc: {
            pQuantity: -item.quantity,
            pSold: item.quantity,
          },
        }
      );
      if (result.nModified !== 1 && result.modifiedCount !== 1) {
        throw httpError(409, "CONFLICT", "Insufficient stock during checkout");
      }
      deducted.push(item);
    }
  } catch (err) {
    await restoreStock(deducted);
    throw err;
  }
  return deducted;
}

async function restoreStock(items) {
  for (const item of items) {
    await productModel.updateOne(
      { _id: item.productId || item.product },
      {
        $inc: {
          pQuantity: item.quantity,
          pSold: -item.quantity,
        },
      }
    );
  }
}

async function createCodOrder(userId, body, idempotencyHeader) {
  const idempotencyKey = validateIdempotencyKey(idempotencyHeader || body.idempotencyKey);
  const shippingAddress = validateShippingAddress(body.shippingAddress);
  const couponCode = String(body.couponCode || "").trim();
  const savedAddressId = body.savedAddressId;
  const customerNote = cleanText(body.customerNote, 500, false);
  const payloadHash = hashPayload({ shippingAddress, savedAddressId: savedAddressId || "", couponCode, customerNote });

  const existing = await orderModel.findOne({ user: userId, idempotencyKey });
  if (existing) {
    if (existing.idempotencyPayloadHash !== payloadHash) {
      throw httpError(409, "CONFLICT", "Idempotency key was reused with a different payload");
    }
    return { order: normalizeOrder(existing), reused: true };
  }

  const checkout = await calculateCheckoutPricing({
    customerId: userId,
    shippingAddress,
    savedAddressId,
    couponCode,
  });
  const orderId = new mongoose.Types.ObjectId();
  const customerSnapshot = await buildRegisteredCustomerSnapshot(userId, checkout.shippingAddress);
  let redemption = null;
  const deducted = [];
  try {
    redemption = await reserveCouponUsage({
      coupon: checkout.coupon,
      customerId: userId,
      orderId,
      amount: checkout.pricingSnapshot.discountTotal,
    });
    deducted.push(...(await deductStock(checkout.items)));
    const snapshots = checkout.items.map(itemSnapshot);
    const order = await orderModel.create({
      _id: orderId,
      user: userId,
      customerType: "registered",
      customerSnapshot,
      orderNumber: generateOrderNumber(),
      items: snapshots,
      allProduct: checkout.items.map((item) => ({
        id: item.productId,
        quantitiy: item.quantity,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
      })),
      subtotal: checkout.summary.merchandiseSubtotal,
      discountTotal: checkout.summary.discountTotal,
      discountSource: checkout.pricingSnapshot.discountSource,
      shippingFee: checkout.summary.shippingFee,
      total: checkout.summary.grandTotal,
      amount: checkout.summary.grandTotal,
      currency: checkout.summary.currency,
      shippingAddress: checkout.shippingAddress,
      address: [checkout.shippingAddress.street, checkout.shippingAddress.city, checkout.shippingAddress.governorate]
        .filter(Boolean)
        .join(", "),
      phone: Number(String(checkout.shippingAddress.phone).replace(/\D/g, "").slice(0, 15)) || 0,
      paymentMethod: "cash_on_delivery",
      paymentStatus: "unpaid",
      orderStatus: "pending",
      status: "Not processed",
      customerNote,
      coupon: checkout.coupon ? checkout.coupon._id : null,
      couponCode: checkout.pricingSnapshot.couponSnapshot?.code || "",
      couponRedemption: redemption ? redemption._id : null,
      pricingSnapshot: checkout.pricingSnapshot,
      idempotencyKey,
      idempotencyPayloadHash: payloadHash,
      inventoryApplied: true,
      inventoryRestored: false,
      statusHistory: [
        {
          status: "pending",
          paymentStatus: "unpaid",
          changedBy: userId,
          note: "Cash on Delivery order created",
        },
      ],
    });
    checkout.cart.items = [];
    await checkout.cart.save();
    return { order: normalizeOrder(order), reused: false };
  } catch (err) {
    await restoreStock(deducted);
    if (redemption && checkout.coupon) {
      await releaseCouponUsage({ couponId: checkout.coupon._id, customerId: userId, orderId });
    }
    throw err;
  }
}

async function createGuestCodOrder(body, idempotencyHeader) {
  const idempotencyKey = validateIdempotencyKey(idempotencyHeader || body.idempotencyKey);
  const guestCustomer = normalizeGuestCustomer(body.guestCustomer || {});
  await assertGuestNotBlocked(guestCustomer);
  const shippingAddress = validateShippingAddress(body.shippingAddress);
  const cartItems = normalizeGuestCartItems(body.cartItems);
  const couponCode = String(body.couponCode || "").trim();
  const customerNote = cleanText(body.customerNote, 500, false);
  const idempotencyScope = `guest:${guestIdentityHash(guestCustomer)}:cod`;
  const payloadHash = hashPayload({ guestCustomer, shippingAddress, cartItems, couponCode, customerNote });

  const existing = await orderModel
    .findOne({ customerType: "guest", idempotencyScope, idempotencyKey })
    .select("+guestTrackingTokenHash");
  if (existing) {
    if (existing.idempotencyPayloadHash !== payloadHash) {
      throw httpError(409, "CONFLICT", "Idempotency key was reused with a different payload");
    }
    return { order: normalizeOrder(existing), reused: true, guestTracking: null };
  }

  const checkout = await calculateGuestCheckoutPricing({
    cartItems,
    shippingAddress,
    couponCode,
  });
  const orderId = new mongoose.Types.ObjectId();
  const customerSnapshot = guestCustomerSnapshot(guestCustomer, shippingAddress);
  const tracking = generateTrackingToken();
  let redemption = null;
  const deducted = [];
  try {
    redemption = await reserveCouponUsage({
      coupon: checkout.coupon,
      customerId: null,
      orderId,
      amount: checkout.pricingSnapshot.discountTotal,
    });
    deducted.push(...(await deductStock(checkout.items)));
    const snapshots = checkout.items.map(itemSnapshot);
    const order = await orderModel.create({
      _id: orderId,
      customerType: "guest",
      guestCustomer,
      customerSnapshot,
      guestTrackingTokenHash: tracking.hash,
      guestTrackingTokenCreatedAt: new Date(),
      orderNumber: generateOrderNumber(),
      items: snapshots,
      allProduct: checkout.items.map((item) => ({
        id: item.productId,
        quantitiy: item.quantity,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
      })),
      subtotal: checkout.summary.merchandiseSubtotal,
      discountTotal: checkout.summary.discountTotal,
      discountSource: checkout.pricingSnapshot.discountSource,
      shippingFee: checkout.summary.shippingFee,
      total: checkout.summary.grandTotal,
      amount: checkout.summary.grandTotal,
      currency: checkout.summary.currency,
      shippingAddress: checkout.shippingAddress,
      address: [checkout.shippingAddress.street, checkout.shippingAddress.city, checkout.shippingAddress.governorate]
        .filter(Boolean)
        .join(", "),
      phone: Number(String(checkout.shippingAddress.phone).replace(/\D/g, "").slice(0, 15)) || 0,
      paymentMethod: "cash_on_delivery",
      paymentStatus: "unpaid",
      orderStatus: "pending",
      status: "Not processed",
      customerNote,
      coupon: checkout.coupon ? checkout.coupon._id : null,
      couponCode: checkout.pricingSnapshot.couponSnapshot?.code || "",
      couponRedemption: redemption ? redemption._id : null,
      pricingSnapshot: checkout.pricingSnapshot,
      idempotencyKey,
      idempotencyScope,
      idempotencyPayloadHash: payloadHash,
      inventoryApplied: true,
      inventoryRestored: false,
      statusHistory: [
        {
          status: "pending",
          paymentStatus: "unpaid",
          note: "Guest Cash on Delivery order created",
        },
      ],
    });
    return {
      order: normalizeOrder(order),
      reused: false,
      guestTracking: {
        orderNumber: order.orderNumber,
        trackingToken: tracking.token,
      },
    };
  } catch (err) {
    await restoreStock(deducted);
    if (redemption && checkout.coupon) {
      await releaseCouponUsage({ couponId: checkout.coupon._id, customerId: null, orderId });
    }
    throw err;
  }
}

async function listMyOrders(userId, query) {
  const page = validatePagination(query);
  const [orders, total] = await Promise.all([
    orderModel
      .find({ user: userId })
      .populate("allProduct.id", "pName pImages pPrice")
      .populate("user", "name email phoneNumber")
      .sort({ createdAt: -1, _id: -1 })
      .skip(page.skip)
      .limit(page.limit),
    orderModel.countDocuments({ user: userId }),
  ]);
  return { orders: orders.map((order) => normalizeOrder(order)), pagination: { page: page.page, limit: page.limit, total } };
}

async function getMyOrder(userId, orderId) {
  if (!isValidObjectId(orderId)) {
    throw httpError(400, "VALIDATION_ERROR", "orderId must be valid");
  }
  const order = await orderModel
    .findOne({ _id: orderId, user: userId })
    .populate("allProduct.id", "pName pImages pPrice")
    .populate("user", "name email phoneNumber");
  if (!order) {
    throw httpError(404, "NOT_FOUND", "Order not found");
  }
  return normalizeOrder(order);
}

function adminFilter(query) {
  const filter = {};
  if (query.orderStatus) {
    if (!ORDER_STATUSES.includes(query.orderStatus)) {
      throw httpError(400, "VALIDATION_ERROR", "Invalid orderStatus filter");
    }
    filter.orderStatus = query.orderStatus;
  }
  if (query.paymentStatus) {
    if (!PAYMENT_STATUSES.includes(query.paymentStatus)) {
      throw httpError(400, "VALIDATION_ERROR", "Invalid paymentStatus filter");
    }
    filter.paymentStatus = query.paymentStatus;
  }
  return filter;
}

async function listAdminOrders(query) {
  const page = validatePagination(query);
  const filter = adminFilter(query);
  const [orders, total] = await Promise.all([
    orderModel
      .find(filter)
      .populate("allProduct.id", "pName pImages pPrice pMerchantName")
      .populate("user", "name email phoneNumber")
      .sort({ createdAt: -1, _id: -1 })
      .skip(page.skip)
      .limit(page.limit),
    orderModel.countDocuments(filter),
  ]);
  return { orders: orders.map((order) => normalizeOrder(order, { admin: true })), pagination: { page: page.page, limit: page.limit, total } };
}

async function getAdminOrder(orderId) {
  if (!isValidObjectId(orderId)) {
    throw httpError(400, "VALIDATION_ERROR", "orderId must be valid");
  }
  const order = await orderModel
    .findById(orderId)
    .populate("allProduct.id", "pName pImages pPrice pMerchantName")
    .populate("user", "name email phoneNumber");
  if (!order) {
    throw httpError(404, "NOT_FOUND", "Order not found");
  }
  return normalizeOrder(order, { admin: true });
}

async function updateStatus(orderId, nextStatus, adminUserId, options = {}) {
  if (!isValidObjectId(orderId)) {
    throw httpError(400, "VALIDATION_ERROR", "orderId must be valid");
  }
  if (!ORDER_STATUSES.includes(nextStatus)) {
    throw httpError(400, "VALIDATION_ERROR", "Invalid order status");
  }
  const order = await orderModel.findById(orderId);
  if (!order) {
    throw httpError(404, "NOT_FOUND", "Order not found");
  }
  const current = order.orderStatus || legacyStatusToCanonical(order.status);
  if (current === nextStatus) {
    return normalizeOrder(order, options);
  }
  if (!(ALLOWED_TRANSITIONS[current] || []).includes(nextStatus)) {
    throw httpError(409, "CONFLICT", `Cannot transition order from ${current} to ${nextStatus}`);
  }

  if (nextStatus === "cancelled" && order.inventoryApplied && !order.inventoryRestored) {
    const stockItems = (order.items || []).map((item) => ({
      productId: item.product,
      quantity: item.quantity,
    }));
    await restoreStock(stockItems);
    order.inventoryRestored = true;
  }
  if (nextStatus === "cancelled" && order.coupon && order.couponRedemption) {
    await releaseCouponUsage({ couponId: order.coupon, customerId: order.user || null, orderId: order._id });
  }
  if (nextStatus === "delivered" && order.paymentMethod === "cash_on_delivery") {
    order.paymentStatus = "paid";
  }

  order.orderStatus = nextStatus;
  order.status = canonicalToLegacyStatus(nextStatus);
  if (!order.paymentStatus) {
    order.paymentStatus = "unpaid";
  }
  order.statusHistory = order.statusHistory || [];
  order.statusHistory.push({
    status: nextStatus,
    paymentStatus: order.paymentStatus,
    changedBy: adminUserId,
  });
  await order.save();
  return normalizeOrder(order, options);
}

async function getGuestOrderStatus({ orderNumber, trackingToken }) {
  const normalizedOrderNumber = String(orderNumber || "").trim().toUpperCase();
  if (!/^[A-Z0-9_-]{8,40}$/.test(normalizedOrderNumber)) {
    throw httpError(400, "VALIDATION_ERROR", "orderNumber is invalid");
  }
  if (!trackingToken || typeof trackingToken !== "string" || trackingToken.length < 32 || trackingToken.length > 200) {
    throw httpError(400, "VALIDATION_ERROR", "trackingToken is invalid");
  }
  const order = await orderModel
    .findOne({ customerType: "guest", orderNumber: normalizedOrderNumber })
    .select("+guestTrackingTokenHash");
  if (!order || !verifyTrackingToken(order, trackingToken)) {
    throw httpError(404, "ORDER_NOT_FOUND", "Order was not found");
  }
  return {
    orderId: String(order._id),
    orderNumber: order.orderNumber,
    customerType: "guest",
    guestCustomer: publicGuestCustomer(order.guestCustomer || {}),
    paymentStatus: order.paymentStatus || "unpaid",
    orderStatus: order.orderStatus || "pending",
    paymentMethod: order.paymentMethod,
    total: order.total,
    currency: order.currency,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: (order.items || []).map((item) => ({
      name: item.name,
      image: item.image,
      quantity: item.quantity,
      selectedColor: item.selectedColor || null,
      selectedSize: item.selectedSize || null,
    })),
  };
}

module.exports = {
  ALLOWED_TRANSITIONS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  canonicalToLegacyStatus,
  cleanText,
  createCodOrder,
  createGuestCodOrder,
  deductStock,
  generateOrderNumber,
  getAdminOrder,
  getGuestOrderStatus,
  getMyOrder,
  buildRegisteredCustomerSnapshot,
  guestCustomerSnapshot,
  hashPayload,
  itemSnapshot,
  listAdminOrders,
  listMyOrders,
  normalizeOrder,
  restoreStock,
  updateStatus,
  validateIdempotencyKey,
  validateShippingAddress,
};
