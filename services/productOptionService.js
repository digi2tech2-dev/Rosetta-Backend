function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function asArray(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeOneOption(product, field, submitted, label) {
  const values = asArray(product[field]);
  if (values.length === 0) return null;

  const raw = submitted === undefined || submitted === null ? "" : String(submitted).trim();
  if (!raw) {
    if (values.length === 1) return values[0];
    throw httpError(400, "INVALID_PRODUCT_OPTION", `${label} selection is required`);
  }

  const match = values.find((value) => value.toLowerCase() === raw.toLowerCase());
  if (!match) {
    throw httpError(400, "INVALID_PRODUCT_OPTION", `${label} selection is not available`);
  }
  return match;
}

function validateProductOptions({ product, selectedColor, selectedSize }) {
  return {
    selectedColor: normalizeOneOption(product, "pColors", selectedColor, "Color"),
    selectedSize: normalizeOneOption(product, "pSizes", selectedSize, "Size"),
  };
}

function optionIdentity(selectedColor, selectedSize) {
  return `${selectedColor || ""}::${selectedSize || ""}`.toLowerCase();
}

module.exports = {
  optionIdentity,
  validateProductOptions,
};
