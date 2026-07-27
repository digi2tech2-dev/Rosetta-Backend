const { config } = require("../config/appConfig");

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

function getEffectiveProductPriceCents(product) {
  const base = toCents(product.pPrice);
  const offerRaw = product.pOffer;
  const hasOffer =
    offerRaw !== undefined &&
    offerRaw !== null &&
    String(offerRaw).trim() !== "" &&
    Number(offerRaw) > 0;
  if (!hasOffer) {
    return base;
  }

  const offer = toCents(offerRaw);
  return offer > 0 && offer < base ? offer : base;
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
    subtotal: fromCents(subtotalCents),
    shippingFee: fromCents(shippingCents),
    total: fromCents(subtotalCents + shippingCents),
    currency: config.storeCurrency,
  };
}

module.exports = {
  toCents,
  fromCents,
  getEffectiveProductPrice,
  getEffectiveProductPriceCents,
  calculateShippingCents,
  moneySummary,
};
