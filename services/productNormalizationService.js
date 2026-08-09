const mongoose = require("mongoose");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");

const MAX_OPTION_COUNT = 30;
const MAX_OPTION_LENGTH = 80;
const MAX_RELATION_COUNT = 24;

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function rejectHtml(field, value) {
  if (/[<>]/.test(value)) {
    throw httpError(400, "VALIDATION_ERROR", `${field} cannot contain HTML`);
  }
}

function normalizeOptionalString(value, field, max = 255) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) {
    throw httpError(400, "VALIDATION_ERROR", `${field} is too long`);
  }
  rejectHtml(field, text);
  return text;
}

function normalizeMerchantName(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw httpError(400, "VALIDATION_ERROR", "pMerchantName must be plain text");
  }
  return normalizeOptionalString(value, "pMerchantName", 120);
}

function normalizeOptionalMoney(value, field = "pCost") {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a finite non-negative number`);
  }
  return Number(amount.toFixed(2));
}

function normalizeOptionalPositiveInteger(value, field) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a positive whole number`);
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be a positive whole number`);
  }
  return number;
}

function normalizeBarcode(value) {
  const barcode = normalizeOptionalString(value, "pBarcode", 80);
  return barcode || null;
}

function parseListInput(value, field) {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [value];

  const text = value.trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw httpError(400, "VALIDATION_ERROR", `${field} must be an array`);
      }
      return parsed;
    } catch (err) {
      if (err.code) throw err;
      throw httpError(400, "VALIDATION_ERROR", `${field} contains malformed JSON`);
    }
  }
  return text.split(",");
}

function normalizeStringArray(value, field) {
  const seen = new Set();
  const items = [];
  for (const raw of parseListInput(value, field)) {
    const text = String(raw || "").trim();
    if (!text) continue;
    if (text.length > MAX_OPTION_LENGTH) {
      throw httpError(400, "TOO_MANY_OPTIONS", `${field} values are too long`);
    }
    rejectHtml(field, text);
    const key = text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      items.push(text);
    }
  }
  if (items.length > MAX_OPTION_COUNT) {
    throw httpError(400, "TOO_MANY_OPTIONS", `${field} cannot exceed ${MAX_OPTION_COUNT} values`);
  }
  return items;
}

function normalizeObjectIdArray(value, field, currentProductId) {
  const seen = new Set();
  const ids = [];
  for (const raw of parseListInput(value, field)) {
    const id = typeof raw === "object" && raw ? raw._id || raw.id || raw.value : raw;
    if (!id) continue;
    if (!isValidObjectId(id)) {
      throw httpError(400, "INVALID_RELATED_PRODUCT", `${field} contains an invalid product id`);
    }
    const normalized = String(id);
    if (currentProductId && normalized === String(currentProductId)) {
      throw httpError(400, "INVALID_RELATED_PRODUCT", `${field} cannot include the current product`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(mongoose.Types.ObjectId(normalized));
    }
  }
  if (ids.length > MAX_RELATION_COUNT) {
    throw httpError(400, "INVALID_RELATED_PRODUCT", `${field} cannot exceed ${MAX_RELATION_COUNT} products`);
  }
  return ids;
}

function normalizeVideoUrl(value) {
  const url = normalizeOptionalString(value, "pVideo", 500);
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw httpError(400, "INVALID_VIDEO_URL", "pVideo must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw httpError(400, "INVALID_VIDEO_URL", "pVideo must use http or https");
  }
  return url;
}

function parseObjectInput(value, field) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw httpError(400, "INVALID_COLOR_IMAGE", `${field} must be an object`);
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(400, "INVALID_COLOR_IMAGE", `${field} must be an object`);
    }
    return parsed;
  } catch (err) {
    if (err.code) throw err;
    throw httpError(400, "INVALID_COLOR_IMAGE", `${field} contains malformed JSON`);
  }
}

function normalizeImageReference(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (text.includes("\0") || /^[A-Za-z]:[\\/]/.test(text) || text.includes("..")) {
    throw httpError(400, "INVALID_COLOR_IMAGE", "Color image reference is unsafe");
  }
  if (/^https?:\/\//i.test(text)) return text;
  const cleaned = text.replace(/\\/g, "/");
  return path.basename(cleaned);
}

function normalizeColorImageMap(value, colors, files = [], mainImageCount = 0) {
  const rawMap = parseObjectInput(value, "pColorImages");
  const allowedColors = new Map(colors.map((color) => [color.toLowerCase(), color]));
  const output = {};
  for (const [rawColor, rawValue] of Object.entries(rawMap)) {
    const color = allowedColors.get(String(rawColor).trim().toLowerCase());
    if (!color) {
      throw httpError(400, "INVALID_COLOR_IMAGE", "Color image references must match defined colors");
    }

    if (typeof rawValue === "string") {
      const fileName = normalizeImageReference(rawValue);
      if (fileName) output[color] = { fileName };
      continue;
    }

    if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
      throw httpError(400, "INVALID_COLOR_IMAGE", "Color image values must be objects or strings");
    }

    const next = {};
    if (rawValue.fileName) next.fileName = normalizeImageReference(rawValue.fileName);
    if (rawValue.image) next.fileName = normalizeImageReference(rawValue.image);
    if (rawValue.url) next.fileName = normalizeImageReference(rawValue.url);
    if (rawValue.uploadIndex !== undefined && rawValue.uploadIndex !== null) {
      const uploadIndex = Number(rawValue.uploadIndex);
      const file = files[uploadIndex];
      if (Number.isInteger(rawValue.uploadIndex) && uploadIndex >= mainImageCount && file) {
        next.fileName = file.filename;
        next.uploadIndex = uploadIndex;
      } else if (!next.fileName) {
        throw httpError(400, "INVALID_COLOR_IMAGE", "Color image upload index is invalid");
      }
    }
    if (next.fileName) output[color] = next;
  }
  return output;
}

function deriveInventoryMode(colors, sizes) {
  return colors.length || sizes.length ? "shared_options" : "simple";
}

function normalizeProductPayload(body, options = {}) {
  const colors = normalizeStringArray(body.pColors, "pColors");
  const sizes = normalizeStringArray(body.pSizes, "pSizes");
  const mainImageCount = Number(options.mainImageCount) || 0;

  return {
    pCost: normalizeOptionalMoney(body.pCost, "pCost"),
    pCategoryOrder: normalizeOptionalPositiveInteger(body.pCategoryOrder, "pCategoryOrder"),
    pBarcode: normalizeBarcode(body.pBarcode),
    pBrand: normalizeOptionalString(body.pBrand, "pBrand", 120),
    pMerchantName: normalizeMerchantName(body.pMerchantName),
    pVideo: normalizeVideoUrl(body.pVideo),
    pColors: colors,
    pSizes: sizes,
    pColorImages: normalizeColorImageMap(body.pColorImages, colors, options.files || [], mainImageCount),
    inventoryMode: deriveInventoryMode(colors, sizes),
    relatedProducts: normalizeObjectIdArray(body.relatedProducts, "relatedProducts", options.currentProductId),
    similarProducts: normalizeObjectIdArray(body.similarProducts, "similarProducts", options.currentProductId),
    suggestedProducts: normalizeObjectIdArray(body.suggestedProducts, "suggestedProducts", options.currentProductId),
  };
}

module.exports = {
  deriveInventoryMode,
  httpError,
  normalizeBarcode,
  normalizeColorImageMap,
  normalizeObjectIdArray,
  normalizeMerchantName,
  normalizeOptionalMoney,
  normalizeOptionalPositiveInteger,
  normalizeOptionalString,
  normalizeProductPayload,
  normalizeStringArray,
  normalizeVideoUrl,
};
