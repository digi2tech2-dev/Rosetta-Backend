const crypto = require("crypto");
const mongoose = require("mongoose");
const bundleOfferModel = require("../models/bundleOffers");
const productModel = require("../models/products");
const { serializeProduct } = require("./productSerializer");
const { validateProductOptions } = require("./productOptionService");
const { isValidObjectId } = require("../utils/validation");

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function toCents(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw httpError(409, "INVALID_PRODUCT_PRICE", "Invalid product price");
  }
  return Math.round(amount * 100);
}

function fromCents(cents) {
  return Number((cents / 100).toFixed(2));
}

function normalizeId(value, field) {
  const id = String(value || "").trim();
  if (!isValidObjectId(id)) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a valid id`);
  }
  return id;
}

function normalizeQuantity(value) {
  const quantity = Number(value || 1);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw httpError(400, "VALIDATION_ERROR", "Bundle quantity must be a positive whole number");
  }
  return quantity;
}

function optionList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function activeProduct(product) {
  return product && String(product.pStatus || "").toLowerCase() === "active";
}

function assertActiveProduct(product, code = "BUNDLE_PRODUCT_INACTIVE") {
  if (!activeProduct(product)) {
    throw httpError(409, code, "Bundle products must be active");
  }
}

function assertInStock(product) {
  if ((Number(product && product.pQuantity) || 0) < 1) {
    throw httpError(409, "BUNDLE_PRODUCT_OUT_OF_STOCK", "Bundle products must be in stock");
  }
}

function assertAdditionalOptionsSupported(product) {
  if (optionList(product && product.pColors).length > 1 || optionList(product && product.pSizes).length > 1) {
    throw httpError(
      409,
      "BUNDLE_ADDITIONAL_OPTIONS_UNSUPPORTED",
      "Additional bundle product cannot require multiple color or size choices"
    );
  }
}

function currentTotals(primaryProduct, additionalProduct, bundlePrice, options = {}) {
  const requireDiscount = options.requireDiscount !== false;
  const primaryCents = toCents(primaryProduct.pPrice);
  const additionalCents = toCents(additionalProduct.pPrice);
  const priceCents = toCents(bundlePrice);
  const regularTotalCents = primaryCents + additionalCents;
  if (priceCents <= 0 || (requireDiscount && priceCents >= regularTotalCents)) {
    throw httpError(409, "INVALID_BUNDLE_PRICE", "Bundle price must be lower than the current regular total");
  }
  const savingsCents = Math.max(0, regularTotalCents - priceCents);
  return {
    regularTotalCents,
    bundlePriceCents: priceCents,
    savingsCents,
    regularTotal: fromCents(regularTotalCents),
    bundlePrice: fromCents(priceCents),
    savings: fromCents(savingsCents),
    currentlyValid: priceCents > 0 && priceCents < regularTotalCents,
  };
}

async function loadProduct(productId, field) {
  const id = normalizeId(productId, field);
  const product = await productModel.findById(id);
  if (!product) {
    throw httpError(404, "INVALID_BUNDLE_PRODUCTS", "Bundle product was not found");
  }
  return product;
}

async function validateBundlePayload(payload, existing) {
  const source = payload || {};
  const primaryProductId = source.primaryProductId !== undefined
    ? source.primaryProductId
    : existing && existing.primaryProduct;
  const additionalProductId = source.additionalProductId !== undefined
    ? source.additionalProductId
    : existing && existing.additionalProduct;
  const bundlePrice = source.bundlePrice !== undefined
    ? source.bundlePrice
    : existing && existing.bundlePrice;

  const primaryProduct = await loadProduct(primaryProductId, "primaryProductId");
  const additionalProduct = await loadProduct(additionalProductId, "additionalProductId");

  if (String(primaryProduct._id) === String(additionalProduct._id)) {
    throw httpError(400, "INVALID_BUNDLE_PRODUCTS", "Bundle products must be different");
  }
  assertActiveProduct(primaryProduct);
  assertActiveProduct(additionalProduct);
  assertInStock(primaryProduct);
  assertInStock(additionalProduct);
  assertAdditionalOptionsSupported(additionalProduct);

  const totals = currentTotals(primaryProduct, additionalProduct, bundlePrice);
  return {
    primaryProduct,
    additionalProduct,
    bundlePrice: totals.bundlePrice,
    active: source.active === undefined ? Boolean(existing ? existing.active : true) : Boolean(source.active),
    totals,
  };
}

function serializeOffer(offer, options = {}) {
  const doc = offer && offer.toObject ? offer.toObject({ transform: false }) : offer;
  if (!doc) return null;
  const primaryProduct = doc.primaryProduct;
  const additionalProduct = doc.additionalProduct;
  const totals = currentTotals(primaryProduct, additionalProduct, doc.bundlePrice, {
    requireDiscount: !options.admin,
  });
  const primary = serializeProduct(primaryProduct, { admin: Boolean(options.admin) });
  const additional = serializeProduct(additionalProduct, { admin: Boolean(options.admin) });
  if (!primary || !additional) {
    throw httpError(409, "BUNDLE_PRODUCT_INACTIVE", "Bundle products must be active");
  }
  return {
    _id: String(doc._id),
    id: String(doc._id),
    primaryProductId: String(primaryProduct._id),
    additionalProductId: String(additionalProduct._id),
    primaryProduct: primary,
    additionalProduct: additional,
    bundlePrice: totals.bundlePrice,
    active: Boolean(doc.active),
    regularTotal: totals.regularTotal,
    savings: totals.savings,
    currentlyValid: totals.currentlyValid,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function createBundleOffer(payload, adminId) {
  const validated = await validateBundlePayload(payload);
  try {
    const offer = await bundleOfferModel.create({
      primaryProduct: validated.primaryProduct._id,
      additionalProduct: validated.additionalProduct._id,
      bundlePrice: validated.bundlePrice,
      active: validated.active,
      createdBy: adminId || null,
      updatedBy: adminId || null,
    });
    await offer.populate("primaryProduct additionalProduct").execPopulate();
    return serializeOffer(offer, { admin: true });
  } catch (err) {
    if (err && err.code === 11000) {
      throw httpError(409, "DUPLICATE_BUNDLE_PAIR", "A bundle offer already exists for this product pair");
    }
    throw err;
  }
}

async function updateBundleOffer(offerId, payload, adminId) {
  const id = normalizeId(offerId, "offerId");
  const existing = await bundleOfferModel.findById(id);
  if (!existing) throw httpError(404, "BUNDLE_NOT_FOUND", "Bundle offer was not found");
  const validated = await validateBundlePayload(payload, existing);
  existing.primaryProduct = validated.primaryProduct._id;
  existing.additionalProduct = validated.additionalProduct._id;
  existing.bundlePrice = validated.bundlePrice;
  existing.active = validated.active;
  existing.updatedBy = adminId || null;
  try {
    await existing.save();
  } catch (err) {
    if (err && err.code === 11000) {
      throw httpError(409, "DUPLICATE_BUNDLE_PAIR", "A bundle offer already exists for this product pair");
    }
    throw err;
  }
  await existing.populate("primaryProduct additionalProduct").execPopulate();
  return serializeOffer(existing, { admin: true });
}

async function deleteBundleOffer(offerId) {
  const id = normalizeId(offerId, "offerId");
  const offer = await bundleOfferModel
    .findByIdAndDelete(id)
    .populate("primaryProduct additionalProduct");
  if (!offer) throw httpError(404, "BUNDLE_NOT_FOUND", "Bundle offer was not found");
  return serializeOffer(offer, { admin: true });
}

async function listBundleOffers(query = {}) {
  const filter = {};
  if (query.active !== undefined && query.active !== "") {
    filter.active = query.active === true || query.active === "true" || query.active === "1";
  }
  const offers = await bundleOfferModel
    .find(filter)
    .populate("primaryProduct additionalProduct")
    .sort({ updatedAt: -1, _id: -1 });
  const search = String(query.search || "").trim().toLowerCase();
  return offers
    .map((offer) => {
      try {
        return serializeOffer(offer, { admin: true });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((offer) => !search || [
      offer.primaryProductId,
      offer.additionalProductId,
      offer.primaryProduct && offer.primaryProduct.pName,
      offer.additionalProduct && offer.additionalProduct.pName,
    ].some((value) => String(value || "").toLowerCase().includes(search)));
}

async function getPublicOfferByProduct(productId) {
  const id = normalizeId(productId, "productId");
  const offers = await bundleOfferModel
    .find({ primaryProduct: id, active: true })
    .populate("primaryProduct additionalProduct")
    .sort({ updatedAt: -1, _id: -1 });
  for (const offer of offers) {
    try {
      assertActiveProduct(offer.primaryProduct);
      assertActiveProduct(offer.additionalProduct);
      assertInStock(offer.primaryProduct);
      assertInStock(offer.additionalProduct);
      assertAdditionalOptionsSupported(offer.additionalProduct);
      return serializeOffer(offer, { admin: false });
    } catch {
      // Public lookup hides stale or currently invalid offers.
    }
  }
  return null;
}

async function loadActiveRuntimeOffer(offerId) {
  const id = normalizeId(offerId, "bundleOfferId");
  const offer = await bundleOfferModel
    .findById(id)
    .populate("primaryProduct additionalProduct");
  if (!offer || !offer.active) {
    throw httpError(409, "BUNDLE_UNAVAILABLE", "Bundle offer is unavailable");
  }
  assertActiveProduct(offer.primaryProduct, "BUNDLE_UNAVAILABLE");
  assertActiveProduct(offer.additionalProduct, "BUNDLE_UNAVAILABLE");
  assertAdditionalOptionsSupported(offer.additionalProduct);
  const totals = currentTotals(offer.primaryProduct, offer.additionalProduct, offer.bundlePrice);
  return { offer, totals };
}

function normalizeRole(value) {
  return ["primary", "additional"].includes(value) ? value : "";
}

function publicBundleGroupId() {
  return `bundle-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

async function validateBundleCartRequest({ bundleOfferId, quantity, selections = {} }) {
  const bundleQuantity = normalizeQuantity(quantity);
  const { offer, totals } = await loadActiveRuntimeOffer(bundleOfferId);
  const primaryOptions = validateProductOptions({
    product: offer.primaryProduct,
    selectedColor: selections.primary && (selections.primary.color ?? selections.primary.selectedColor),
    selectedSize: selections.primary && (selections.primary.size ?? selections.primary.selectedSize),
  });
  const additionalOptions = validateProductOptions({
    product: offer.additionalProduct,
    selectedColor: selections.additional && (selections.additional.color ?? selections.additional.selectedColor),
    selectedSize: selections.additional && (selections.additional.size ?? selections.additional.selectedSize),
  });
  return {
    offer,
    totals,
    quantity: bundleQuantity,
    members: [
      { role: "primary", product: offer.primaryProduct, options: primaryOptions },
      { role: "additional", product: offer.additionalProduct, options: additionalOptions },
    ],
  };
}

function itemBundleMeta(item) {
  const bundleOfferId = item.bundleOfferId || item.bundleOffer || null;
  const bundleGroupId = item.bundleGroupId || null;
  const bundleRole = normalizeRole(item.bundleRole);
  return {
    bundleOfferId: bundleOfferId ? String(bundleOfferId) : null,
    bundleGroupId: bundleGroupId ? String(bundleGroupId) : null,
    bundleRole: bundleRole || null,
  };
}

async function calculateBundlePricingForItems(items) {
  const groups = new Map();
  for (const item of items || []) {
    const meta = itemBundleMeta(item);
    if (!meta.bundleOfferId && !meta.bundleGroupId && !meta.bundleRole) continue;
    if (!meta.bundleOfferId || !meta.bundleGroupId || !meta.bundleRole) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle cart group is incomplete");
    }
    const group = groups.get(meta.bundleGroupId) || [];
    group.push({ ...item, ...meta });
    groups.set(meta.bundleGroupId, group);
  }

  let bundleDiscountTotalCents = 0;
  const bundleSnapshots = [];
  for (const [bundleGroupId, groupItems] of groups) {
    if (groupItems.length !== 2) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle cart group must contain exactly two members");
    }
    const offerIds = new Set(groupItems.map((item) => item.bundleOfferId));
    if (offerIds.size !== 1) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle cart group has inconsistent offers");
    }
    const primary = groupItems.find((item) => item.bundleRole === "primary");
    const additional = groupItems.find((item) => item.bundleRole === "additional");
    if (!primary || !additional) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle cart group must contain primary and additional members");
    }
    if (Number(primary.quantity) !== Number(additional.quantity)) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle member quantities must match");
    }
    const { offer, totals } = await loadActiveRuntimeOffer(primary.bundleOfferId);
    if (
      String(primary.productId) !== String(offer.primaryProduct._id) ||
      String(additional.productId) !== String(offer.additionalProduct._id)
    ) {
      throw httpError(409, "INVALID_BUNDLE_GROUP", "Bundle cart group products do not match the offer");
    }
    const quantity = Number(primary.quantity) || 0;
    const regularSubtotalCents = totals.regularTotalCents * quantity;
    const bundleSubtotalCents = totals.bundlePriceCents * quantity;
    const bundleDiscountCents = regularSubtotalCents - bundleSubtotalCents;
    if (bundleDiscountCents <= 0) {
      throw httpError(409, "BUNDLE_UNAVAILABLE", "Bundle offer is unavailable");
    }
    bundleDiscountTotalCents += bundleDiscountCents;
    bundleSnapshots.push({
      bundleOfferId: String(offer._id),
      bundleGroupId,
      primaryProductId: String(offer.primaryProduct._id),
      additionalProductId: String(offer.additionalProduct._id),
      quantity,
      regularSubtotal: fromCents(regularSubtotalCents),
      bundleSubtotal: fromCents(bundleSubtotalCents),
      bundleDiscount: fromCents(bundleDiscountCents),
      bundlePrice: totals.bundlePrice,
      regularTotal: totals.regularTotal,
      memberProducts: [primary, additional].map((item) => ({
        productId: String(item.productId),
        name: item.name,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
        selectedColor: item.selectedColor || null,
        selectedSize: item.selectedSize || null,
        bundleRole: item.bundleRole,
      })),
    });
  }
  return {
    bundleDiscountTotalCents,
    bundleDiscountTotal: fromCents(bundleDiscountTotalCents),
    bundleSnapshots,
  };
}

module.exports = {
  calculateBundlePricingForItems,
  createBundleOffer,
  deleteBundleOffer,
  fromCents,
  getPublicOfferByProduct,
  itemBundleMeta,
  listBundleOffers,
  publicBundleGroupId,
  toCents,
  updateBundleOffer,
  validateBundleCartRequest,
};
