const couponModel = require("../models/coupons");
const couponRedemptionModel = require("../models/couponRedemptions");
const shippingRuleModel = require("../models/shippingRules");
const commerceSettingsModel = require("../models/commerceSettings");
const {
  calculateCheckoutPricing,
  calculateGuestCheckoutPricing,
  calculateQuantityShippingPromotionMetadata,
  normalizeCode,
  money,
} = require("../services/pricingService");
const { normalizeGuestCartItems } = require("../services/guestCheckoutService");
const { isValidObjectId, pickAllowed } = require("../utils/validation");

function sendError(res, err) {
  return res.status(err.status || 500).json({
    success: false,
    code: err.code || "INTERNAL_ERROR",
    error: err.message || "Unable to process commerce request",
  });
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function page(query) {
  const current = Math.max(Number.parseInt(query.page || "1", 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit || "20", 10) || 20, 1), 100);
  return { page: current, limit, skip: (current - 1) * limit };
}

function nullableMoney(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be non-negative`);
  }
  return money(number);
}

function positiveMoney(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be greater than zero`);
  }
  return money(number);
}

function optionalPositiveInteger(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a positive whole number`);
  }
  return number;
}

function parseDate(value, field) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a valid date`);
  }
  return date;
}

function couponPayload(body, adminId, partial = false) {
  const allowed = pickAllowed(body || {}, [
    "code",
    "type",
    "value",
    "maxDiscount",
    "minimumSubtotal",
    "startsAt",
    "expiresAt",
    "active",
    "globalUsageLimit",
    "perCustomerUsageLimit",
    "firstOrderOnly",
  ]);
  const payload = {};
  if (allowed.code !== undefined) payload.code = normalizeCode(allowed.code);
  if (allowed.type !== undefined) {
    if (!["fixed", "percentage"].includes(allowed.type)) {
      throw httpError(400, "VALIDATION_ERROR", "Coupon type is invalid");
    }
    payload.type = allowed.type;
  }
  if (allowed.value !== undefined) {
    const type = payload.type || body.type;
    payload.value = positiveMoney(allowed.value, "value");
    if (type === "percentage" && payload.value > 100) {
      throw httpError(400, "VALIDATION_ERROR", "Percentage coupon value cannot exceed 100");
    }
  }
  if (allowed.maxDiscount !== undefined) payload.maxDiscount = nullableMoney(allowed.maxDiscount, "maxDiscount");
  if (allowed.minimumSubtotal !== undefined) payload.minimumSubtotal = nullableMoney(allowed.minimumSubtotal, "minimumSubtotal") || 0;
  if (allowed.startsAt !== undefined) payload.startsAt = parseDate(allowed.startsAt, "startsAt");
  if (allowed.expiresAt !== undefined) payload.expiresAt = parseDate(allowed.expiresAt, "expiresAt");
  if (allowed.active !== undefined) payload.active = Boolean(allowed.active);
  if (allowed.globalUsageLimit !== undefined) payload.globalUsageLimit = optionalPositiveInteger(allowed.globalUsageLimit, "globalUsageLimit");
  if (allowed.perCustomerUsageLimit !== undefined) payload.perCustomerUsageLimit = optionalPositiveInteger(allowed.perCustomerUsageLimit, "perCustomerUsageLimit");
  if (allowed.firstOrderOnly !== undefined) payload.firstOrderOnly = Boolean(allowed.firstOrderOnly);
  if (!partial) {
    for (const field of ["code", "type", "value"]) {
      if (payload[field] === undefined || payload[field] === "") {
        throw httpError(400, "VALIDATION_ERROR", `${field} is required`);
      }
    }
  }
  const startsAt = payload.startsAt !== undefined ? payload.startsAt : body.startsAt;
  const expiresAt = payload.expiresAt !== undefined ? payload.expiresAt : body.expiresAt;
  if (startsAt && expiresAt && new Date(expiresAt).getTime() <= new Date(startsAt).getTime()) {
    throw httpError(400, "VALIDATION_ERROR", "expiresAt must be after startsAt");
  }
  payload.updatedBy = adminId;
  if (!partial) payload.createdBy = adminId;
  return payload;
}

function serializeCoupon(coupon, admin = false) {
  const source = coupon && coupon.toObject ? coupon.toObject({ transform: false }) : coupon;
  if (!source) return null;
  const base = {
    _id: String(source._id),
    id: String(source._id),
    code: source.code,
    type: source.type,
    value: source.value,
    maxDiscount: source.maxDiscount ?? null,
    minimumSubtotal: source.minimumSubtotal || 0,
    startsAt: source.startsAt || null,
    expiresAt: source.expiresAt || null,
    active: Boolean(source.active),
    firstOrderOnly: Boolean(source.firstOrderOnly),
  };
  if (admin) {
    return {
      ...base,
      globalUsageLimit: source.globalUsageLimit ?? null,
      perCustomerUsageLimit: source.perCustomerUsageLimit ?? null,
      usageCount: source.usageCount || 0,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }
  return base;
}

function shippingPayload(body, adminId, partial = false) {
  const allowed = pickAllowed(body || {}, [
    "name",
    "governorate",
    "city",
    "fee",
    "freeShippingThreshold",
    "active",
    "priority",
    "deliveryDuration",
  ]);
  const payload = {};
  if (allowed.name !== undefined) payload.name = String(allowed.name || "").trim();
  if (allowed.governorate !== undefined) payload.governorate = String(allowed.governorate || "").trim() || null;
  if (allowed.city !== undefined) payload.city = String(allowed.city || "").trim() || null;
  if (allowed.fee !== undefined) payload.fee = nullableMoney(allowed.fee, "fee");
  if (allowed.freeShippingThreshold !== undefined) {
    payload.freeShippingThreshold = nullableMoney(allowed.freeShippingThreshold, "freeShippingThreshold");
  }
  if (allowed.active !== undefined) payload.active = Boolean(allowed.active);
  if (allowed.priority !== undefined) payload.priority = Number.parseInt(allowed.priority, 10) || 0;
  if (allowed.deliveryDuration !== undefined) payload.deliveryDuration = String(allowed.deliveryDuration || "").trim().slice(0, 80);
  if (!partial) {
    if (!payload.name) throw httpError(400, "VALIDATION_ERROR", "name is required");
    if (payload.fee === undefined || payload.fee === null) throw httpError(400, "VALIDATION_ERROR", "fee is required");
  }
  payload.updatedBy = adminId;
  if (!partial) payload.createdBy = adminId;
  return payload;
}

function serializeShippingRule(rule) {
  const source = rule && rule.toObject ? rule.toObject({ transform: false }) : rule;
  return {
    _id: String(source._id),
    id: String(source._id),
    name: source.name,
    governorate: source.governorate || "",
    city: source.city || "",
    fee: source.fee,
    freeShippingThreshold: source.freeShippingThreshold ?? null,
    active: Boolean(source.active),
    priority: source.priority || 0,
    deliveryDuration: source.deliveryDuration || "",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

const SETTINGS_FIELDS = [
  "currency",
  "defaultShippingFee",
  "defaultFreeShippingThreshold",
  "automaticFirstOrderDiscountEnabled",
  "automaticFirstOrderDiscountType",
  "automaticFirstOrderDiscountValue",
  "automaticFirstOrderMaxDiscount",
  "deliveryDuration",
  "trackingUrl",
  "trackingPrefix",
  "priorityPackingEnabled",
  "priorityPackingMinimum",
  "giftWrapEnabled",
  "giftWrapMinimum",
];

function settingsPayload(body, adminId, currentSettings = {}) {
  const unknown = Object.keys(body || {}).filter((key) => !SETTINGS_FIELDS.includes(key));
  if (unknown.length) {
    throw httpError(400, "UNKNOWN_SETTING_KEY", `Unknown settings key: ${unknown[0]}`);
  }
  const picked = pickAllowed(body || {}, SETTINGS_FIELDS);
  const payload = {};
  if (picked.currency !== undefined) payload.currency = String(picked.currency || "EGP").trim().toUpperCase().slice(0, 8);
  for (const field of ["defaultShippingFee", "defaultFreeShippingThreshold", "automaticFirstOrderDiscountValue", "automaticFirstOrderMaxDiscount", "priorityPackingMinimum", "giftWrapMinimum"]) {
    if (picked[field] !== undefined) payload[field] = nullableMoney(picked[field], field);
  }
  if (picked.automaticFirstOrderDiscountType !== undefined) {
    if (!["fixed", "percentage"].includes(picked.automaticFirstOrderDiscountType)) {
      throw httpError(400, "VALIDATION_ERROR", "automaticFirstOrderDiscountType is invalid");
    }
    payload.automaticFirstOrderDiscountType = picked.automaticFirstOrderDiscountType;
  }
  for (const field of ["automaticFirstOrderDiscountEnabled", "priorityPackingEnabled", "giftWrapEnabled"]) {
    if (picked[field] !== undefined) payload[field] = Boolean(picked[field]);
  }
  for (const field of ["deliveryDuration", "trackingUrl", "trackingPrefix"]) {
    if (picked[field] !== undefined) payload[field] = String(picked[field] || "").trim().slice(0, field === "trackingUrl" ? 500 : 80);
  }
  const effectiveFirstOrderType =
    payload.automaticFirstOrderDiscountType ||
    currentSettings.automaticFirstOrderDiscountType ||
    "percentage";
  const effectiveFirstOrderValue =
    payload.automaticFirstOrderDiscountValue !== undefined
      ? payload.automaticFirstOrderDiscountValue
      : currentSettings.automaticFirstOrderDiscountValue;
  if (effectiveFirstOrderType === "percentage" && Number(effectiveFirstOrderValue || 0) > 100) {
    throw httpError(400, "VALIDATION_ERROR", "First order percentage cannot exceed 100");
  }
  payload.updatedBy = adminId;
  return payload;
}

function serializeSettings(settings) {
  const source = settings && settings.toObject ? settings.toObject({ transform: false }) : settings;
  return {
    currency: source.currency || "EGP",
    defaultShippingFee: source.defaultShippingFee || 0,
    defaultFreeShippingThreshold: source.defaultFreeShippingThreshold || 0,
    automaticFirstOrderDiscountEnabled: Boolean(source.automaticFirstOrderDiscountEnabled),
    automaticFirstOrderDiscountType: source.automaticFirstOrderDiscountType || "percentage",
    automaticFirstOrderDiscountValue: source.automaticFirstOrderDiscountValue || 0,
    automaticFirstOrderMaxDiscount: source.automaticFirstOrderMaxDiscount ?? null,
    deliveryDuration: source.deliveryDuration || "",
    trackingUrl: source.trackingUrl || "",
    trackingPrefix: source.trackingPrefix || "",
    priorityPackingEnabled: Boolean(source.priorityPackingEnabled),
    priorityPackingMinimum: source.priorityPackingMinimum || 0,
    giftWrapEnabled: Boolean(source.giftWrapEnabled),
    giftWrapMinimum: source.giftWrapMinimum || 0,
  };
}

class CommerceController {
  async shippingPromotion(req, res) {
    try {
      const cartItems = normalizeGuestCartItems(req.body.cartItems || []);
      const totalQuantity = cartItems.reduce((sum, item) => sum + item.quantity, 0);
      return res.json({
        success: true,
        shippingPromotion: calculateQuantityShippingPromotionMetadata(totalQuantity),
      });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async quote(req, res) {
    try {
      if (req.auth && Number(req.auth.role) !== 0) {
        throw httpError(403, "ACCESS_DENIED", "Access denied");
      }
      const quote = req.auth
        ? await calculateCheckoutPricing({
            customerId: req.auth.userId,
            shippingAddress: req.body.shippingAddress,
            savedAddressId: req.body.savedAddressId,
            couponCode: req.body.couponCode,
          })
        : await calculateGuestCheckoutPricing({
            cartItems: req.body.cartItems,
            shippingAddress: req.body.shippingAddress,
            couponCode: req.body.couponCode,
          });
      return res.json({
        success: true,
        quote: {
          items: quote.items.map((item) => ({
            productId: String(item.productId),
            name: item.name,
            image: item.image,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            lineTotal: item.lineTotal,
            selectedColor: item.selectedColor || null,
            selectedSize: item.selectedSize || null,
            available: item.available,
            stock: item.stock,
          })),
          summary: quote.summary,
          discount: quote.discount,
          shipping: quote.shipping,
          shippingPromotion: quote.shippingPromotion,
          firstOrderEligible: quote.firstOrderEligible,
        },
      });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async listCoupons(req, res) {
    try {
      const pagination = page(req.query);
      const filter = {};
      if (req.query.search) filter.code = new RegExp(escapeRegex(req.query.search), "i");
      if (req.query.status === "active") filter.active = true;
      if (req.query.status === "inactive") filter.active = false;
      const [coupons, total] = await Promise.all([
        couponModel.find(filter).sort({ createdAt: -1, _id: -1 }).skip(pagination.skip).limit(pagination.limit),
        couponModel.countDocuments(filter),
      ]);
      return res.json({ success: true, coupons: coupons.map((coupon) => serializeCoupon(coupon, true)), pagination: { page: pagination.page, limit: pagination.limit, total } });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async createCoupon(req, res) {
    try {
      const coupon = await couponModel.create(couponPayload(req.body, req.auth.userId));
      return res.status(201).json({ success: true, coupon: serializeCoupon(coupon, true) });
    } catch (err) {
      if (err && err.code === 11000) return sendError(res, httpError(409, "DUPLICATE_COUPON_CODE", "Coupon code already exists"));
      return sendError(res, err);
    }
  }

  async getCoupon(req, res) {
    try {
      if (!isValidObjectId(req.params.couponId)) throw httpError(400, "VALIDATION_ERROR", "couponId must be valid");
      const coupon = await couponModel.findById(req.params.couponId);
      if (!coupon) throw httpError(404, "COUPON_NOT_FOUND", "Coupon was not found");
      return res.json({ success: true, coupon: serializeCoupon(coupon, true) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateCoupon(req, res) {
    try {
      if (!isValidObjectId(req.params.couponId)) throw httpError(400, "VALIDATION_ERROR", "couponId must be valid");
      const current = await couponModel.findById(req.params.couponId);
      if (!current) throw httpError(404, "COUPON_NOT_FOUND", "Coupon was not found");
      const payload = couponPayload(req.body, req.auth.userId, true);
      const startsAt = payload.startsAt !== undefined ? payload.startsAt : current.startsAt;
      const expiresAt = payload.expiresAt !== undefined ? payload.expiresAt : current.expiresAt;
      if (startsAt && expiresAt && expiresAt.getTime() <= startsAt.getTime()) {
        throw httpError(400, "VALIDATION_ERROR", "expiresAt must be after startsAt");
      }
      Object.assign(current, payload);
      await current.save();
      return res.json({ success: true, coupon: serializeCoupon(current, true) });
    } catch (err) {
      if (err && err.code === 11000) return sendError(res, httpError(409, "DUPLICATE_COUPON_CODE", "Coupon code already exists"));
      return sendError(res, err);
    }
  }

  async updateCouponStatus(req, res) {
    try {
      if (!isValidObjectId(req.params.couponId)) throw httpError(400, "VALIDATION_ERROR", "couponId must be valid");
      const coupon = await couponModel.findByIdAndUpdate(req.params.couponId, { active: Boolean(req.body.active), updatedBy: req.auth.userId }, { new: true });
      if (!coupon) throw httpError(404, "COUPON_NOT_FOUND", "Coupon was not found");
      return res.json({ success: true, coupon: serializeCoupon(coupon, true) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async deleteCoupon(req, res) {
    try {
      if (!isValidObjectId(req.params.couponId)) throw httpError(400, "VALIDATION_ERROR", "couponId must be valid");
      const redemptions = await couponRedemptionModel.countDocuments({ coupon: req.params.couponId });
      const coupon = redemptions
        ? await couponModel.findByIdAndUpdate(req.params.couponId, { active: false, updatedBy: req.auth.userId }, { new: true })
        : await couponModel.findByIdAndDelete(req.params.couponId);
      if (!coupon) throw httpError(404, "COUPON_NOT_FOUND", "Coupon was not found");
      return res.json({ success: true, softDeleted: redemptions > 0, coupon: redemptions ? serializeCoupon(coupon, true) : null });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async listShippingRules(req, res) {
    try {
      const pagination = page(req.query);
      const filter = {};
      if (req.query.search) {
        const pattern = new RegExp(escapeRegex(req.query.search), "i");
        filter.$or = [{ name: pattern }, { governorate: pattern }, { city: pattern }];
      }
      if (req.query.status === "active") filter.active = true;
      if (req.query.status === "inactive") filter.active = false;
      const [rules, total] = await Promise.all([
        shippingRuleModel.find(filter).sort({ priority: -1, createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
        shippingRuleModel.countDocuments(filter),
      ]);
      return res.json({ success: true, rules: rules.map(serializeShippingRule), pagination: { page: pagination.page, limit: pagination.limit, total } });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async createShippingRule(req, res) {
    try {
      const rule = await shippingRuleModel.create(shippingPayload(req.body, req.auth.userId));
      return res.status(201).json({ success: true, rule: serializeShippingRule(rule) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async getShippingRule(req, res) {
    try {
      if (!isValidObjectId(req.params.ruleId)) throw httpError(400, "VALIDATION_ERROR", "ruleId must be valid");
      const rule = await shippingRuleModel.findById(req.params.ruleId);
      if (!rule) throw httpError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule was not found");
      return res.json({ success: true, rule: serializeShippingRule(rule) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateShippingRule(req, res) {
    try {
      if (!isValidObjectId(req.params.ruleId)) throw httpError(400, "VALIDATION_ERROR", "ruleId must be valid");
      const rule = await shippingRuleModel.findByIdAndUpdate(req.params.ruleId, shippingPayload(req.body, req.auth.userId, true), { new: true, runValidators: true });
      if (!rule) throw httpError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule was not found");
      return res.json({ success: true, rule: serializeShippingRule(rule) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateShippingRuleStatus(req, res) {
    try {
      if (!isValidObjectId(req.params.ruleId)) throw httpError(400, "VALIDATION_ERROR", "ruleId must be valid");
      const rule = await shippingRuleModel.findByIdAndUpdate(req.params.ruleId, { active: Boolean(req.body.active), updatedBy: req.auth.userId }, { new: true });
      if (!rule) throw httpError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule was not found");
      return res.json({ success: true, rule: serializeShippingRule(rule) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async deleteShippingRule(req, res) {
    try {
      if (!isValidObjectId(req.params.ruleId)) throw httpError(400, "VALIDATION_ERROR", "ruleId must be valid");
      const rule = await shippingRuleModel.findByIdAndDelete(req.params.ruleId);
      if (!rule) throw httpError(404, "SHIPPING_RULE_NOT_FOUND", "Shipping rule was not found");
      return res.json({ success: true });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async getSettings(req, res) {
    try {
      const settings = await commerceSettingsModel.findOneAndUpdate(
        { singletonKey: "commerce" },
        { $setOnInsert: { singletonKey: "commerce" } },
        { upsert: true, new: true }
      );
      return res.json({ success: true, settings: serializeSettings(settings) });
    } catch (err) {
      return sendError(res, err);
    }
  }

  async updateSettings(req, res) {
    try {
      const current = await commerceSettingsModel.findOne({ singletonKey: "commerce" });
      const settings = await commerceSettingsModel.findOneAndUpdate(
        { singletonKey: "commerce" },
        { $set: settingsPayload(req.body, req.auth.userId, current || {}), $setOnInsert: { singletonKey: "commerce" } },
        { upsert: true, new: true, runValidators: true }
      );
      return res.json({ success: true, settings: serializeSettings(settings) });
    } catch (err) {
      return sendError(res, err);
    }
  }
}

module.exports = {
  CommerceController,
  commerceController: new CommerceController(),
  serializeCoupon,
  serializeSettings,
  serializeShippingRule,
};
