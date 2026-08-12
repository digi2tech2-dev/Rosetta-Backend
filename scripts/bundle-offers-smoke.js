process.env.NODE_ENV = "test";
process.env.DATABASE = process.env.DATABASE || "mongodb://127.0.0.1:27017/rosetta_bundle_offers_smoke";
process.env.JWT_SECRET = process.env.JWT_SECRET || "bundle-offers-smoke-secret";
process.env.PASSWORD_RESET_PEPPER = process.env.PASSWORD_RESET_PEPPER || "bundle-offers-smoke-pepper";
process.env.STORE_CURRENCY = process.env.STORE_CURRENCY || "EGP";
process.env.SHIPPING_FLAT_RATE = process.env.SHIPPING_FLAT_RATE || "100";
process.env.FREE_SHIPPING_MINIMUM = process.env.FREE_SHIPPING_MINIMUM || "0";

const assert = require("assert");
const mongoose = require("mongoose");
const bundleOfferModel = require("../models/bundleOffers");
const cartModel = require("../models/carts");
const couponModel = require("../models/coupons");
const productModel = require("../models/products");
const userModel = require("../models/users");
const cartService = require("../services/cartService");
const {
  createBundleOffer,
  getPublicOfferByProduct,
  updateBundleOffer,
} = require("../services/bundleOfferService");
const { calculateGuestCheckoutPricing } = require("../services/pricingService");

const address = {
  fullName: "Bundle Customer",
  phone: "01012345678",
  governorate: "Cairo",
  city: "Nasr City",
  street: "Test street",
};

async function reset() {
  await Promise.all([
    bundleOfferModel.deleteMany({}),
    cartModel.deleteMany({}),
    couponModel.deleteMany({}),
    productModel.deleteMany({}),
    userModel.deleteMany({ email: /bundle-smoke/i }),
  ]);
}

async function product(overrides) {
  return productModel.create({
    pName: overrides.pName || "Bundle product",
    pDescription: "Bundle smoke product",
    pPrice: overrides.pPrice,
    pQuantity: overrides.pQuantity === undefined ? 10 : overrides.pQuantity,
    pImages: ["product.png"],
    pStatus: overrides.pStatus || "Active",
    pColors: overrides.pColors || [],
    pSizes: overrides.pSizes || [],
  });
}

async function assertRejectsCode(action, code) {
  let failed = false;
  try {
    await action();
  } catch (err) {
    failed = err.code === code;
  }
  assert(failed, `${code} was not rejected`);
}

async function main() {
  await mongoose.connect(process.env.DATABASE, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 3000,
  });
  await reset();

  const admin = await userModel.create({
    name: "Bundle Admin",
    email: "bundle-smoke-admin@example.test",
    password: "hashed",
    userRole: 1,
  });
  const customer = await userModel.create({
    name: "Bundle Buyer",
    email: "bundle-smoke-buyer@example.test",
    password: "hashed",
    userRole: 0,
  });
  const primary = await product({ pName: "Primary", pPrice: 145 });
  const additional = await product({ pName: "Additional", pPrice: 199, pColors: ["Black"] });
  const normal = await product({ pName: "Normal", pPrice: 10 });

  const offer = await createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: additional._id,
    bundlePrice: 300,
    active: true,
  }, admin._id);

  assert.strictEqual(offer.regularTotal, 344);
  assert.strictEqual(offer.savings, 44);
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: additional._id,
    bundlePrice: 299,
  }, admin._id), "DUPLICATE_BUNDLE_PAIR");
  const reverse = await createBundleOffer({
    primaryProductId: additional._id,
    additionalProductId: primary._id,
    bundlePrice: 300,
  }, admin._id);
  assert(reverse.id, "reverse ordered pair should be allowed");
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: primary._id,
    bundlePrice: 100,
  }, admin._id), "INVALID_BUNDLE_PRODUCTS");
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: additional._id,
    bundlePrice: 344,
  }, admin._id), "INVALID_BUNDLE_PRICE");

  const inactive = await product({ pName: "Inactive", pPrice: 50, pStatus: "Inactive" });
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: inactive._id,
    bundlePrice: 100,
  }, admin._id), "BUNDLE_PRODUCT_INACTIVE");
  const outOfStock = await product({ pName: "Out", pPrice: 50, pQuantity: 0 });
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: outOfStock._id,
    bundlePrice: 100,
  }, admin._id), "BUNDLE_PRODUCT_OUT_OF_STOCK");
  const optionHeavy = await product({ pName: "Options", pPrice: 80, pColors: ["Black", "White"] });
  await assertRejectsCode(() => createBundleOffer({
    primaryProductId: primary._id,
    additionalProductId: optionHeavy._id,
    bundlePrice: 100,
  }, admin._id), "BUNDLE_ADDITIONAL_OPTIONS_UNSUPPORTED");

  const publicOffer = await getPublicOfferByProduct(primary._id);
  assert.strictEqual(publicOffer.id, offer.id);
  const unrelated = await product({ pName: "Unrelated", pPrice: 120 });
  assert.strictEqual(await getPublicOfferByProduct(unrelated._id), null);
  await updateBundleOffer(offer.id, { active: false }, admin._id);
  assert.strictEqual(await getPublicOfferByProduct(primary._id), null);
  await updateBundleOffer(offer.id, { active: true }, admin._id);

  const groupId = "guest-bundle-1";
  const guestQuote = await calculateGuestCheckoutPricing({
    cartItems: [
      { productId: primary._id, quantity: 1, bundleOfferId: offer.id, bundleGroupId: groupId, bundleRole: "primary" },
      { productId: additional._id, quantity: 1, selectedColor: "Black", bundleOfferId: offer.id, bundleGroupId: groupId, bundleRole: "additional" },
    ],
    shippingAddress: address,
  });
  assert.strictEqual(guestQuote.summary.normalSubtotal, 344);
  assert.strictEqual(guestQuote.summary.merchandiseSubtotal, 300);
  assert.strictEqual(guestQuote.summary.bundleDiscount, 44);
  assert.strictEqual(guestQuote.summary.totalQuantity, 2);
  assert.strictEqual(guestQuote.summary.shippingFee, 100);

  const bundlePlusNormalQuote = await calculateGuestCheckoutPricing({
    cartItems: [
      { productId: primary._id, quantity: 1, bundleOfferId: offer.id, bundleGroupId: "guest-bundle-plus-1", bundleRole: "primary" },
      { productId: additional._id, quantity: 1, selectedColor: "Black", bundleOfferId: offer.id, bundleGroupId: "guest-bundle-plus-1", bundleRole: "additional" },
      { productId: normal._id, quantity: 1 },
    ],
    shippingAddress: address,
  });
  assert.strictEqual(bundlePlusNormalQuote.summary.totalQuantity, 3);
  assert.strictEqual(bundlePlusNormalQuote.shippingPromotion.discountPercent, 50);
  assert.strictEqual(bundlePlusNormalQuote.summary.shippingFee, 50);

  await couponModel.create({ code: "BUNDLE10", type: "fixed", value: 10, active: true });
  const couponQuote = await calculateGuestCheckoutPricing({
    cartItems: [
      { productId: primary._id, quantity: 2, bundleOfferId: offer.id, bundleGroupId: "guest-bundle-2", bundleRole: "primary" },
      { productId: additional._id, quantity: 2, selectedColor: "Black", bundleOfferId: offer.id, bundleGroupId: "guest-bundle-2", bundleRole: "additional" },
    ],
    shippingAddress: address,
    couponCode: "bundle10",
  });
  assert.strictEqual(couponQuote.summary.normalSubtotal, 688);
  assert.strictEqual(couponQuote.summary.merchandiseSubtotal, 600);
  assert.strictEqual(couponQuote.summary.bundleDiscount, 88);
  assert.strictEqual(couponQuote.discount.source, "coupon");
  assert.strictEqual(couponQuote.summary.discountTotal, 10);
  assert.strictEqual(couponQuote.shippingPromotion.discountPercent, 50);

  const twoBundlesPlusNormalQuote = await calculateGuestCheckoutPricing({
    cartItems: [
      { productId: primary._id, quantity: 2, bundleOfferId: offer.id, bundleGroupId: "guest-bundle-plus-2", bundleRole: "primary" },
      { productId: additional._id, quantity: 2, selectedColor: "Black", bundleOfferId: offer.id, bundleGroupId: "guest-bundle-plus-2", bundleRole: "additional" },
      { productId: normal._id, quantity: 1 },
    ],
    shippingAddress: address,
  });
  assert.strictEqual(twoBundlesPlusNormalQuote.summary.totalQuantity, 5);
  assert.strictEqual(twoBundlesPlusNormalQuote.shippingPromotion.discountPercent, 100);
  assert.strictEqual(twoBundlesPlusNormalQuote.summary.shippingFee, 0);

  await assertRejectsCode(() => calculateGuestCheckoutPricing({
    cartItems: [
      { productId: primary._id, quantity: 1, bundleOfferId: offer.id, bundleGroupId: "bad", bundleRole: "primary" },
    ],
    shippingAddress: address,
  }), "INVALID_BUNDLE_GROUP");

  const cart = await cartService.addBundle(customer._id, {
    bundleOfferId: offer.id,
    quantity: 1,
    selections: { additional: { color: "Black" } },
  });
  assert.strictEqual(cart.items.length, 2);
  const primaryLine = cart.items.find((item) => item.bundleRole === "primary");
  assert(primaryLine.bundleGroupId, "bundle group id missing");
  const updatedCart = await cartService.updateItem(customer._id, primary._id, 2, {
    bundleGroupId: primaryLine.bundleGroupId,
  });
  assert(updatedCart.items.every((item) => item.quantity === 2), "bundle quantity was not synchronized");
  const dissolved = await cartService.removeItem(customer._id, primary._id, {
    bundleGroupId: primaryLine.bundleGroupId,
  });
  assert.strictEqual(dissolved.items.length, 1);
  assert.strictEqual(dissolved.items[0].bundleGroupId, null);

  await reset();
  await mongoose.disconnect();
  console.log("BUNDLE_OFFERS_SMOKE_PASS");
}

main().catch(async (err) => {
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect failures
  }
  console.error(err && (err.stack || err.message) || err);
  process.exit(1);
});
