const { spawn } = require("child_process");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const userModel = require("../models/users");
const orderModel = require("../models/orders");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");

const REQUIRED_DB = process.env.SECURITY_SMOKE_DATABASE_NAME || "client_store_phase2a_disposable";
const PORT = Number(process.env.PORT || 8020);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2a-smoke-";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsSensitiveKey);
  }
  return Object.keys(value).some((key) => {
    if (["password", "secretKey", "JWT_SECRET", "BRAINTREE_PRIVATE_KEY"].includes(key)) {
      return true;
    }
    return containsSensitiveKey(value[key]);
  });
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
      const response = await fetch(`${BASE_URL}/api/category/all-category`);
      if (response.status < 500) {
        return;
      }
    } catch (err) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become ready");
}

function startServer() {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(PORT),
    ENABLE_LEGACY_BRAINTREE: "false",
    AUTH_RATE_LIMIT_MAX: process.env.AUTH_RATE_LIMIT_MAX || "200",
  };
  const child = spawn(process.execPath, ["app.js"], {
    cwd: __dirname + "/..",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
  });
  return child;
}

async function cleanup() {
  await orderModel.deleteMany({ transactionId: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ email: new RegExp(`^${TEST_PREFIX}`) });
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, {
    requiredDatabaseName: REQUIRED_DB,
  });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required for smoke tests");

  const server = startServer();
  let customerToken;
  let adminToken;
  let customerUser;
  let victimUser;
  let adminUser;

  try {
    await waitForServer();

    await mongoose.connect(process.env.DATABASE, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
    });
    await cleanup();

    adminUser = await userModel.create({
      name: "Phase2A Admin",
      email: `${TEST_PREFIX}admin@example.com`,
      password: bcrypt.hashSync("AdminPassword123!", 10),
      userRole: 1,
    });
    victimUser = await userModel.create({
      name: "Phase2A Victim",
      email: `${TEST_PREFIX}victim@example.com`,
      password: bcrypt.hashSync("VictimPassword123!", 10),
      userRole: 0,
    });
    await orderModel.create({
      allProduct: [],
      user: victimUser._id,
      amount: 123,
      transactionId: `${TEST_PREFIX}victim-order`,
      address: "Fictional address",
      phone: 1000000000,
    });

    const results = [];
    async function test(name, fn) {
      await fn();
      results.push({ name, result: "PASS" });
    }

    await test("Public signup creates a customer, not an admin", async () => {
      const res = await request("/api/signup", {
        method: "POST",
        body: {
          name: "Phase2A Customer",
          email: `${TEST_PREFIX}customer@example.com`,
          password: "CustomerPassword123!",
          cPassword: "CustomerPassword123!",
        },
      });
      assert(res.status === 201, "signup should return 201");
      assert(res.body.user.userRole === 0, "signup userRole should be 0");
      customerUser = res.body.user;
    });

    await test("Signup response does not contain password or secretKey", async () => {
      assert(!containsSensitiveKey(customerUser), "signup user exposed sensitive fields");
    });

    await test("Supplying userRole during signup does not elevate privileges", async () => {
      const res = await request("/api/signup", {
        method: "POST",
        body: {
          name: "Phase2A Role Attempt",
          email: `${TEST_PREFIX}role-attempt@example.com`,
          password: "CustomerPassword123!",
          cPassword: "CustomerPassword123!",
          userRole: 1,
        },
      });
      assert(res.status === 201, "role-attempt signup should return 201");
      assert(res.body.user.userRole === 0, "role-attempt signup should stay customer");
      assert(!containsSensitiveKey(res.body), "role-attempt response exposed sensitive fields");
    });

    await test("Signin response does not contain password or secretKey", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: {
          email: `${TEST_PREFIX}customer@example.com`,
          password: "CustomerPassword123!",
        },
      });
      assert(res.status === 200, "signin should return 200");
      assert(res.body.token, "signin should return token");
      assert(!containsSensitiveKey(res.body), "signin response exposed sensitive fields");
      customerToken = res.body.token;
    });

    await test("Invalid credentials return 401 without server crash", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: {
          email: `${TEST_PREFIX}customer@example.com`,
          password: "WrongPassword123!",
        },
      });
      assert(res.status === 401, "invalid credentials should return 401");
    });

    await test("Missing token on a protected route returns 401", async () => {
      const res = await request("/api/user/all-user");
      assert(res.status === 401, "missing token should return 401");
    });

    await test("Invalid token returns 401", async () => {
      const res = await request("/api/user/all-user", {
        token: "invalid-token",
      });
      assert(res.status === 401, "invalid token should return 401");
    });

    await test("Normal customer accessing an admin route returns 403", async () => {
      const res = await request("/api/user/all-user", {
        token: customerToken,
      });
      assert(res.status === 403, "customer admin route should return 403");
    });

    await test("Denied middleware does not continue into the controller", async () => {
      const res = await request("/api/product/add-product", {
        method: "POST",
        token: customerToken,
        body: {},
      });
      assert(res.status === 403, "denied product write should return 403");
      assert(!res.body.success, "denied request should not reach controller success");
    });

    await test("Admin can access one representative admin route", async () => {
      const signin = await request("/api/signin", {
        method: "POST",
        body: {
          email: `${TEST_PREFIX}admin@example.com`,
          password: "AdminPassword123!",
        },
      });
      assert(signin.status === 200, "admin signin should return 200");
      adminToken = signin.body.token;
      const res = await request("/api/user/all-user", {
        token: adminToken,
      });
      assert(res.status === 200, "admin route should return 200");
      assert(!containsSensitiveKey(res.body), "admin user list exposed sensitive fields");
    });

    await test("Product write without authentication returns 401", async () => {
      const res = await request("/api/product/add-product", {
        method: "POST",
        body: {},
      });
      assert(res.status === 401, "product write without auth should return 401");
    });

    await test("Product write by a customer returns 403", async () => {
      const res = await request("/api/product/add-product", {
        method: "POST",
        token: customerToken,
        body: {},
      });
      assert(res.status === 403, "product write by customer should return 403");
    });

    await test("User listing without authentication returns 401", async () => {
      const res = await request("/api/user/all-user");
      assert(res.status === 401, "user listing without auth should return 401");
    });

    await test("Customer cannot request another user's private profile", async () => {
      const res = await request("/api/user/signle-user", {
        method: "POST",
        token: customerToken,
        body: { uId: String(victimUser._id) },
      });
      assert(res.status === 403, "other profile should return 403");
    });

    await test("Customer order history ignores another user ID from the body", async () => {
      const res = await request("/api/order/order-by-user", {
        method: "POST",
        token: customerToken,
        body: { uId: String(victimUser._id) },
      });
      assert(res.status === 200, "customer order history should return 200");
      const returnedVictimOrder = (res.body.Order || []).some(
        (order) => String(order.user && order.user._id ? order.user._id : order.user) === String(victimUser._id)
      );
      assert(!returnedVictimOrder, "customer received another user's order");
    });

    await test("Braintree token endpoint returns 503 while disabled", async () => {
      const res = await request("/api/braintree/get-token", { method: "POST" });
      assert(res.status === 503, "Braintree token should return 503");
      assert(res.body.code === "LEGACY_BRAINTREE_DISABLED", "Braintree token code mismatch");
    });

    await test("Braintree payment endpoint returns 503 while disabled", async () => {
      const res = await request("/api/braintree/payment", {
        method: "POST",
        body: { amountTotal: "1.00", paymentMethod: "fake-nonce" },
      });
      assert(res.status === 503, "Braintree payment should return 503");
      assert(res.body.code === "LEGACY_BRAINTREE_DISABLED", "Braintree payment code mismatch");
    });

    await test("Legacy order creation returns 503", async () => {
      const res = await request("/api/order/create-order", {
        method: "POST",
        body: {},
      });
      assert(res.status === 503, "legacy order creation should return 503");
      assert(res.body.code === "LEGACY_ORDER_CREATION_DISABLED", "legacy order code mismatch");
    });

    await test("Password hashes are absent from all tested user responses", async () => {
      const profile = await request("/api/user/signle-user", {
        method: "POST",
        token: customerToken,
        body: { uId: customerUser._id },
      });
      assert(profile.status === 200, "self profile should return 200");
      assert(!containsSensitiveKey(profile.body), "profile exposed sensitive fields");
    });

    await test("All created test users and records are removed afterward", async () => {
      await cleanup();
      const remainingUsers = await userModel.countDocuments({ email: new RegExp(`^${TEST_PREFIX}`) });
      const remainingOrders = await orderModel.countDocuments({ transactionId: new RegExp(`^${TEST_PREFIX}`) });
      assert(remainingUsers === 0, "test users were not cleaned up");
      assert(remainingOrders === 0, "test orders were not cleaned up");
    });

    results.forEach((result, index) => {
      console.log(`${index + 1}. ${result.name}: ${result.result}`);
    });
    console.log("SECURITY_SMOKE_PASS");
  } catch (err) {
    console.error(`SECURITY_SMOKE_FAIL: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try {
      if (mongoose.connection.readyState === 1) {
        await cleanup();
      }
    } catch (err) {
      console.error("Cleanup failed");
    }
    await mongoose.disconnect();
    server.kill();
  }
}

main();
