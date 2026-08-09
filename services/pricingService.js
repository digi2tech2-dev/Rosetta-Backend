const mongoose = require("mongoose");
const { config } = require("../config/appConfig");
const cartModel = require("../models/carts");
const productModel = require("../models/products");
const orderModel = require("../models/orders");
const userModel = require("../models/users");
const couponModel = require("../models/coupons");
const couponRedemptionModel = require("../models/couponRedemptions");
const shippingRuleModel = require("../models/shippingRules");
const commerceSettingsModel = require("../models/commerceSettings");
const { isValidObjectId } = require("../utils/validation");
const { validateProductOptions } = require("./productOptionService");
const { normalizeGuestCartItems } = require("./guestCheckoutService");

const QUALIFYING_FIRST_ORDER_STATUSES = [
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "Not processed",
  "Processing",
  "Shipped",
  "Delivered",
];

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw Object.assign(new Error("Invalid product price"), {
      status: 409,
      code: "INVALID_PRODUCT_PRICE",
    });
  }
  return Math.round(amount * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

function money(value) {
  return fromCents(toCents(value || 0));
}

function quantityShippingDiscountPercent(totalQuantity) {
  const quantity = Number(totalQuantity) || 0;
  if (quantity >= 6) return 100;
  if (quantity >= 4) return 50;
  return 0;
}

function nextQuantityShippingThreshold(totalQuantity) {
  const quantity = Number(totalQuantity) || 0;
  if (quantity >= 6) return null;
  return quantity >= 4 ? 6 : 4;
}

function calculateQuantityShippingDiscountCents({ totalQuantity, baseShippingCents }) {
  const quantity = Math.max(0, Number(totalQuantity) || 0);
  const baseCents = Math.max(0, Number.isFinite(Number(baseShippingCents)) ? Math.round(Number(baseShippingCents)) : 0);
  const discountPercent = quantityShippingDiscountPercent(quantity);
  const discountAmountCents = Math.min(baseCents, Math.round((baseCents * discountPercent) / 100));
  const finalShippingCents = Math.max(0, baseCents - discountAmountCents);
  const nextThreshold = nextQuantityShippingThreshold(quantity);
  return {
    totalQuantity: quantity,
    discountPercent,
    discountAmountCents,
    finalShippingCents,
    nextThreshold,
    quantityNeededForNextThreshold: nextThreshold === null ? 0 : Math.max(0, nextThreshold - quantity),
  };
}

function calculateQuantityShippingDiscount({ totalQuantity, baseShippingCost }) {
  const result = calculateQuantityShippingDiscountCents({
    totalQuantity,
    baseShippingCents: toCents(baseShippingCost || 0),
  });
  return {
    totalQuantity: result.totalQuantity,
    discountPercent: result.discountPercent,
    discountAmount: fromCents(result.discountAmountCents),
    shippingAfterQuantityDiscount: fromCents(result.finalShippingCents),
    nextThreshold: result.nextThreshold,
    quantityNeededForNextThreshold: result.quantityNeededForNextThreshold,
  };
}

function calculateQuantityShippingPromotionMetadata(totalQuantity) {
  const result = calculateQuantityShippingDiscountCents({
    totalQuantity,
    baseShippingCents: 0,
  });
  return {
    type: "quantity",
    totalQuantity: result.totalQuantity,
    discountPercent: result.discountPercent,
    discountAmount: 0,
    nextThreshold: result.nextThreshold,
    quantityNeededForNextThreshold: result.quantityNeededForNextThreshold,
  };
}

function getEffectiveProductPriceCents(product) {
  return toCents(product.pPrice);
}

function getEffectiveProductPrice(product) {
  return fromCents(getEffectiveProductPriceCents(product));
}

function calculateShippingCents(subtotalCents) {
  const flat = toCents(config.shippingFlatRate);
  const freeMinimum = toCents(config.freeShippingMinimum);
  if (freeMinimum > 0 && subtotalCents >= freeMinimum) {
    return 0;
  }
  return flat;
}

function moneySummary(subtotalCents, itemCount) {
  const shippingCents = calculateShippingCents(subtotalCents);
  return {
    itemCount,
    totalQuantity: itemCount,
    subtotal: fromCents(subtotalCents),
    shippingFee: fromCents(shippingCents),
    total: fromCents(subtotalCents + shippingCents),
    currency: config.storeCurrency,
    shippingPromotion: calculateQuantityShippingPromotionMetadata(itemCount),
  };
}

function normalizeCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) return "";
  if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalized)) {
    throw httpError(400, "COUPON_NOT_APPLICABLE", "Coupon code is invalid");
  }
  return normalized;
}

function normalizePlace(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function shippingAddressFromUserAddress(address) {
  if (!address) return null;
  return {
    fullName: address.fullName || "",
    phone: address.phone || "",
    alternatePhone: address.alternatePhone || "",
    governorate: address.governorate || address.city || "",
    city: address.city || address.area || "",
    area: address.area || "",
    street: address.street || "",
    building: address.building || "",
    apartment: address.apartment || "",
    postalCode: address.postalCode || "",
    notes: address.notes || "",
  };
}

async function resolveShippingAddress(customerId, input = {}) {
  if (input.savedAddressId) {
    if (!isValidObjectId(input.savedAddressId)) {
      throw httpError(400, "VALIDATION_ERROR", "savedAddressId must be valid");
    }
    const user = await userModel.findById(customerId);
    const address = user && user.addresses && user.addresses.id(input.savedAddressId);
    if (!address) {
      throw httpError(404, "ADDRESS_NOT_FOUND", "Saved address was not found");
    }
    return shippingAddressFromUserAddress(address);
  }
  const raw = input.shippingAddress || {};
  const governorate = raw.governorate || raw.city || "";
  const city = raw.governorate ? raw.city || "" : raw.area || "";
  return {
    fullName: String(raw.fullName || "").trim(),
    phone: String(raw.phone || "").trim(),
    alternatePhone: String(raw.alternatePhone || "").trim(),
    governorate: String(governorate || "").trim(),
    city: String(city || "").trim(),
    area: String(raw.area || "").trim(),
    street: String(raw.street || "").trim(),
    building: String(raw.building || "").trim(),
    apartment: String(raw.apartment || "").trim(),
    postalCode: String(raw.postalCode || "").trim(),
    notes: String(raw.notes || "").trim(),
  };
}

async function getCommerceSettings() {
  const settings = await commerceSettingsModel.findOne({ singletonKey: "commerce" });
  if (settings) return settings;
  return {
    currency: config.storeCurrency,
    defaultShippingFee: config.shippingFlatRate,
    defaultFreeShippingThreshold: config.freeShippingMinimum,
    automaticFirstOrderDiscountEnabled: false,
    automaticFirstOrderDiscountType: "percentage",
    automaticFirstOrderDiscountValue: 0,
    automaticFirstOrderMaxDiscount: null,
  };
}

function serializeMoneySummary({ itemCount, merchandiseSubtotalCents, discountCents, shippingCents, currency }) {
  const grandTotalCents = Math.max(0, merchandiseSubtotalCents - discountCents + shippingCents);
  return {
    itemCount,
    totalQuantity: itemCount,
    subtotal: fromCents(merchandiseSubtotalCents),
    merchandiseSubtotal: fromCents(merchandiseSubtotalCents),
    discountTotal: fromCents(discountCents),
    shippingFee: fromCents(shippingCents),
    total: fromCents(grandTotalCents),
    grandTotal: fromCents(grandTotalCents),
    currency,
  };
}

async function buildServerCart(customerId) {
  const cart = await cartModel.findOne({ user: customerId });
  if (!cart || !cart.items || cart.items.length === 0) {
    throw httpError(409, "CART_EMPTY", "Cart is empty");
  }
  const ids = cart.items.map((item) => item.product);
  const products = await productModel.find({ _id: { $in: ids } });
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const quantitiesByProduct = new Map();
  for (const cartItem of cart.items) {
    const productId = String(cartItem.product);
    quantitiesByProduct.set(productId, (quantitiesByProduct.get(productId) || 0) + (Number(cartItem.quantity) || 0));
  }

  const items = [];
  let subtotalCents = 0;
  let itemCount = 0;
  for (const cartItem of cart.items) {
    const product = productMap.get(String(cartItem.product));
    const quantity = Number(cartItem.quantity) || 0;
    if (!product || String(product.pStatus || "").toLowerCase() !== "active") {
      throw httpError(409, "PRODUCT_UNAVAILABLE", "A cart item is no longer available");
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxItemQuantity) {
      throw httpError(409, "INVALID_CART_QUANTITY", "A cart item has an invalid quantity");
    }
    if (Number(product.pQuantity) < quantity || Number(product.pQuantity) < quantitiesByProduct.get(String(product._id))) {
      throw httpError(409, "OUT_OF_STOCK", "Cart quantity exceeds shared product stock");
    }
    const options = validateProductOptions({
      product,
      selectedColor: cartItem.selectedColor,
      selectedSize: cartItem.selectedSize,
    });
    const unitPriceCents = getEffectiveProductPriceCents(product);
    const lineTotalCents = unitPriceCents * quantity;
    subtotalCents += lineTotalCents;
    itemCount += quantity;
    items.push({
      product,
      productId: product._id,
      name: product.pName,
      image: Array.isArray(product.pImages) ? product.pImages[0] : null,
      merchantName: product.pMerchantName || null,
      unitPriceCents,
      lineTotalCents,
      unitPrice: fromCents(unitPriceCents),
      lineTotal: fromCents(lineTotalCents),
      quantity,
      selectedColor: options.selectedColor,
      selectedSize: options.selectedSize,
      available: true,
      stock: Number(product.pQuantity) || 0,
    });
  }
  return { cart, items, subtotalCents, itemCount };
}

async function buildGuestCart(rawItems) {
  const normalizedItems = normalizeGuestCartItems(rawItems);
  const ids = normalizedItems.map((item) => item.productId);
  const products = await productModel.find({ _id: { $in: ids } });
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const quantitiesByProduct = new Map();
  for (const cartItem of normalizedItems) {
    quantitiesByProduct.set(
      cartItem.productId,
      (quantitiesByProduct.get(cartItem.productId) || 0) + cartItem.quantity
    );
  }

  const items = [];
  let subtotalCents = 0;
  let itemCount = 0;
  for (const cartItem of normalizedItems) {
    const product = productMap.get(cartItem.productId);
    if (!product || String(product.pStatus || "").toLowerCase() !== "active") {
      throw httpError(409, "PRODUCT_UNAVAILABLE", "A cart item is no longer available");
    }
    if (Number(product.pQuantity) < cartItem.quantity || Number(product.pQuantity) < quantitiesByProduct.get(String(product._id))) {
      throw httpError(409, "OUT_OF_STOCK", "Cart quantity exceeds shared product stock");
    }
    const options = validateProductOptions({
      product,
      selectedColor: cartItem.selectedColor,
      selectedSize: cartItem.selectedSize,
    });
    const unitPriceCents = getEffectiveProductPriceCents(product);
    const lineTotalCents = unitPriceCents * cartItem.quantity;
    subtotalCents += lineTotalCents;
    itemCount += cartItem.quantity;
    items.push({
      product,
      productId: product._id,
      name: product.pName,
      image: Array.isArray(product.pImages) ? product.pImages[0] : null,
      merchantName: product.pMerchantName || null,
      unitPriceCents,
      lineTotalCents,
      unitPrice: fromCents(unitPriceCents),
      lineTotal: fromCents(lineTotalCents),
      quantity: cartItem.quantity,
      selectedColor: options.selectedColor,
      selectedSize: options.selectedSize,
      available: true,
      stock: Number(product.pQuantity) || 0,
    });
  }
  return { cart: null, items, subtotalCents, itemCount };
}

async function firstOrderEligible(customerId, excludeOrderId) {
  const filter = {
    user: customerId,
    $or: [
      { orderStatus: { $in: QUALIFYING_FIRST_ORDER_STATUSES } },
      { status: { $in: QUALIFYING_FIRST_ORDER_STATUSES } },
    ],
  };
  if (excludeOrderId) {
    filter._id = { $ne: excludeOrderId };
  }
  const count = await orderModel.countDocuments(filter);
  return count === 0;
}

function calculateDiscountCents(couponOrPromo, subtotalCents) {
  if (!couponOrPromo) return 0;
  if (couponOrPromo.type === "fixed") {
    return Math.min(toCents(couponOrPromo.value), subtotalCents);
  }
  const percent = Number(couponOrPromo.value);
  const raw = Math.round((subtotalCents * percent) / 100);
  const max = couponOrPromo.maxDiscount || couponOrPromo.automaticFirstOrderMaxDiscount;
  return Math.min(raw, max ? toCents(max) : raw, subtotalCents);
}

async function resolveCouponDiscount({ customerId, customerType = "registered", code, subtotalCents, now, isFirstOrder }) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const coupon = await couponModel.findOne({ code: normalized }).select("+customerUsage");
  if (!coupon) throw httpError(404, "COUPON_NOT_FOUND", "Coupon was not found");
  if (!coupon.active) throw httpError(409, "COUPON_INACTIVE", "Coupon is inactive");
  if (coupon.startsAt && now < coupon.startsAt) throw httpError(409, "COUPON_NOT_STARTED", "Coupon has not started");
  if (coupon.expiresAt && now >= coupon.expiresAt) throw httpError(409, "COUPON_EXPIRED", "Coupon has expired");
  if (toCents(coupon.minimumSubtotal || 0) > subtotalCents) {
    throw httpError(409, "COUPON_MINIMUM_NOT_MET", "Minimum order subtotal was not met");
  }
  if (coupon.globalUsageLimit && Number(coupon.usageCount || 0) >= Number(coupon.globalUsageLimit)) {
    throw httpError(409, "COUPON_GLOBAL_LIMIT_REACHED", "Coupon usage limit has been reached");
  }
  if (customerType === "guest" && coupon.perCustomerUsageLimit) {
    throw httpError(409, "COUPON_ACCOUNT_REQUIRED", "This coupon requires an account");
  }
  if (customerType === "guest" && coupon.firstOrderOnly) {
    throw httpError(409, "COUPON_ACCOUNT_REQUIRED", "This coupon requires an account");
  }
  const customerKey = customerId ? String(customerId) : "";
  const customerUsage = customerKey && coupon.customerUsage ? Number(coupon.customerUsage.get(customerKey) || 0) : 0;
  if (customerId && coupon.perCustomerUsageLimit && customerUsage >= Number(coupon.perCustomerUsageLimit)) {
    throw httpError(409, "COUPON_CUSTOMER_LIMIT_REACHED", "Coupon customer usage limit has been reached");
  }
  if (coupon.firstOrderOnly && !isFirstOrder) {
    throw httpError(409, "COUPON_FIRST_ORDER_ONLY", "Coupon is only available on first orders");
  }
  const discountCents = calculateDiscountCents(coupon, subtotalCents);
  if (discountCents <= 0) throw httpError(409, "COUPON_NOT_APPLICABLE", "Coupon is not applicable");
  return {
    source: "coupon",
    coupon,
    discountCents,
    snapshot: {
      couponId: String(coupon._id),
      code: coupon.code,
      type: coupon.type,
      value: money(coupon.value),
      calculatedDiscount: fromCents(discountCents),
    },
  };
}

function resolveFirstOrderPromotion({ settings, subtotalCents, isFirstOrder }) {
  if (!isFirstOrder || !settings.automaticFirstOrderDiscountEnabled) return null;
  const value = Number(settings.automaticFirstOrderDiscountValue || 0);
  if (value <= 0) return null;
  const promo = {
    type: settings.automaticFirstOrderDiscountType || "percentage",
    value,
    maxDiscount: settings.automaticFirstOrderMaxDiscount,
  };
  const discountCents = calculateDiscountCents(promo, subtotalCents);
  if (discountCents <= 0) return null;
  return {
    source: "first_order",
    discountCents,
    snapshot: {
      type: promo.type,
      value: money(value),
      calculatedDiscount: fromCents(discountCents),
    },
  };
}

async function resolveShipping({ settings, address, subtotalCents, totalQuantity }) {
  const governorate = normalizePlace(address.governorate || address.city);
  const city = normalizePlace(address.city || address.area);
  if (!governorate) {
    throw httpError(409, "SHIPPING_UNAVAILABLE", "Shipping address governorate is required");
  }
  const activeRules = await shippingRuleModel.find({ active: true }).sort({ priority: -1, createdAt: -1 });
  const exact = activeRules.find(
    (rule) => normalizePlace(rule.governorate) === governorate && normalizePlace(rule.city) === city && city
  );
  const governorateRule = activeRules.find(
    (rule) => normalizePlace(rule.governorate) === governorate && !normalizePlace(rule.city)
  );
  const defaultRule = activeRules.find((rule) => !normalizePlace(rule.governorate) && !normalizePlace(rule.city));
  const rule = exact || governorateRule || defaultRule;
  const originalFeeCents = rule ? toCents(rule.fee) : toCents(settings.defaultShippingFee || 0);
  const threshold = rule ? rule.freeShippingThreshold : settings.defaultFreeShippingThreshold;
  const thresholdCents = threshold === null || threshold === undefined ? 0 : toCents(threshold);
  const freeShippingApplied = thresholdCents > 0 && subtotalCents >= thresholdCents;
  const chargedFeeCents = freeShippingApplied ? 0 : originalFeeCents;
  const quantityPromotion = calculateQuantityShippingDiscountCents({
    totalQuantity,
    baseShippingCents: chargedFeeCents,
  });
  const finalFeeCents = quantityPromotion.finalShippingCents;
  if (!rule && originalFeeCents === 0 && !settings) {
    throw httpError(409, "SHIPPING_UNAVAILABLE", "Shipping is unavailable for this address");
  }
  return {
    rule,
    originalFeeCents,
    chargedFeeCents,
    finalFeeCents,
    quantityPromotion,
    freeShippingApplied,
    snapshot: {
      ruleId: rule ? String(rule._id) : null,
      name: rule ? rule.name : "Default shipping",
      governorate: address.governorate || "",
      city: address.city || "",
      originalFee: fromCents(originalFeeCents),
      baseFee: fromCents(chargedFeeCents),
      quantityDiscountPercent: quantityPromotion.discountPercent,
      quantityDiscountAmount: fromCents(quantityPromotion.discountAmountCents),
      chargedFee: fromCents(finalFeeCents),
      finalFee: fromCents(finalFeeCents),
      freeShippingApplied: freeShippingApplied || (chargedFeeCents > 0 && finalFeeCents === 0),
      thresholdFreeShippingApplied: freeShippingApplied,
      quantityPromotionApplied: quantityPromotion.discountAmountCents > 0,
      totalQuantity: quantityPromotion.totalQuantity,
      nextQuantityThreshold: quantityPromotion.nextThreshold,
      quantityNeededForNextThreshold: quantityPromotion.quantityNeededForNextThreshold,
    },
  };
}

async function calculateCheckoutPricing({ customerId, shippingAddress, savedAddressId, couponCode, now = new Date() }) {
  if (!isValidObjectId(customerId)) {
    throw httpError(401, "AUTH_REQUIRED", "Authentication is required");
  }
  const [settings, cartData] = await Promise.all([
    getCommerceSettings(),
    buildServerCart(customerId),
  ]);
  const address = await resolveShippingAddress(customerId, { shippingAddress, savedAddressId });
  const isFirstOrder = await firstOrderEligible(customerId);
  const couponDiscount = await resolveCouponDiscount({
    customerId,
    customerType: "registered",
    code: couponCode,
    subtotalCents: cartData.subtotalCents,
    now,
    isFirstOrder,
  });
  const firstOrderDiscount = couponDiscount
    ? null
    : resolveFirstOrderPromotion({ settings, subtotalCents: cartData.subtotalCents, isFirstOrder });
  const discount = couponDiscount || firstOrderDiscount || { source: "none", discountCents: 0 };
  const shipping = await resolveShipping({ settings, address, subtotalCents: cartData.subtotalCents, totalQuantity: cartData.itemCount });
  const summary = serializeMoneySummary({
    itemCount: cartData.itemCount,
    merchandiseSubtotalCents: cartData.subtotalCents,
    discountCents: discount.discountCents,
    shippingCents: shipping.finalFeeCents,
    currency: settings.currency || config.storeCurrency,
  });
  return {
    cart: cartData.cart,
    items: cartData.items,
    shippingAddress: address,
    firstOrderEligible: isFirstOrder,
    discount: {
      source: discount.source,
      amount: fromCents(discount.discountCents),
      coupon: couponDiscount ? couponDiscount.snapshot : null,
      firstOrderPromotion: firstOrderDiscount ? firstOrderDiscount.snapshot : null,
    },
    shipping: {
      fee: fromCents(shipping.finalFeeCents),
      originalFee: fromCents(shipping.originalFeeCents),
      baseCost: fromCents(shipping.chargedFeeCents),
      discountPercent: shipping.quantityPromotion.discountPercent,
      discountAmount: fromCents(shipping.quantityPromotion.discountAmountCents),
      finalCost: fromCents(shipping.finalFeeCents),
      freeShippingApplied: shipping.freeShippingApplied || (shipping.chargedFeeCents > 0 && shipping.finalFeeCents === 0),
      thresholdFreeShippingApplied: shipping.freeShippingApplied,
      ruleId: shipping.rule ? String(shipping.rule._id) : null,
      name: shipping.snapshot.name,
    },
    shippingPromotion: {
      type: "quantity",
      totalQuantity: shipping.quantityPromotion.totalQuantity,
      discountPercent: shipping.quantityPromotion.discountPercent,
      discountAmount: fromCents(shipping.quantityPromotion.discountAmountCents),
      nextThreshold: shipping.quantityPromotion.nextThreshold,
      quantityNeededForNextThreshold: shipping.quantityPromotion.quantityNeededForNextThreshold,
    },
    summary,
    pricingSnapshot: {
      currency: summary.currency,
      totalQuantity: summary.totalQuantity,
      merchandiseSubtotal: summary.merchandiseSubtotal,
      discountTotal: summary.discountTotal,
      shippingFee: summary.shippingFee,
      grandTotal: summary.grandTotal,
      discountSource: discount.source,
      couponSnapshot: couponDiscount ? couponDiscount.snapshot : null,
      firstOrderPromotionSnapshot: firstOrderDiscount ? firstOrderDiscount.snapshot : null,
      shippingSnapshot: shipping.snapshot,
      pricingVersion: "2Q",
    },
    coupon: couponDiscount ? couponDiscount.coupon : null,
  };
}

async function calculateGuestCheckoutPricing({ cartItems, shippingAddress, couponCode, now = new Date() }) {
  const [settings, cartData] = await Promise.all([
    getCommerceSettings(),
    buildGuestCart(cartItems),
  ]);
  const address = await resolveShippingAddress(null, { shippingAddress });
  const couponDiscount = await resolveCouponDiscount({
    customerId: null,
    customerType: "guest",
    code: couponCode,
    subtotalCents: cartData.subtotalCents,
    now,
    isFirstOrder: false,
  });
  const discount = couponDiscount || { source: "none", discountCents: 0 };
  const shipping = await resolveShipping({ settings, address, subtotalCents: cartData.subtotalCents, totalQuantity: cartData.itemCount });
  const summary = serializeMoneySummary({
    itemCount: cartData.itemCount,
    merchandiseSubtotalCents: cartData.subtotalCents,
    discountCents: discount.discountCents,
    shippingCents: shipping.finalFeeCents,
    currency: settings.currency || config.storeCurrency,
  });
  return {
    cart: null,
    items: cartData.items,
    shippingAddress: address,
    firstOrderEligible: false,
    discount: {
      source: discount.source,
      amount: fromCents(discount.discountCents),
      coupon: couponDiscount ? couponDiscount.snapshot : null,
      firstOrderPromotion: null,
    },
    shipping: {
      fee: fromCents(shipping.finalFeeCents),
      originalFee: fromCents(shipping.originalFeeCents),
      baseCost: fromCents(shipping.chargedFeeCents),
      discountPercent: shipping.quantityPromotion.discountPercent,
      discountAmount: fromCents(shipping.quantityPromotion.discountAmountCents),
      finalCost: fromCents(shipping.finalFeeCents),
      freeShippingApplied: shipping.freeShippingApplied || (shipping.chargedFeeCents > 0 && shipping.finalFeeCents === 0),
      thresholdFreeShippingApplied: shipping.freeShippingApplied,
      ruleId: shipping.rule ? String(shipping.rule._id) : null,
      name: shipping.snapshot.name,
    },
    shippingPromotion: {
      type: "quantity",
      totalQuantity: shipping.quantityPromotion.totalQuantity,
      discountPercent: shipping.quantityPromotion.discountPercent,
      discountAmount: fromCents(shipping.quantityPromotion.discountAmountCents),
      nextThreshold: shipping.quantityPromotion.nextThreshold,
      quantityNeededForNextThreshold: shipping.quantityPromotion.quantityNeededForNextThreshold,
    },
    summary,
    pricingSnapshot: {
      currency: summary.currency,
      totalQuantity: summary.totalQuantity,
      merchandiseSubtotal: summary.merchandiseSubtotal,
      discountTotal: summary.discountTotal,
      shippingFee: summary.shippingFee,
      grandTotal: summary.grandTotal,
      discountSource: discount.source,
      couponSnapshot: couponDiscount ? couponDiscount.snapshot : null,
      firstOrderPromotionSnapshot: null,
      shippingSnapshot: shipping.snapshot,
      pricingVersion: "2Q",
    },
    coupon: couponDiscount ? couponDiscount.coupon : null,
  };
}

async function reserveCouponUsage({ coupon, customerId, orderId, amount }) {
  if (!coupon) return null;
  const customerKey = customerId ? String(customerId) : "";
  const filter = {
    _id: coupon._id,
    active: true,
  };
  if (coupon.globalUsageLimit) {
    filter.usageCount = { $lt: Number(coupon.globalUsageLimit) };
  }
  if (customerId && coupon.perCustomerUsageLimit) {
    filter.$or = [
      { [`customerUsage.${customerKey}`]: { $exists: false } },
      { [`customerUsage.${customerKey}`]: { $lt: Number(coupon.perCustomerUsageLimit) } },
    ];
  }
  const update = {
    $inc: {
      usageCount: 1,
    },
  };
  if (customerId) {
    update.$inc[`customerUsage.${customerKey}`] = 1;
  }
  const reserved = await couponModel.findOneAndUpdate(filter, update, { new: true });
  if (!reserved) {
    throw httpError(409, "COUPON_LIMIT_REACHED", "Coupon usage limit has been reached");
  }
  try {
    return await couponRedemptionModel.create({
      coupon: coupon._id,
      customer: customerId || null,
      order: orderId,
      status: "applied",
      amount,
    });
  } catch (err) {
    await releaseCouponUsage({ couponId: coupon._id, customerId, orderId });
    if (err && err.code === 11000) {
      throw httpError(409, "DUPLICATE_COUPON_REDEMPTION", "Coupon was already applied to this order");
    }
    throw err;
  }
}

async function releaseCouponUsage({ couponId, customerId, orderId }) {
  if (!couponId || !orderId) return false;
  const filter = { coupon: couponId, order: orderId, status: "applied" };
  if (customerId) filter.customer = customerId;
  const redemption = await couponRedemptionModel.findOneAndUpdate(
    filter,
    { status: "released", releasedAt: new Date() },
    { new: true }
  );
  if (!redemption) return false;
  const redeemedCustomerId = redemption.customer || customerId;
  const inc = { usageCount: -1 };
  if (redeemedCustomerId) {
    inc[`customerUsage.${String(redeemedCustomerId)}`] = -1;
  }
  await couponModel.updateOne(
    { _id: couponId },
    {
      $inc: inc,
    }
  );
  return true;
}

module.exports = {
  QUALIFYING_FIRST_ORDER_STATUSES,
  toCents,
  fromCents,
  money,
  getEffectiveProductPrice,
  getEffectiveProductPriceCents,
  calculateQuantityShippingDiscount,
  calculateQuantityShippingDiscountCents,
  calculateQuantityShippingPromotionMetadata,
  calculateShippingCents,
  moneySummary,
  calculateCheckoutPricing,
  calculateGuestCheckoutPricing,
  firstOrderEligible,
  normalizeCode,
  releaseCouponUsage,
  reserveCouponUsage,
};
