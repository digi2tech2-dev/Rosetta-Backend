const crypto = require("crypto");
const mongoose = require("mongoose");
const orderModel = require("../models/orders");
const productModel = require("../models/products");
const cartModel = require("../models/carts");
const { config } = require("../config/appConfig");
const { isValidObjectId } = require("../utils/validation");
const { isProductActive } = require("./cartService");
const {
  fromCents,
  getEffectiveProductPriceCents,
  moneySummary,
} = require("./pricingService");

const ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];
const PAYMENT_STATUSES = ["unpaid", "paid", "refunded", "failed"];
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
  return {
    fullName: cleanText(value.fullName, 120, true),
    phone,
    city: cleanText(value.city, 120, true),
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

function normalizeOrder(order) {
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
      }))
    : (doc.allProduct || []).map((item) => ({
        productId: String(item.id && item.id._id ? item.id._id : item.id),
        name: item.id && item.id.pName ? item.id.pName : "Legacy product",
        image: item.id && item.id.pImages ? item.id.pImages[0] : null,
        unitPrice: item.id && item.id.pPrice ? item.id.pPrice : 0,
        quantity: item.quantitiy || 0,
        lineTotal: (item.quantitiy || 0) * (item.id && item.id.pPrice ? item.id.pPrice : 0),
      }));

  return {
    _id: String(doc._id),
    id: String(doc._id),
    user: doc.user,
    items,
    allProduct: doc.allProduct || [],
    subtotal: doc.subtotal !== undefined ? doc.subtotal : doc.amount || 0,
    shippingFee: doc.shippingFee || 0,
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
    paymentStatus,
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
    const unitPriceCents = getEffectiveProductPriceCents(product);
    const lineTotalCents = unitPriceCents * quantity;
    subtotalCents += lineTotalCents;
    items.push({
      product,
      productId: product._id,
      name: product.pName,
      image: Array.isArray(product.pImages) ? product.pImages[0] : null,
      unitPrice: fromCents(unitPriceCents),
      quantity,
      lineTotal: fromCents(lineTotalCents),
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
  const customerNote = cleanText(body.customerNote, 500, false);
  const payloadHash = hashPayload({ shippingAddress, customerNote });

  const existing = await orderModel.findOne({ user: userId, idempotencyKey });
  if (existing) {
    if (existing.idempotencyPayloadHash !== payloadHash) {
      throw httpError(409, "CONFLICT", "Idempotency key was reused with a different payload");
    }
    return { order: normalizeOrder(existing), reused: true };
  }

  const checkout = await buildCartOrder(userId);
  const deducted = await deductStock(checkout.items);
  try {
    const snapshots = checkout.items.map((item) => ({
      product: item.productId,
      name: item.name,
      image: item.image,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    }));
    const order = await orderModel.create({
      user: userId,
      items: snapshots,
      allProduct: checkout.items.map((item) => ({
        id: item.productId,
        quantitiy: item.quantity,
      })),
      subtotal: checkout.summary.subtotal,
      shippingFee: checkout.summary.shippingFee,
      total: checkout.summary.total,
      amount: checkout.summary.total,
      currency: checkout.summary.currency,
      shippingAddress,
      address: [shippingAddress.street, shippingAddress.area, shippingAddress.city]
        .filter(Boolean)
        .join(", "),
      phone: Number(String(shippingAddress.phone).replace(/\D/g, "").slice(0, 15)) || 0,
      paymentMethod: "cash_on_delivery",
      paymentStatus: "unpaid",
      orderStatus: "pending",
      status: "Not processed",
      customerNote,
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
  return { orders: orders.map(normalizeOrder), pagination: { page: page.page, limit: page.limit, total } };
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
      .populate("allProduct.id", "pName pImages pPrice")
      .populate("user", "name email phoneNumber")
      .sort({ createdAt: -1, _id: -1 })
      .skip(page.skip)
      .limit(page.limit),
    orderModel.countDocuments(filter),
  ]);
  return { orders: orders.map(normalizeOrder), pagination: { page: page.page, limit: page.limit, total } };
}

async function getAdminOrder(orderId) {
  if (!isValidObjectId(orderId)) {
    throw httpError(400, "VALIDATION_ERROR", "orderId must be valid");
  }
  const order = await orderModel
    .findById(orderId)
    .populate("allProduct.id", "pName pImages pPrice")
    .populate("user", "name email phoneNumber");
  if (!order) {
    throw httpError(404, "NOT_FOUND", "Order not found");
  }
  return normalizeOrder(order);
}

async function updateStatus(orderId, nextStatus, adminUserId) {
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
    return normalizeOrder(order);
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
  return normalizeOrder(order);
}

module.exports = {
  ALLOWED_TRANSITIONS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  createCodOrder,
  getAdminOrder,
  getMyOrder,
  listAdminOrders,
  listMyOrders,
  normalizeOrder,
  updateStatus,
};
