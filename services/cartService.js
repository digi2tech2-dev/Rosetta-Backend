const cartModel = require("../models/carts");
const productModel = require("../models/products");
const { config } = require("../config/appConfig");
const { isValidObjectId } = require("../utils/validation");
const {
  calculateQuantityShippingPromotionMetadata,
  fromCents,
  getEffectiveProductPriceCents,
  moneySummary,
} = require("./pricingService");
const { optionIdentity, validateProductOptions } = require("./productOptionService");
const {
  calculateBundlePricingForItems,
  publicBundleGroupId,
  validateBundleCartRequest,
} = require("./bundleOfferService");

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function validateQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxItemQuantity) {
    throw httpError(
      400,
      "VALIDATION_ERROR",
      `Quantity must be a whole number from 1 to ${config.maxItemQuantity}`
    );
  }
  return quantity;
}

function validateProductId(productId) {
  if (!isValidObjectId(productId)) {
    throw httpError(400, "VALIDATION_ERROR", "productId must be a valid id");
  }
  return productId;
}

function isProductActive(product) {
  return product && String(product.pStatus || "").toLowerCase() === "active";
}

function cartBundleGroup(item) {
  return item.bundleGroupId ? String(item.bundleGroupId) : "";
}

async function loadActiveProduct(productId) {
  validateProductId(productId);
  const product = await productModel.findById(productId);
  if (!product || !isProductActive(product)) {
    throw httpError(404, "NOT_FOUND", "Product is unavailable");
  }
  return product;
}

async function getOrCreateCart(userId) {
  let cart = await cartModel.findOne({ user: userId });
  if (!cart) {
    cart = await cartModel.create({ user: userId, items: [] });
  }
  return cart;
}

async function normalizeCart(cart) {
  const safeCart = cart || { _id: null, items: [] };
  const ids = (safeCart.items || []).map((item) => item.product);
  const products = await productModel.find({ _id: { $in: ids } });
  const productMap = new Map(products.map((product) => [String(product._id), product]));
  const quantitiesByProduct = new Map();
  for (const item of safeCart.items || []) {
    const productId = String(item.product);
    quantitiesByProduct.set(productId, (quantitiesByProduct.get(productId) || 0) + (Number(item.quantity) || 0));
  }

  let subtotalCents = 0;
  let itemCount = 0;
  const items = (safeCart.items || []).map((item) => {
    const product = productMap.get(String(item.product));
    const quantity = Number(item.quantity) || 0;
    const productCartQuantity = quantitiesByProduct.get(String(item.product)) || quantity;
    const available = Boolean(
      product && isProductActive(product) && quantity > 0 && product.pQuantity >= productCartQuantity
    );
    let unitPriceCents = 0;
    if (product) {
      unitPriceCents = getEffectiveProductPriceCents(product);
    }
    const lineTotalCents = available ? unitPriceCents * quantity : 0;
    subtotalCents += lineTotalCents;
    itemCount += quantity;

    return {
      productId: product ? String(product._id) : String(item.product),
      name: product ? product.pName : "Unavailable product",
      image: product && Array.isArray(product.pImages) ? product.pImages[0] : null,
      quantity,
      selectedColor: item.selectedColor || null,
      selectedSize: item.selectedSize || null,
      bundleOfferId: item.bundleOffer ? String(item.bundleOffer) : null,
      bundleGroupId: item.bundleGroupId || null,
      bundleRole: item.bundleRole || null,
      stock: product ? Number(product.pQuantity) || 0 : 0,
      unitPrice: fromCents(unitPriceCents),
      lineTotal: fromCents(lineTotalCents),
      available,
      status: product ? product.pStatus : "Unavailable",
    };
  });

  let bundlePricing = { bundleDiscountTotal: 0, bundleSnapshots: [] };
  try {
    bundlePricing = await calculateBundlePricingForItems(items);
  } catch {
    bundlePricing = { bundleDiscountTotal: 0, bundleSnapshots: [] };
  }
  const discountedSubtotalCents = Math.max(0, subtotalCents - Math.round(bundlePricing.bundleDiscountTotal * 100));
  const summary = moneySummary(discountedSubtotalCents, itemCount);
  summary.normalSubtotal = fromCents(subtotalCents);
  summary.bundleDiscount = bundlePricing.bundleDiscountTotal;

  return {
    id: safeCart._id ? String(safeCart._id) : null,
    items,
    summary,
    shippingPromotion: calculateQuantityShippingPromotionMetadata(itemCount),
    bundleSnapshots: bundlePricing.bundleSnapshots,
  };
}

async function getCartForUser(userId) {
  const cart = await getOrCreateCart(userId);
  return normalizeCart(cart);
}

function sameCartLine(item, productId, selectedColor, selectedSize, bundleGroupId = null) {
  return (
    String(item.product) === String(productId) &&
    optionIdentity(item.selectedColor, item.selectedSize) === optionIdentity(selectedColor, selectedSize) &&
    cartBundleGroup(item) === String(bundleGroupId || "")
  );
}

function productQuantityInCart(cart, productId, exceptItem) {
  return (cart.items || []).reduce((sum, item) => {
    if (item === exceptItem || String(item.product) !== String(productId)) return sum;
    return sum + (Number(item.quantity) || 0);
  }, 0);
}

function upsertCartItem(cart, productId, quantity, options = {}) {
  const selectedColor = options.selectedColor || null;
  const selectedSize = options.selectedSize || null;
  const bundleGroupId = options.bundleGroupId || null;
  const existing = cart.items.find((item) => sameCartLine(item, productId, selectedColor, selectedSize, bundleGroupId));
  if (existing) {
    existing.quantity = quantity;
    if (options.bundleOffer !== undefined) existing.bundleOffer = options.bundleOffer;
    if (options.bundleGroupId !== undefined) existing.bundleGroupId = options.bundleGroupId;
    if (options.bundleRole !== undefined) existing.bundleRole = options.bundleRole;
  } else {
    if (cart.items.length >= config.maxCartItems) {
      throw httpError(409, "CONFLICT", `Cart cannot contain more than ${config.maxCartItems} items`);
    }
    cart.items.push({
      product: productId,
      quantity,
      selectedColor,
      selectedSize,
      bundleOffer: options.bundleOffer || null,
      bundleGroupId,
      bundleRole: options.bundleRole || null,
    });
  }
}

async function addItem(userId, productId, quantityValue, optionValues = {}) {
  const quantity = validateQuantity(quantityValue);
  const product = await loadActiveProduct(productId);
  const options = validateProductOptions({
    product,
    selectedColor: optionValues.selectedColor,
    selectedSize: optionValues.selectedSize,
  });
  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((item) => sameCartLine(item, product._id, options.selectedColor, options.selectedSize));
  const nextQuantity = (existing ? Number(existing.quantity) : 0) + quantity;
  const nextProductTotal = productQuantityInCart(cart, product._id) + quantity;
  if (nextQuantity > config.maxItemQuantity || nextProductTotal > product.pQuantity) {
    throw httpError(409, "CONFLICT", "Requested quantity exceeds available stock");
  }
  upsertCartItem(cart, product._id, nextQuantity, options);
  await cart.save();
  return normalizeCart(cart);
}

async function updateItem(userId, productId, quantityValue, optionValues = {}) {
  const quantity = validateQuantity(quantityValue);
  const product = await loadActiveProduct(productId);
  const options = validateProductOptions({
    product,
    selectedColor: optionValues.selectedColor,
    selectedSize: optionValues.selectedSize,
  });
  const cart = await getOrCreateCart(userId);
  const bundleGroupId = optionValues.bundleGroupId || null;
  const existing = cart.items.find((item) => sameCartLine(item, product._id, options.selectedColor, options.selectedSize, bundleGroupId));
  if (!existing) {
    throw httpError(404, "NOT_FOUND", "Cart item not found");
  }
  if (existing.bundleGroupId) {
    const groupItems = cart.items.filter((item) => item.bundleGroupId === existing.bundleGroupId);
    const groupProducts = await productModel.find({ _id: { $in: groupItems.map((item) => item.product) } });
    const groupProductMap = new Map(groupProducts.map((groupProduct) => [String(groupProduct._id), groupProduct]));
    for (const groupItem of groupItems) {
      const groupProduct = groupProductMap.get(String(groupItem.product));
      if (!groupProduct || !isProductActive(groupProduct)) {
        throw httpError(409, "PRODUCT_UNAVAILABLE", "A bundle item is no longer available");
      }
      if (quantity + productQuantityInCart(cart, groupProduct._id, groupItem) > groupProduct.pQuantity) {
        throw httpError(409, "CONFLICT", "Requested quantity exceeds available stock");
      }
    }
    groupItems.forEach((item) => {
      item.quantity = quantity;
    });
  } else {
    if (quantity + productQuantityInCart(cart, product._id, existing) > product.pQuantity) {
      throw httpError(409, "CONFLICT", "Requested quantity exceeds available stock");
    }
    existing.quantity = quantity;
  }
  await cart.save();
  return normalizeCart(cart);
}

async function removeItem(userId, productId, optionValues = {}) {
  validateProductId(productId);
  const cart = await getOrCreateCart(userId);
  const bundleGroupId = optionValues.bundleGroupId || null;
  const hasOptions = optionValues.selectedColor !== undefined || optionValues.selectedSize !== undefined;
  const matchingItems = cart.items.filter((item) => String(item.product) === String(productId));
  if (!bundleGroupId && !hasOptions && matchingItems.length > 1) {
    throw httpError(409, "CART_ITEM_AMBIGUOUS", "Selected cart item options are required");
  }
  const removed = cart.items.find((item) => (
    String(item.product) === String(productId) &&
    (!bundleGroupId || item.bundleGroupId === bundleGroupId) &&
    (!hasOptions || optionIdentity(item.selectedColor, item.selectedSize) === optionIdentity(optionValues.selectedColor, optionValues.selectedSize))
  ));
  const removedGroupId = removed && removed.bundleGroupId ? removed.bundleGroupId : "";
  cart.items = cart.items.filter((item) => {
    if (String(item.product) !== String(productId)) return true;
    if (bundleGroupId && item.bundleGroupId !== bundleGroupId) return true;
    if (!hasOptions) return false;
    return optionIdentity(item.selectedColor, item.selectedSize) !== optionIdentity(optionValues.selectedColor, optionValues.selectedSize);
  });
  if (removedGroupId) {
    cart.items.forEach((item) => {
      if (item.bundleGroupId === removedGroupId) {
        item.bundleOffer = null;
        item.bundleGroupId = null;
        item.bundleRole = null;
      }
    });
  }
  await cart.save();
  return normalizeCart(cart);
}

async function addBundle(userId, payload = {}) {
  const validated = await validateBundleCartRequest({
    bundleOfferId: payload.bundleOfferId,
    quantity: payload.quantity,
    selections: payload.selections || {},
  });
  const cart = await getOrCreateCart(userId);
  const groupId = publicBundleGroupId();
  for (const member of validated.members) {
    const requestedTotal = productQuantityInCart(cart, member.product._id) + validated.quantity;
    if (requestedTotal > member.product.pQuantity) {
      throw httpError(409, "CONFLICT", "Requested bundle quantity exceeds available stock");
    }
  }
  for (const member of validated.members) {
    upsertCartItem(cart, member.product._id, validated.quantity, {
      selectedColor: member.options.selectedColor,
      selectedSize: member.options.selectedSize,
      bundleOffer: validated.offer._id,
      bundleGroupId: groupId,
      bundleRole: member.role,
    });
  }
  await cart.save();
  return normalizeCart(cart);
}

async function clearCart(userId) {
  const cart = await getOrCreateCart(userId);
  cart.items = [];
  await cart.save();
  return normalizeCart(cart);
}

async function syncGuestCart(userId, itemsValue) {
  if (!Array.isArray(itemsValue)) {
    throw httpError(400, "VALIDATION_ERROR", "items must be an array");
  }
  if (itemsValue.length > config.maxCartItems) {
    throw httpError(400, "VALIDATION_ERROR", `items cannot exceed ${config.maxCartItems}`);
  }

  const warnings = [];
  const merged = new Map();
  for (const raw of itemsValue) {
    const productId = raw && (raw.productId || raw.id);
    if (!isValidObjectId(productId)) {
      warnings.push({ productId: String(productId || ""), code: "INVALID_PRODUCT" });
      continue;
    }
    let quantity;
    try {
      quantity = validateQuantity(raw.quantity || raw.quantitiy || 1);
    } catch (err) {
      warnings.push({ productId: String(productId), code: "INVALID_QUANTITY" });
      continue;
    }
    const key = `${String(productId)}::${String(raw.selectedColor || "")}::${String(raw.selectedSize || "")}::${String(raw.bundleGroupId || "")}`.toLowerCase();
    const existing = merged.get(key) || {
      productId: String(productId),
      selectedColor: raw.selectedColor,
      selectedSize: raw.selectedSize,
      bundleOfferId: raw.bundleOfferId || raw.bundleOffer || null,
      bundleGroupId: raw.bundleGroupId || null,
      bundleRole: raw.bundleRole || null,
      quantity: 0,
    };
    existing.quantity += quantity;
    merged.set(key, existing);
  }

  const cart = await getOrCreateCart(userId);
  for (const mergedItem of merged.values()) {
    const product = await productModel.findById(mergedItem.productId);
    if (!product || !isProductActive(product)) {
      warnings.push({ productId: mergedItem.productId, code: "UNAVAILABLE" });
      continue;
    }
    let options;
    try {
      options = validateProductOptions({
        product,
        selectedColor: mergedItem.selectedColor,
        selectedSize: mergedItem.selectedSize,
      });
    } catch (err) {
      warnings.push({ productId: mergedItem.productId, code: err.code || "INVALID_PRODUCT_OPTION" });
      continue;
    }
    const requested = mergedItem.quantity;
    const capped = Math.min(requested, config.maxItemQuantity, Number(product.pQuantity) || 0);
    if (capped < 1) {
      warnings.push({ productId: mergedItem.productId, code: "OUT_OF_STOCK" });
      continue;
    }
    if (capped < requested) {
      warnings.push({ productId: mergedItem.productId, code: "QUANTITY_REDUCED", quantity: capped });
    }
    const existing = cart.items.find((item) => sameCartLine(item, product._id, options.selectedColor, options.selectedSize, mergedItem.bundleGroupId || null));
    const availableForLine = Math.max(0, (Number(product.pQuantity) || 0) - productQuantityInCart(cart, product._id, existing));
    if (availableForLine < 1) {
      warnings.push({ productId: mergedItem.productId, code: "OUT_OF_STOCK" });
      continue;
    }
    const nextQuantity = Math.min(
      (existing ? Number(existing.quantity) : 0) + capped,
      config.maxItemQuantity,
      availableForLine
    );
    if (nextQuantity < (existing ? Number(existing.quantity) : 0) + requested) {
      warnings.push({ productId: mergedItem.productId, code: "QUANTITY_REDUCED", quantity: nextQuantity });
    }
    upsertCartItem(cart, product._id, nextQuantity, {
      ...options,
      bundleOffer: mergedItem.bundleOfferId || null,
      bundleGroupId: mergedItem.bundleGroupId || null,
      bundleRole: mergedItem.bundleRole || null,
    });
  }
  await cart.save();
  return { cart: await normalizeCart(cart), warnings };
}

module.exports = {
  addBundle,
  addItem,
  clearCart,
  getCartForUser,
  isProductActive,
  normalizeCart,
  removeItem,
  syncGuestCart,
  updateItem,
  validateQuantity,
};
