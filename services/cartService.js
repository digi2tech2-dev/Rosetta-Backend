const cartModel = require("../models/carts");
const productModel = require("../models/products");
const { config } = require("../config/appConfig");
const { isValidObjectId } = require("../utils/validation");
const {
  fromCents,
  getEffectiveProductPriceCents,
  moneySummary,
} = require("./pricingService");

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

  let subtotalCents = 0;
  let itemCount = 0;
  const items = (safeCart.items || []).map((item) => {
    const product = productMap.get(String(item.product));
    const quantity = Number(item.quantity) || 0;
    const available = Boolean(
      product && isProductActive(product) && quantity > 0 && product.pQuantity >= quantity
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
      stock: product ? Number(product.pQuantity) || 0 : 0,
      unitPrice: fromCents(unitPriceCents),
      lineTotal: fromCents(lineTotalCents),
      available,
      status: product ? product.pStatus : "Unavailable",
    };
  });

  return {
    id: safeCart._id ? String(safeCart._id) : null,
    items,
    summary: moneySummary(subtotalCents, itemCount),
  };
}

async function getCartForUser(userId) {
  const cart = await getOrCreateCart(userId);
  return normalizeCart(cart);
}

function upsertCartItem(cart, productId, quantity) {
  const existing = cart.items.find((item) => String(item.product) === String(productId));
  if (existing) {
    existing.quantity = quantity;
  } else {
    if (cart.items.length >= config.maxCartItems) {
      throw httpError(409, "CONFLICT", `Cart cannot contain more than ${config.maxCartItems} items`);
    }
    cart.items.push({ product: productId, quantity });
  }
}

async function addItem(userId, productId, quantityValue) {
  const quantity = validateQuantity(quantityValue);
  const product = await loadActiveProduct(productId);
  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((item) => String(item.product) === String(product._id));
  const nextQuantity = (existing ? Number(existing.quantity) : 0) + quantity;
  if (nextQuantity > config.maxItemQuantity || nextQuantity > product.pQuantity) {
    throw httpError(409, "CONFLICT", "Requested quantity exceeds available stock");
  }
  upsertCartItem(cart, product._id, nextQuantity);
  await cart.save();
  return normalizeCart(cart);
}

async function updateItem(userId, productId, quantityValue) {
  const quantity = validateQuantity(quantityValue);
  const product = await loadActiveProduct(productId);
  if (quantity > product.pQuantity) {
    throw httpError(409, "CONFLICT", "Requested quantity exceeds available stock");
  }
  const cart = await getOrCreateCart(userId);
  const existing = cart.items.find((item) => String(item.product) === String(product._id));
  if (!existing) {
    throw httpError(404, "NOT_FOUND", "Cart item not found");
  }
  existing.quantity = quantity;
  await cart.save();
  return normalizeCart(cart);
}

async function removeItem(userId, productId) {
  validateProductId(productId);
  const cart = await getOrCreateCart(userId);
  cart.items = cart.items.filter((item) => String(item.product) !== String(productId));
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
    merged.set(String(productId), (merged.get(String(productId)) || 0) + quantity);
  }

  const cart = await getOrCreateCart(userId);
  for (const [productId, requested] of merged.entries()) {
    const product = await productModel.findById(productId);
    if (!product || !isProductActive(product)) {
      warnings.push({ productId, code: "UNAVAILABLE" });
      continue;
    }
    const capped = Math.min(requested, config.maxItemQuantity, Number(product.pQuantity) || 0);
    if (capped < 1) {
      warnings.push({ productId, code: "OUT_OF_STOCK" });
      continue;
    }
    if (capped < requested) {
      warnings.push({ productId, code: "QUANTITY_REDUCED", quantity: capped });
    }
    const existing = cart.items.find((item) => String(item.product) === productId);
    const nextQuantity = Math.min(
      (existing ? Number(existing.quantity) : 0) + capped,
      config.maxItemQuantity,
      Number(product.pQuantity) || 0
    );
    upsertCartItem(cart, product._id, nextQuantity);
  }
  await cart.save();
  return { cart: await normalizeCart(cart), warnings };
}

module.exports = {
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
