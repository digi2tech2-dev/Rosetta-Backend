const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, connectDatabase } = require("../app");
const { config } = require("../config/appConfig");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const cartModel = require("../models/carts");
const orderModel = require("../models/orders");
const couponModel = require("../models/coupons");
const couponRedemptionModel = require("../models/couponRedemptions");
const shippingRuleModel = require("../models/shippingRules");
const commerceSettingsModel = require("../models/commerceSettings");

const REQUIRED_DB = process.env.PRICING_SMOKE_DATABASE_NAME || "client_store_phase2i_disposable";
const PORT = Number(process.env.PORT || 8070);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2i-smoke-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tokenFor(user) {
  return jwt.sign(
    { _id: user._id, role: user.userRole, tokenVersion: user.tokenVersion || 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function cleanup() {
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const productIds = products.map((product) => product._id);
  const coupons = await couponModel.find({ code: new RegExp(`^${TEST_PREFIX}`, "i") }).select("_id");
  const couponIds = coupons.map((coupon) => coupon._id);
  await couponRedemptionModel.deleteMany({ $or: [{ coupon: { $in: couponIds } }, { customer: { $in: userIds } }] });
  await orderModel.deleteMany({ $or: [{ user: { $in: userIds } }, { idempotencyKey: new RegExp(`^${TEST_PREFIX}`) }] });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await couponModel.deleteMany({ _id: { $in: couponIds } });
  await shippingRuleModel.deleteMany({ name: new RegExp(`^${TEST_PREFIX}`) });
  await commerceSettingsModel.deleteMany({ singletonKey: "commerce" });
  await productModel.deleteMany({ _id: { $in: productIds } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
}

async function seed() {
  const category = await categoryModel.create({
    cName: `${TEST_PREFIX}category`,
    cDescription: "Disposable Phase 2I category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const [admin, customer, other] = await userModel.create([
    {
      name: "Phase2I Admin",
      email: `${TEST_PREFIX}admin@example.com`,
      password: bcrypt.hashSync("AdminPassword123!", 10),
      userRole: 1,
      status: "active",
    },
    {
      name: "Phase2I Customer",
      email: `${TEST_PREFIX}customer@example.com`,
      password: bcrypt.hashSync("CustomerPassword123!", 10),
      userRole: 0,
      status: "active",
    },
    {
      name: "Phase2I Other",
      email: `${TEST_PREFIX}other@example.com`,
      password: bcrypt.hashSync("OtherPassword123!", 10),
      userRole: 0,
      status: "active",
    },
  ]);
  const [product, stockProduct] = await productModel.create([
    {
      pName: `${TEST_PREFIX}product`,
      pDescription: "Server priced product",
      pPrice: 100,
      pOffer: "80",
      pQuantity: 8,
      pSold: 0,
      pCategory: category._id,
      pImages: ["product-a.png", "product-b.png"],
      pStatus: "Active",
    },
    {
      pName: `${TEST_PREFIX}stock-product`,
      pDescription: "Shared stock product",
      pPrice: 25,
      pOffer: "0",
      pQuantity: 1,
      pSold: 0,
      pCategory: category._id,
      pImages: ["stock-a.png", "stock-b.png"],
      pStatus: "Active",
      pColors: ["Black", "Red"],
      inventoryMode: "shared_options",
    },
  ]);
  await commerceSettingsModel.create({
    singletonKey: "commerce",
    currency: "EGP",
    defaultShippingFee: 30,
    defaultFreeShippingThreshold: 500,
    automaticFirstOrderDiscountEnabled: true,
    automaticFirstOrderDiscountType: "percentage",
    automaticFirstOrderDiscountValue: 10,
    automaticFirstOrderMaxDiscount: 50,
  });
  await shippingRuleModel.create([
    {
      name: `${TEST_PREFIX}default`,
      governorate: null,
      city: null,
      fee: 35,
      active: true,
      priority: 0,
      createdBy: admin._id,
    },
    {
      name: `${TEST_PREFIX}cairo`,
      governorate: "Cairo",
      city: null,
      fee: 20,
      active: true,
      priority: 1,
      createdBy: admin._id,
    },
    {
      name: `${TEST_PREFIX}nasr-city`,
      governorate: "Cairo",
      city: "Nasr City",
      fee: 12,
      freeShippingThreshold: 150,
      active: true,
      priority: 5,
      createdBy: admin._id,
    },
    {
      name: `${TEST_PREFIX}inactive`,
      governorate: "Giza",
      city: "Dokki",
      fee: 1,
      active: false,
      priority: 100,
      createdBy: admin._id,
    },
  ]);
  return {
    category,
    admin,
    customer,
    other,
    product,
    stockProduct,
    adminToken: tokenFor(admin),
    customerToken: tokenFor(customer),
    otherToken: tokenFor(other),
  };
}

const address = {
  fullName: "Phase2I Customer",
  phone: "+201000000000",
  governorate: "Cairo",
  city: "Nasr City",
  street: "Test street",
};

const quantityAddress = {
  fullName: "Phase2I Quantity Customer",
  phone: "+201000000000",
  governorate: "Quantity Gov",
  city: "Quantity City",
  street: "Quantity street",
};

async function addCart(token, productId, quantity = 1, body = {}) {
  return request("/api/cart/items", {
    method: "POST",
    token,
    body: { productId, quantity, ...body },
  });
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required");
  assert(process.env.ENABLE_LEGACY_BRAINTREE === "false", "Braintree must remain disabled");

  await connectDatabase();
  await cleanup();
  await Promise.all([
    couponModel.init(),
    couponRedemptionModel.init(),
    shippingRuleModel.init(),
    commerceSettingsModel.init(),
  ]);
  const server = app.listen(PORT);
  const tests = [];

  async function test(name, fn) {
    await fn();
    tests.push(name);
    console.log(`${tests.length}. ${name}: PASS`);
  }

  try {
    const seeded = await seed();

    await test("Guest checkout quote requires cart items", async () => {
      const res = await request("/api/checkout/quote", { method: "POST", body: { shippingAddress: address } });
      assert(res.status === 409 && res.body.code === "CART_EMPTY", "guest quote without cart should fail");
    });

    await test("Customer cannot access admin coupon or shipping APIs", async () => {
      const coupon = await request("/api/admin/coupons", { token: seeded.customerToken });
      const shipping = await request("/api/admin/shipping-rules", { token: seeded.customerToken });
      assert(coupon.status === 403, "customer accessed coupons");
      assert(shipping.status === 403, "customer accessed shipping rules");
    });

    await test("Admin creates fixed coupon and duplicate code is controlled", async () => {
      const created = await request("/api/admin/coupons", {
        method: "POST",
        token: seeded.adminToken,
        body: { code: `${TEST_PREFIX}fixed`, type: "fixed", value: 15, minimumSubtotal: 50, active: true },
      });
      const duplicate = await request("/api/admin/coupons", {
        method: "POST",
        token: seeded.adminToken,
        body: { code: `${TEST_PREFIX}FIXED`, type: "fixed", value: 15 },
      });
      assert(created.status === 201, "fixed coupon create failed");
      assert(duplicate.status === 409 && duplicate.body.code === "DUPLICATE_COUPON_CODE", "duplicate code not controlled");
    });

    await test("Malformed percentage coupon is rejected", async () => {
      const res = await request("/api/admin/coupons", {
        method: "POST",
        token: seeded.adminToken,
        body: { code: `${TEST_PREFIX}bad-percent`, type: "percentage", value: 101 },
      });
      assert(res.status === 400, "percentage over 100 should fail");
    });

    await test("Admin settings reject unknown keys", async () => {
      const res = await request("/api/admin/commerce-settings", {
        method: "PATCH",
        token: seeded.adminToken,
        body: { defaultShippingFee: 25, secret: "bad" },
      });
      assert(res.status === 400 && res.body.code === "UNKNOWN_SETTING_KEY", "unknown setting key should fail");
      const invalidPercentage = await request("/api/admin/commerce-settings", {
        method: "PATCH",
        token: seeded.adminToken,
        body: { automaticFirstOrderDiscountValue: 101 },
      });
      assert(invalidPercentage.status === 400, "partial first-order percentage over 100 should fail");
    });

    await test("Cart and quote ignore frontend pricing fields", async () => {
      const add = await addCart(seeded.customerToken, seeded.product._id, 1, { price: 1, subtotal: 1 });
      const quote = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.customerToken,
        body: { shippingAddress: address, subtotal: 1, discount: 99, shippingFee: 1, total: 1, firstOrderEligible: false },
      });
      assert(add.status === 201, "add cart failed");
      assert(quote.status === 200, "quote failed");
      assert(quote.body.quote.items[0].unitPrice === 100, "server pPrice not used");
      assert(quote.body.quote.summary.merchandiseSubtotal === 100, "subtotal trusted client");
      assert(quote.body.quote.summary.discountTotal === 10, "first order promo not server-calculated");
      assert(quote.body.quote.summary.shippingFee === 12, "city shipping rule not used");
      assert(quote.body.quote.summary.grandTotal === 102, "grand total mismatch");
    });

    await test("Quote does not consume coupon usage", async () => {
      const quote = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.customerToken,
        body: { shippingAddress: address, couponCode: `${TEST_PREFIX}fixed` },
      });
      const coupon = await couponModel.findOne({ code: `${TEST_PREFIX}FIXED` });
      assert(quote.status === 200, "coupon quote failed");
      assert(quote.body.quote.discount.source === "coupon", "coupon did not override first-order promo");
      assert(quote.body.quote.summary.discountTotal === 15, "fixed coupon discount mismatch");
      assert(coupon.usageCount === 0, "quote consumed coupon usage");
    });

    await test("COD stores pricing snapshot and consumes coupon once", async () => {
      const created = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}coupon-order` },
        body: { shippingAddress: address, couponCode: `${TEST_PREFIX}fixed`, total: 1, shippingFee: 1 },
      });
      const coupon = await couponModel.findOne({ code: `${TEST_PREFIX}FIXED` });
      const redemptions = await couponRedemptionModel.countDocuments({ coupon: coupon._id, status: "applied" });
      assert(created.status === 201, `COD with coupon failed: ${JSON.stringify(created.body)}`);
      assert(created.body.order.total === 97, "order total not recalculated");
      assert(created.body.order.pricingSnapshot.couponSnapshot.code === `${TEST_PREFIX}FIXED`.toUpperCase(), "coupon snapshot missing");
      assert(coupon.usageCount === 1, "coupon usage not consumed");
      assert(redemptions === 1, "redemption missing");
    });

    await test("Idempotent COD replay does not consume usage or stock twice", async () => {
      const beforeCoupon = await couponModel.findOne({ code: `${TEST_PREFIX}FIXED` });
      const beforeProduct = await productModel.findById(seeded.product._id);
      const replay = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}coupon-order` },
        body: { shippingAddress: address, couponCode: `${TEST_PREFIX}fixed` },
      });
      const afterCoupon = await couponModel.findOne({ code: `${TEST_PREFIX}FIXED` });
      const afterProduct = await productModel.findById(seeded.product._id);
      assert(replay.status === 200 && replay.body.reused === true, "idempotent replay failed");
      assert(afterCoupon.usageCount === beforeCoupon.usageCount, "coupon consumed twice");
      assert(afterProduct.pQuantity === beforeProduct.pQuantity, "stock deducted twice");
    });

    await test("Cancellation releases coupon usage exactly once", async () => {
      const order = await orderModel.findOne({ idempotencyKey: `${TEST_PREFIX}coupon-order` });
      const cancel = await request(`/api/order/admin/orders/${order._id}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "cancelled" },
      });
      const repeat = await request(`/api/order/admin/orders/${order._id}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "cancelled" },
      });
      const coupon = await couponModel.findOne({ code: `${TEST_PREFIX}FIXED` });
      const released = await couponRedemptionModel.countDocuments({ coupon: coupon._id, status: "released" });
      assert(cancel.status === 200, "cancel failed");
      assert(repeat.status === 200, "repeated cancel should be idempotent");
      assert(coupon.usageCount === 0, "coupon usage not released");
      assert(released === 1, "redemption not released exactly once");
    });

    await test("Inactive, not-started, expired, and minimum coupons fail with stable codes", async () => {
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      await couponModel.create([
        { code: `${TEST_PREFIX}INACTIVE`, type: "fixed", value: 5, active: false },
        { code: `${TEST_PREFIX}FUTURE`, type: "fixed", value: 5, startsAt: new Date(Date.now() + 86400000), active: true },
        { code: `${TEST_PREFIX}EXPIRED`, type: "fixed", value: 5, expiresAt: new Date(Date.now() - 1000), active: true },
        { code: `${TEST_PREFIX}MIN`, type: "fixed", value: 5, minimumSubtotal: 1000, active: true },
      ]);
      const cases = [
        [`${TEST_PREFIX}inactive`, "COUPON_INACTIVE"],
        [`${TEST_PREFIX}future`, "COUPON_NOT_STARTED"],
        [`${TEST_PREFIX}expired`, "COUPON_EXPIRED"],
        [`${TEST_PREFIX}min`, "COUPON_MINIMUM_NOT_MET"],
      ];
      for (const [code, expected] of cases) {
        const res = await request("/api/checkout/quote", {
          method: "POST",
          token: seeded.otherToken,
          body: { shippingAddress: address, couponCode: code },
        });
        assert(res.status === 409 && res.body.code === expected, `${expected} mismatch`);
      }
    });

    await test("Percentage coupon caps and rounds correctly", async () => {
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      await couponModel.create({ code: `${TEST_PREFIX}PERCENT`, type: "percentage", value: 33.333, maxDiscount: 10, active: true });
      const res = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.otherToken,
        body: { shippingAddress: address, couponCode: `${TEST_PREFIX}percent` },
      });
      assert(res.status === 200, "percentage coupon quote failed");
      assert(res.body.quote.summary.discountTotal === 10, "percentage max cap failed");
      assert(res.body.quote.summary.grandTotal === 102, "percentage total mismatch");
    });

    await test("Global usage final slot is atomic enough for concurrent attempts", async () => {
      await couponModel.create({ code: `${TEST_PREFIX}GLOBAL1`, type: "fixed", value: 1, active: true, globalUsageLimit: 1 });
      const secondCustomer = await userModel.create({
        name: "Phase2I Concurrent",
        email: `${TEST_PREFIX}concurrent@example.com`,
        password: bcrypt.hashSync("Password123!", 10),
        userRole: 0,
        status: "active",
      });
      const secondToken = tokenFor(secondCustomer);
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      await cartModel.findOneAndUpdate({ user: secondCustomer._id }, { user: secondCustomer._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      const results = await Promise.all([
        request("/api/order/create-cod-order", { method: "POST", token: seeded.otherToken, headers: { "Idempotency-Key": `${TEST_PREFIX}global-a` }, body: { shippingAddress: address, couponCode: `${TEST_PREFIX}global1` } }),
        request("/api/order/create-cod-order", { method: "POST", token: secondToken, headers: { "Idempotency-Key": `${TEST_PREFIX}global-b` }, body: { shippingAddress: address, couponCode: `${TEST_PREFIX}global1` } }),
      ]);
      assert(results.filter((res) => res.status === 201).length === 1, "global final slot allowed multiple orders");
      assert(results.filter((res) => res.status === 409).length === 1, "global final slot should reject one request");
    });

    await test("Per-customer usage limit blocks second completed order", async () => {
      await couponModel.create({ code: `${TEST_PREFIX}ONCE`, type: "fixed", value: 1, active: true, perCustomerUsageLimit: 1 });
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      const first = await request("/api/order/create-cod-order", { method: "POST", token: seeded.otherToken, headers: { "Idempotency-Key": `${TEST_PREFIX}once-a` }, body: { shippingAddress: address, couponCode: `${TEST_PREFIX}once` } });
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      const second = await request("/api/order/create-cod-order", { method: "POST", token: seeded.otherToken, headers: { "Idempotency-Key": `${TEST_PREFIX}once-b` }, body: { shippingAddress: address, couponCode: `${TEST_PREFIX}once` } });
      assert(first.status === 201, "first per-customer coupon order failed");
      assert(second.status === 409, "second per-customer coupon order should fail");
    });

    await test("First-order-only coupon rejects customer with qualifying order", async () => {
      await couponModel.create({ code: `${TEST_PREFIX}FIRSTONLY`, type: "fixed", value: 5, active: true, firstOrderOnly: true });
      await cartModel.findOneAndUpdate({ user: seeded.other._id }, { user: seeded.other._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      const res = await request("/api/checkout/quote", {
        method: "POST",
        token: seeded.otherToken,
        body: { shippingAddress: address, couponCode: `${TEST_PREFIX}firstonly` },
      });
      assert(res.status === 409 && res.body.code === "COUPON_FIRST_ORDER_ONLY", "first-order-only did not reject");
    });

    await test("Cancelled order does not disqualify first-order promotion", async () => {
      const fresh = await userModel.create({
        name: "Phase2I Fresh",
        email: `${TEST_PREFIX}fresh@example.com`,
        password: bcrypt.hashSync("Password123!", 10),
        userRole: 0,
        status: "active",
      });
      const freshToken = tokenFor(fresh);
      await orderModel.create({ user: fresh._id, allProduct: [], amount: 1, orderStatus: "cancelled", status: "Cancelled" });
      await cartModel.create({ user: fresh._id, items: [{ product: seeded.product._id, quantity: 1 }] });
      const res = await request("/api/checkout/quote", { method: "POST", token: freshToken, body: { shippingAddress: address } });
      assert(res.status === 200, "fresh quote failed");
      assert(res.body.quote.discount.source === "first_order", "cancelled order disqualified first-order promo");
    });

    await test("Shipping precedence uses exact city, governorate, default, and inactive ignored", async () => {
      await cartModel.findOneAndUpdate({ user: seeded.customer._id }, { user: seeded.customer._id, items: [{ product: seeded.product._id, quantity: 2 }] }, { upsert: true });
      const exact = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: address } });
      const gov = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: { ...address, city: "Heliopolis" } } });
      const def = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: { ...address, governorate: "Aswan", city: "Aswan" } } });
      const inactive = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: { ...address, governorate: "Giza", city: "Dokki" } } });
      assert(exact.body.quote.summary.shippingFee === 0, "exact city free threshold should apply");
      assert(gov.body.quote.summary.shippingFee === 20, "governorate fallback failed");
      assert(def.body.quote.summary.shippingFee === 35, "default fallback failed");
      assert(inactive.body.quote.summary.shippingFee === 35, "inactive city rule was used");
    });

    await test("Invalid selected options and out-of-stock are rejected by quote/order", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.customer._id },
        { user: seeded.customer._id, items: [{ product: seeded.stockProduct._id, quantity: 1, selectedColor: "Blue" }] },
        { upsert: true }
      );
      const invalidOption = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: address } });
      await cartModel.findOneAndUpdate(
        { user: seeded.customer._id },
        { user: seeded.customer._id, items: [{ product: seeded.stockProduct._id, quantity: 2, selectedColor: "Black" }] },
        { upsert: true }
      );
      const overstock = await request("/api/order/create-cod-order", { method: "POST", token: seeded.customerToken, headers: { "Idempotency-Key": `${TEST_PREFIX}overstock` }, body: { shippingAddress: address } });
      assert([400, 409].includes(invalidOption.status), "invalid option should fail quote");
      assert(overstock.status === 409, "out-of-stock order should fail");
    });

    await test("Admin can manage shipping rules and settings", async () => {
      const rule = await request("/api/admin/shipping-rules", {
        method: "POST",
        token: seeded.adminToken,
        body: { name: `${TEST_PREFIX}alex`, governorate: "Alexandria", fee: 40, priority: 2, active: true },
      });
      const off = await request(`/api/admin/shipping-rules/${rule.body.rule.id}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { active: false, fee: 1 },
      });
      const settings = await request("/api/admin/commerce-settings", {
        method: "PATCH",
        token: seeded.adminToken,
        body: { defaultShippingFee: 25, automaticFirstOrderDiscountEnabled: false },
      });
      assert(rule.status === 201, "shipping rule create failed");
      assert(off.status === 200 && off.body.rule.active === false, "shipping status update failed");
      assert(settings.status === 200 && settings.body.settings.defaultShippingFee === 25, "settings update failed");
    });

    await test("Quantity shipping promotion uses total units and server totals", async () => {
      await shippingRuleModel.create({
        name: `${TEST_PREFIX}quantity-city`,
        governorate: quantityAddress.governorate,
        city: quantityAddress.city,
        fee: 90,
        freeShippingThreshold: null,
        active: true,
        priority: 10,
        createdBy: seeded.admin._id,
      });
      const qtyProduct = await productModel.create({
        pName: `${TEST_PREFIX}quantity-product`,
        pDescription: "Quantity discount product",
        pPrice: 326.25,
        pOffer: "0",
        pQuantity: 20,
        pSold: 0,
        pCategory: seeded.category._id,
        pImages: ["quantity-a.png", "quantity-b.png"],
        pStatus: "Active",
      });
      const extraProducts = await productModel.create([1, 2, 3].map((index) => ({
        pName: `${TEST_PREFIX}quantity-extra-${index}`,
        pDescription: "Quantity discount extra product",
        pPrice: 100,
        pOffer: "0",
        pQuantity: 10,
        pSold: 0,
        pCategory: seeded.category._id,
        pImages: [`quantity-extra-${index}.png`],
        pStatus: "Active",
      })));
      async function setCart(items) {
        await cartModel.findOneAndUpdate(
          { user: seeded.customer._id },
          { user: seeded.customer._id, items },
          { upsert: true, new: true }
        );
      }
      async function quote(items, shippingAddress = quantityAddress) {
        await setCart(items);
        return request("/api/checkout/quote", {
          method: "POST",
          token: seeded.customerToken,
          body: {
            shippingAddress,
            shippingFee: 1,
            shippingDiscount: 999,
            shippingDiscountPercent: 100,
            total: 1,
            shipping: { baseCost: 1, finalCost: 1 },
          },
        });
      }

      const qty3 = await quote([{ product: qtyProduct._id, quantity: 3 }]);
      assert(qty3.status === 200, `qty3 quote failed: ${JSON.stringify(qty3.body)}`);
      assert(qty3.body.quote.summary.shippingFee === 90, "qty3 should keep normal shipping");
      assert(qty3.body.quote.shippingPromotion.discountPercent === 0, "qty3 discount percent mismatch");
      assert(qty3.body.quote.shippingPromotion.nextThreshold === 4, "qty3 next threshold mismatch");
      assert(qty3.body.quote.shippingPromotion.quantityNeededForNextThreshold === 1, "qty3 quantity needed mismatch");

      const singleQty4 = await quote([{ product: qtyProduct._id, quantity: 4 }]);
      assert(singleQty4.status === 200, `qty4 quote failed: ${JSON.stringify(singleQty4.body)}`);
      assert(singleQty4.body.quote.summary.merchandiseSubtotal === 1305, "qty4 subtotal mismatch");
      assert(singleQty4.body.quote.summary.shippingFee === 45, "one item quantity 4 should get half shipping");
      assert(singleQty4.body.quote.summary.grandTotal === 1350, "qty4 grand total should use final shipping");
      assert(singleQty4.body.quote.shipping.baseCost === 90, "qty4 base shipping mismatch");
      assert(singleQty4.body.quote.shipping.discountPercent === 50, "qty4 shipping percent mismatch");
      assert(singleQty4.body.quote.shipping.discountAmount === 45, "qty4 shipping discount mismatch");
      assert(singleQty4.body.quote.shipping.finalCost === 45, "qty4 final shipping mismatch");
      assert(singleQty4.body.quote.shippingPromotion.totalQuantity === 4, "qty4 totalQuantity mismatch");
      assert(singleQty4.body.quote.shippingPromotion.nextThreshold === 6, "qty4 next threshold mismatch");
      assert(singleQty4.body.quote.shippingPromotion.quantityNeededForNextThreshold === 2, "qty4 quantity needed mismatch");

      const qty5 = await quote([{ product: qtyProduct._id, quantity: 5 }]);
      assert(qty5.body.quote.summary.shippingFee === 45, "qty5 should get half shipping");
      assert(qty5.body.quote.shippingPromotion.quantityNeededForNextThreshold === 1, "qty5 quantity needed mismatch");

      const qty6 = await quote([{ product: qtyProduct._id, quantity: 6 }]);
      assert(qty6.body.quote.summary.shippingFee === 0, "qty6 should get free shipping");
      assert(qty6.body.quote.shippingPromotion.discountPercent === 100, "qty6 discount percent mismatch");
      assert(qty6.body.quote.shippingPromotion.nextThreshold === null, "qty6 next threshold mismatch");

      const fourDifferent = await quote([
        { product: qtyProduct._id, quantity: 1 },
        { product: extraProducts[0]._id, quantity: 1 },
        { product: extraProducts[1]._id, quantity: 1 },
        { product: extraProducts[2]._id, quantity: 1 },
      ]);
      assert(fourDifferent.body.quote.summary.shippingFee === 45, "four separate items should get half shipping");
      assert(fourDifferent.body.quote.shippingPromotion.totalQuantity === 4, "four separate items totalQuantity mismatch");

      const mixedQty4 = await quote([
        { product: qtyProduct._id, quantity: 3 },
        { product: extraProducts[0]._id, quantity: 1 },
      ]);
      assert(mixedQty4.body.quote.summary.shippingFee === 45, "mixed total quantity 4 should get half shipping");

      const mixedQty6 = await quote([
        { product: qtyProduct._id, quantity: 4 },
        { product: extraProducts[0]._id, quantity: 2 },
      ]);
      assert(mixedQty6.body.quote.summary.shippingFee === 0, "mixed total quantity 6 should get free shipping");

      const existingFree = await quote([{ product: qtyProduct._id, quantity: 4 }], address);
      assert(existingFree.body.quote.summary.shippingFee === 0, "existing free shipping threshold should remain free");
      assert(existingFree.body.quote.shipping.baseCost === 0, "quantity promotion should not increase existing free shipping");
      assert(existingFree.body.quote.shipping.thresholdFreeShippingApplied === true, "threshold free shipping flag missing");

      await setCart([{ product: qtyProduct._id, quantity: 4 }]);
      const created = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}quantity-cod` },
        body: {
          shippingAddress: quantityAddress,
          shippingFee: 1,
          shippingDiscountPercent: 100,
          total: 1,
        },
      });
      assert(created.status === 201, `quantity COD failed: ${JSON.stringify(created.body)}`);
      assert(created.body.order.total === 1350, "quantity COD total should ignore client total");
      assert(created.body.order.shippingFee === 45, "quantity COD shipping should use final shipping");
      assert(created.body.order.totalQuantity === 4, "quantity COD totalQuantity missing");
      assert(created.body.order.shippingBaseCost === 90, "quantity COD base shipping missing");
      assert(created.body.order.shippingDiscountPercent === 50, "quantity COD discount percent missing");
      assert(created.body.order.shippingDiscountAmount === 45, "quantity COD discount amount missing");
      assert(created.body.order.pricingSnapshot.shippingSnapshot.finalFee === 45, "quantity COD final snapshot missing");
      assert(created.body.order.pricingSnapshot.shippingSnapshot.baseFee === 90, "quantity COD base snapshot missing");

      const replay = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}quantity-cod` },
        body: { shippingAddress: quantityAddress },
      });
      assert(replay.status === 200 && replay.body.reused === true, "quantity COD replay should be idempotent");
      assert(replay.body.order.shippingFee === 45, "quantity COD replay shipping changed");

      const adminOrder = await request(`/api/order/admin/orders/${created.body.order.id}`, { token: seeded.adminToken });
      assert(adminOrder.status === 200, "admin order serialization failed");
      assert(adminOrder.body.order.shippingDiscountPercent === 50, "admin order discount percent missing");
      assert(adminOrder.body.order.finalShippingCost === 45, "admin order final shipping missing");

      const guest = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}quantity-guest-cod` },
        body: {
          guestCustomer: { fullName: "Quantity Guest", phone: "01000000000" },
          shippingAddress: quantityAddress,
          cartItems: [{ productId: qtyProduct._id, quantity: 6 }],
          shippingFee: 90,
          shippingDiscountPercent: 0,
          total: 9999,
        },
      });
      assert(guest.status === 201, `guest quantity COD failed: ${JSON.stringify(guest.body)}`);
      assert(guest.body.order.shippingFee === 0, "guest quantity COD should get free shipping");
      assert(guest.body.order.total === 1957.5, "guest quantity COD total should use final shipping");
      assert(guest.body.order.pricingSnapshot.totalQuantity === 6, "guest quantity COD snapshot total quantity missing");
      assert(guest.body.guestTracking && guest.body.guestTracking.trackingToken, "guest quantity tracking token missing");
    });

    await test("Old orders without snapshots serialize safely", async () => {
      const legacy = await orderModel.create({
        user: seeded.customer._id,
        allProduct: [{ id: seeded.product._id, quantitiy: 1 }],
        amount: 123,
        transactionId: `${TEST_PREFIX}legacy-order`,
        address: "Legacy",
        phone: 1000000000,
      });
      const res = await request(`/api/order/my-orders/${legacy._id}`, { token: seeded.customerToken });
      assert(res.status === 200, "legacy order read failed");
      assert(res.body.order.total === 123, "legacy order total changed");
      assert(res.body.order.pricingSnapshot === null, "legacy snapshot should be null");
    });

    await test("Public responses contain no coupon internals or product cost", async () => {
      await cartModel.findOneAndUpdate({ user: seeded.customer._id }, { user: seeded.customer._id, items: [{ product: seeded.product._id, quantity: 1 }] }, { upsert: true });
      const res = await request("/api/checkout/quote", { method: "POST", token: seeded.customerToken, body: { shippingAddress: address } });
      const raw = JSON.stringify(res.body);
      assert(!raw.includes("customerUsage"), "customer usage leaked");
      assert(!raw.includes("usageCount"), "usage count leaked in public quote");
      assert(!raw.includes("pCost"), "product cost leaked");
    });

    await test("Phase 2I records are cleaned", async () => {
      await cleanup();
      const remainingCoupons = await couponModel.countDocuments({ code: new RegExp(`^${TEST_PREFIX}`, "i") });
      const remainingRules = await shippingRuleModel.countDocuments({ name: new RegExp(`^${TEST_PREFIX}`) });
      assert(remainingCoupons === 0, "coupons not cleaned");
      assert(remainingRules === 0, "shipping rules not cleaned");
    });

    console.log(`PRICING_SHIPPING_SMOKE_PASS ${tests.length} tests`);
  } finally {
    await cleanup().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error(`PRICING_SHIPPING_SMOKE_FAIL: ${err.message}`);
  try {
    await cleanup();
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
