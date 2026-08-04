const { spawn } = require("child_process");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const orderModel = require("../models/orders");
const cartModel = require("../models/carts");
const orderService = require("../services/orderService");

const REQUIRED_DB = process.env.COMMERCE_SMOKE_DATABASE_NAME || "client_store_phase2c_disposable";
const PORT = Number(process.env.PORT || 8050);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2c-smoke-";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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
  } catch (err) {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function waitForServer() {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.status === 200) {
        return;
      }
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Server did not become ready");
}

function startServer() {
  return spawn(process.execPath, ["app.js"], {
    cwd: __dirname + "/..",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      DATABASE: process.env.DATABASE,
      JWT_SECRET: process.env.JWT_SECRET,
      ENABLE_LEGACY_BRAINTREE: "false",
      AUTH_RATE_LIMIT_MAX: "400",
      SHIPPING_FLAT_RATE: process.env.SHIPPING_FLAT_RATE || "0",
      FREE_SHIPPING_MINIMUM: process.env.FREE_SHIPPING_MINIMUM || "0",
      STORE_CURRENCY: process.env.STORE_CURRENCY || "USD",
    },
    stdio: "ignore",
  });
}

function tokenFor(user) {
  return jwt.sign({ _id: user._id, role: user.userRole }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}

async function cleanup() {
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const productIds = products.map((product) => product._id);
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  await orderModel.deleteMany({
    $or: [
      { idempotencyKey: new RegExp(`^${TEST_PREFIX}`) },
      { transactionId: new RegExp(`^${TEST_PREFIX}`) },
      { user: { $in: userIds } },
    ],
  });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await productModel.deleteMany({ _id: { $in: productIds } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
}

async function seed() {
  const category = await categoryModel.create({
    cName: `${TEST_PREFIX}category`,
    cDescription: "Disposable commerce smoke category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const productA = await productModel.create({
    pName: `${TEST_PREFIX}product-a`,
    pDescription: "Disposable product A",
    pPrice: 100,
    pOffer: "80",
    pQuantity: 8,
    pSold: 0,
    pCategory: category._id,
    pImages: ["fixture-a.png", "fixture-b.png"],
    pStatus: "Active",
  });
  const productB = await productModel.create({
    pName: `${TEST_PREFIX}product-b`,
    pDescription: "Disposable product B",
    pPrice: 40,
    pOffer: "0",
    pQuantity: 5,
    pSold: 0,
    pCategory: category._id,
    pImages: ["fixture-c.png", "fixture-d.png"],
    pStatus: "Active",
  });
  const unavailable = await productModel.create({
    pName: `${TEST_PREFIX}unavailable`,
    pDescription: "Disposable unavailable product",
    pPrice: 20,
    pOffer: "0",
    pQuantity: 3,
    pSold: 0,
    pCategory: category._id,
    pImages: ["fixture-e.png", "fixture-f.png"],
    pStatus: "Disabled",
  });
  const customer = await userModel.create({
    name: "Phase2C Customer",
    email: `${TEST_PREFIX}customer@example.com`,
    password: bcrypt.hashSync("CustomerPassword123!", 10),
    userRole: 0,
  });
  const other = await userModel.create({
    name: "Phase2C Other",
    email: `${TEST_PREFIX}other@example.com`,
    password: bcrypt.hashSync("OtherPassword123!", 10),
    userRole: 0,
  });
  const admin = await userModel.create({
    name: "Phase2C Admin",
    email: `${TEST_PREFIX}admin@example.com`,
    password: bcrypt.hashSync("AdminPassword123!", 10),
    userRole: 1,
  });
  return {
    category,
    productA,
    productB,
    unavailable,
    customer,
    other,
    admin,
    customerToken: tokenFor(customer),
    otherToken: tokenFor(other),
    adminToken: tokenFor(admin),
  };
}

const shippingAddress = {
  fullName: "Phase Customer",
  phone: "+201000000000",
  city: "Cairo",
  area: "Nasr City",
  street: "Test Street",
  building: "10",
  apartment: "4",
  postalCode: "00000",
  notes: "Disposable smoke order",
};

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, {
    requiredDatabaseName: REQUIRED_DB,
  });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required");
  assert(process.env.ENABLE_LEGACY_BRAINTREE === "false", "Braintree must remain disabled");

  const server = startServer();
  let seeded;
  let createdOrderId;
  let cancelledOrderId;
  try {
    await waitForServer();
    await mongoose.connect(process.env.DATABASE, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
    });
    await cleanup();
    seeded = await seed();

    const tests = [];
    async function test(name, fn) {
      tests.push(name);
      await fn();
      console.log(`${tests.length}. ${name}: PASS`);
    }

    await test("Unauthenticated cart read returns 401", async () => {
      const res = await request("/api/cart");
      assert(res.status === 401, "cart read should require auth");
    });

    await test("Customer empty cart returns valid empty summary", async () => {
      const res = await request("/api/cart", { token: seeded.customerToken });
      assert(res.status === 200, "cart read failed");
      assert(res.body.cart.items.length === 0, "empty cart should have no items");
      assert(res.body.cart.summary.total === 0, "empty cart total should be zero");
    });

    await test("Customer adds an active in-stock product", async () => {
      const res = await request("/api/cart/items", {
        method: "POST",
        token: seeded.customerToken,
        body: { productId: seeded.productA._id, quantity: 1, price: 1 },
      });
      assert(res.status === 201, "add item failed");
      assert(res.body.cart.items[0].quantity === 1, "quantity mismatch");
    });

    await test("Client-supplied price is ignored", async () => {
      const res = await request("/api/cart", { token: seeded.customerToken });
      assert(res.body.cart.items[0].unitPrice === 100, "server pPrice was not authoritative");
    });

    await test("Invalid quantity is rejected", async () => {
      const res = await request("/api/cart/items", {
        method: "POST",
        token: seeded.customerToken,
        body: { productId: seeded.productA._id, quantity: 1.5 },
      });
      assert(res.status === 400, "decimal quantity should fail");
    });

    await test("Quantity above stock is rejected", async () => {
      const res = await request(`/api/cart/items/${seeded.productA._id}`, {
        method: "PATCH",
        token: seeded.customerToken,
        body: { quantity: 99 },
      });
      assert(res.status === 409, "above-stock quantity should fail");
    });

    await test("Duplicate product addition merges quantity", async () => {
      const res = await request("/api/cart/items", {
        method: "POST",
        token: seeded.customerToken,
        body: { productId: seeded.productA._id, quantity: 2 },
      });
      assert(res.body.cart.items.length === 1, "duplicate row created");
      assert(res.body.cart.items[0].quantity === 3, "quantity was not merged");
    });

    await test("Cart update recomputes totals from current database price", async () => {
      await productModel.findByIdAndUpdate(seeded.productA._id, { pPrice: 120, pOffer: "90" });
      const res = await request(`/api/cart/items/${seeded.productA._id}`, {
        method: "PATCH",
        token: seeded.customerToken,
        body: { quantity: 2 },
      });
      assert(res.body.cart.items[0].unitPrice === 120, "updated server price not used");
      assert(res.body.cart.summary.subtotal === 240, "subtotal did not recompute");
    });

    await test("Cart item removal works", async () => {
      const res = await request(`/api/cart/items/${seeded.productA._id}`, {
        method: "DELETE",
        token: seeded.customerToken,
      });
      assert(res.status === 200, "remove item failed");
      assert(res.body.cart.items.length === 0, "item was not removed");
    });

    await test("Guest-cart sync ignores client prices", async () => {
      const res = await request("/api/cart/sync", {
        method: "POST",
        token: seeded.customerToken,
        body: { items: [{ productId: seeded.productA._id, quantity: 1, price: 1 }] },
      });
      assert(res.status === 200, "sync failed");
      assert(res.body.cart.items[0].unitPrice === 120, "sync trusted client price");
    });

    await test("Guest-cart sync merges duplicates", async () => {
      await request("/api/cart", { token: seeded.otherToken });
      const res = await request("/api/cart/sync", {
        method: "POST",
        token: seeded.otherToken,
        body: {
          items: [
            { productId: seeded.productB._id, quantity: 1 },
            { productId: seeded.productB._id, quantity: 2 },
          ],
        },
      });
      assert(res.body.cart.items.length === 1, "sync duplicate row created");
      assert(res.body.cart.items[0].quantity === 3, "sync duplicate quantity not merged");
    });

    await test("Guest-cart sync reports unavailable products", async () => {
      const res = await request("/api/cart/sync", {
        method: "POST",
        token: seeded.customerToken,
        body: { items: [{ productId: seeded.unavailable._id, quantity: 1 }] },
      });
      assert(res.body.warnings.some((warning) => warning.code === "UNAVAILABLE"), "missing unavailable warning");
    });

    await test("Guest COD requires guest identity and cart details", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        headers: { "Idempotency-Key": `${TEST_PREFIX}no-auth` },
        body: { shippingAddress },
      });
      assert(res.status === 400, "guest COD without guest details should fail validation");
    });

    await test("COD order rejects empty cart", async () => {
      await request("/api/cart", { method: "DELETE", token: seeded.otherToken });
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.otherToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}empty-cart` },
        body: { shippingAddress },
      });
      assert(res.status === 409, "empty cart should fail");
    });

    await test("COD order validates shipping address", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}bad-address` },
        body: { shippingAddress: { phone: "bad" } },
      });
      assert(res.status === 400, "bad address should fail");
    });

    await test("COD order ignores client total/user/status fields", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}create-order` },
        body: {
          shippingAddress,
          total: 1,
          amount: 1,
          user: seeded.other._id,
          orderStatus: "delivered",
          paymentStatus: "paid",
        },
      });
      assert(res.status === 201, "COD creation failed");
      createdOrderId = res.body.order.id;
      assert(res.body.order.total === 120, "server total not authoritative");
      assert(String(res.body.order.user) === String(seeded.customer._id), "order owner came from client");
      assert(res.body.order.orderStatus === "pending", "order status trusted client");
      assert(res.body.order.paymentStatus === "unpaid", "payment status trusted client");
    });

    await test("COD order stores item snapshots", async () => {
      const order = await orderModel.findById(createdOrderId);
      assert(order.items.length === 1, "snapshot item missing");
      await productModel.findByIdAndUpdate(seeded.productA._id, { pName: `${TEST_PREFIX}renamed` });
      const again = await request(`/api/order/my-orders/${createdOrderId}`, { token: seeded.customerToken });
      assert(again.body.order.items[0].name === `${TEST_PREFIX}product-a`, "snapshot changed after product edit");
    });

    await test("COD order deducts stock", async () => {
      const product = await productModel.findById(seeded.productA._id);
      assert(product.pQuantity === 7, "stock not deducted");
    });

    await test("COD order increments sold count", async () => {
      const product = await productModel.findById(seeded.productA._id);
      assert(product.pSold === 1, "sold count not incremented");
    });

    await test("COD order clears cart only after success", async () => {
      const cart = await cartModel.findOne({ user: seeded.customer._id });
      assert(cart.items.length === 0, "cart not cleared after order");
    });

    await test("Duplicate idempotency-key retry does not create another order", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}create-order` },
        body: { shippingAddress },
      });
      const count = await orderModel.countDocuments({
        user: seeded.customer._id,
        idempotencyKey: `${TEST_PREFIX}create-order`,
      });
      assert(res.status === 200, "idempotent retry should return existing order");
      assert(count === 1, "duplicate order was created");
    });

    await test("Different payload with reused key returns 409", async () => {
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}create-order` },
        body: { shippingAddress: { ...shippingAddress, city: "Giza" } },
      });
      assert(res.status === 409, "conflicting idempotency reuse should fail");
    });

    await test("Customer sees their own order history", async () => {
      const res = await request("/api/order/my-orders", { token: seeded.customerToken });
      assert(res.status === 200, "my orders failed");
      assert(res.body.orders.some((order) => order.id === createdOrderId), "created order missing");
    });

    await test("Customer cannot access another customer's order", async () => {
      const res = await request(`/api/order/my-orders/${createdOrderId}`, { token: seeded.otherToken });
      assert(res.status === 404, "other customer should not see order");
    });

    await test("Customer cannot list all orders", async () => {
      const res = await request("/api/order/admin/orders", { token: seeded.customerToken });
      assert(res.status === 403, "customer listed admin orders");
    });

    await test("Admin can list orders", async () => {
      const res = await request("/api/order/admin/orders", { token: seeded.adminToken });
      assert(res.status === 200, "admin order list failed");
      assert(res.body.orders.length > 0, "admin list empty");
    });

    await test("Invalid admin status transition returns 409", async () => {
      const res = await request(`/api/order/admin/orders/${createdOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "delivered" },
      });
      assert(res.status === 409, "invalid transition should fail");
    });

    await test("Valid status transitions work", async () => {
      for (const next of ["confirmed", "processing", "shipped"]) {
        const res = await request(`/api/order/admin/orders/${createdOrderId}/status`, {
          method: "PATCH",
          token: seeded.adminToken,
          body: { orderStatus: next },
        });
        assert(res.status === 200, `transition to ${next} failed`);
      }
    });

    await test("Delivered COD order becomes paid", async () => {
      const res = await request(`/api/order/admin/orders/${createdOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "delivered" },
      });
      assert(res.status === 200, "deliver failed");
      assert(res.body.order.paymentStatus === "paid", "delivered COD not marked paid");
    });

    await test("Cancelling an eligible order restores stock", async () => {
      await request("/api/cart/items", {
        method: "POST",
        token: seeded.customerToken,
        body: { productId: seeded.productB._id, quantity: 2 },
      });
      const create = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.customerToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}cancel-order` },
        body: { shippingAddress },
      });
      cancelledOrderId = create.body.order.id;
      const before = await productModel.findById(seeded.productB._id);
      const cancel = await request(`/api/order/admin/orders/${cancelledOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "cancelled" },
      });
      const after = await productModel.findById(seeded.productB._id);
      assert(cancel.status === 200, "cancel failed");
      assert(after.pQuantity === before.pQuantity + 2, "stock not restored");
    });

    await test("Repeating cancellation does not restore stock twice", async () => {
      const before = await productModel.findById(seeded.productB._id);
      const cancel = await request(`/api/order/admin/orders/${cancelledOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "cancelled" },
      });
      const after = await productModel.findById(seeded.productB._id);
      assert(cancel.status === 200, "repeated cancel should be idempotent");
      assert(after.pQuantity === before.pQuantity, "stock restored twice");
    });

    await test("Cancelled order cannot be delivered", async () => {
      const res = await request(`/api/order/admin/orders/${cancelledOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "delivered" },
      });
      assert(res.status === 409, "cancelled order delivered");
    });

    await test("Delivered order cannot be cancelled", async () => {
      const res = await request(`/api/order/admin/orders/${createdOrderId}/status`, {
        method: "PATCH",
        token: seeded.adminToken,
        body: { orderStatus: "cancelled" },
      });
      assert(res.status === 409, "delivered order cancelled");
    });

    await test("Out-of-stock order attempt leaves cart intact", async () => {
      await request("/api/cart/items", {
        method: "POST",
        token: seeded.otherToken,
        body: { productId: seeded.productB._id, quantity: 1 },
      });
      await productModel.findByIdAndUpdate(seeded.productB._id, { pQuantity: 0 });
      const res = await request("/api/order/create-cod-order", {
        method: "POST",
        token: seeded.otherToken,
        headers: { "Idempotency-Key": `${TEST_PREFIX}out-of-stock` },
        body: { shippingAddress },
      });
      const cart = await cartModel.findOne({ user: seeded.other._id });
      assert(res.status === 409, "out-of-stock order should fail");
      assert(cart.items.length > 0, "cart was cleared after failed order");
      await productModel.findByIdAndUpdate(seeded.productB._id, { pQuantity: 5 });
    });

    await test("Failed order creation compensates any partial stock deduction", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.other._id },
        { user: seeded.other._id, items: [{ product: seeded.productB._id, quantity: 1 }] },
        { upsert: true, new: true }
      );
      const originalCreate = orderModel.create;
      orderModel.create = async () => {
        throw new Error("forced order save failure");
      };
      const before = await productModel.findById(seeded.productB._id);
      let failed = false;
      try {
        await orderService.createCodOrder(
          String(seeded.other._id),
          { shippingAddress },
          `${TEST_PREFIX}forced-fail`
        );
      } catch (err) {
        failed = true;
      } finally {
        orderModel.create = originalCreate;
      }
      const after = await productModel.findById(seeded.productB._id);
      assert(failed, "forced failure did not throw");
      assert(after.pQuantity === before.pQuantity, "stock was not compensated");
    });

    await test("Braintree endpoints remain 503", async () => {
      const token = await request("/api/braintree/get-token", { method: "POST" });
      const payment = await request("/api/braintree/payment", { method: "POST", body: {} });
      assert(token.status === 503, "Braintree token enabled");
      assert(payment.status === 503, "Braintree payment enabled");
    });

    await test("Legacy /api/order/create-order remains 503", async () => {
      const res = await request("/api/order/create-order", { method: "POST", body: {} });
      assert(res.status === 503, "legacy order creation enabled");
    });

    await test("Password and secret fields remain absent", async () => {
      const res = await request("/api/order/admin/orders", { token: seeded.adminToken });
      assert(!JSON.stringify(res.body).includes("password"), "password leaked");
      assert(!JSON.stringify(res.body).includes("secretKey"), "secretKey leaked");
    });

    await test("All Phase 2C test records are cleaned", async () => {
      await cleanup();
      const remainingUsers = await userModel.countDocuments({ email: new RegExp(`^${TEST_PREFIX}`) });
      const remainingProducts = await productModel.countDocuments({ pName: new RegExp(`^${TEST_PREFIX}`) });
      const remainingOrders = await orderModel.countDocuments({ idempotencyKey: new RegExp(`^${TEST_PREFIX}`) });
      assert(remainingUsers === 0, "users not cleaned");
      assert(remainingProducts === 0, "products not cleaned");
      assert(remainingOrders === 0, "orders not cleaned");
    });

    await test("No remote database or payment provider is contacted", async () => {
      assert(process.env.DATABASE.includes("127.0.0.1"), "database is not local");
      assert(process.env.ENABLE_LEGACY_BRAINTREE === "false", "Braintree enabled");
    });

    console.log("COMMERCE_SMOKE_PASS");
  } finally {
    await cleanup().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server && !server.killed) {
      server.kill();
    }
  }
}

main().catch((error) => {
  console.error(`COMMERCE_SMOKE_FAIL: ${error.message}`);
  process.exitCode = 1;
});
