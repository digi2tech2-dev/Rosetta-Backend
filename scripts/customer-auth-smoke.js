const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, connectDatabase } = require("../app");
const userModel = require("../models/users");
const orderModel = require("../models/orders");
const { config } = require("../config/appConfig");
const { clearFakeMessages, getFakeMessages, sendPasswordResetCode } = require("../services/mailService");
const { hmac } = require("../services/passwordResetService");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");

const REQUIRED_DB = process.env.CUSTOMER_AUTH_SMOKE_DATABASE_NAME || "client_store_phase2h_disposable";
const PORT = Number(process.env.PORT || 8030);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2h-smoke-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function containsSensitiveKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  return Object.keys(value).some((key) => {
    if ([
      "password",
      "secretKey",
      "resetCodeHash",
      "resetCodeExpiresAt",
      "resetCodeAttempts",
      "resetCodeRequestedAt",
      "resetTokenHash",
      "resetTokenExpiresAt",
      "tokenVersion",
    ].includes(key)) return true;
    return containsSensitiveKey(value[key]);
  });
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body === undefined
      ? undefined
      : options.body instanceof FormData
      ? options.body
      : JSON.stringify(options.body),
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

async function cleanup() {
  await orderModel.deleteMany({ transactionId: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ email: new RegExp(`^${TEST_PREFIX}`) });
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required");
  assert(process.env.PASSWORD_RESET_PEPPER && process.env.PASSWORD_RESET_PEPPER.length >= 16, "PASSWORD_RESET_PEPPER is required");

  await connectDatabase();
  await cleanup();
  clearFakeMessages();
  const server = app.listen(PORT);
  const results = [];

  async function test(name, fn) {
    await fn();
    results.push({ name, result: "PASS" });
  }

  let admin;
  let customer;
  let customerToken;
  let adminToken;
  let changedPasswordToken;
  let addressId;
  let resetToken;

  try {
    admin = await userModel.create({
      name: "Phase2H Admin",
      email: `${TEST_PREFIX}admin@example.com`,
      password: bcrypt.hashSync("AdminPassword123!", 10),
      userRole: 1,
      status: "active",
    });
    await orderModel.create([
      { user: admin._id, allProduct: [], transactionId: `${TEST_PREFIX}admin-order`, amount: 1 },
    ]);

    await test("Customer signup defaults active and ignores role/status injection", async () => {
      const res = await request("/api/signup", {
        method: "POST",
        body: {
          name: "Phase2H Customer",
          email: `${TEST_PREFIX}customer@example.com`,
          password: "CustomerPassword123!",
          cPassword: "CustomerPassword123!",
          userRole: 1,
          status: "blocked",
          verified: true,
        },
      });
      assert(res.status === 201, "signup should return 201");
      assert(res.body.user.userRole === 0, "signup elevated role");
      assert(res.body.user.status === "active", "signup did not default active");
      assert(res.body.user.verified === false, "signup trusted verified");
      assert(!containsSensitiveKey(res.body), "signup leaked sensitive fields");
      customer = await userModel.findOne({ email: `${TEST_PREFIX}customer@example.com` });
    });

    await test("Login succeeds with database role and token version", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "CustomerPassword123!" },
      });
      assert(res.status === 200, "login should return 200");
      assert(res.body.token, "login token missing");
      customerToken = res.body.token;
      const decoded = jwt.verify(customerToken, config.jwtSecret);
      assert(decoded.tokenVersion === 0, "token version missing");
    });

    await test("Invalid login uses generic failure", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "WrongPassword123!" },
      });
      assert(res.status === 401, "invalid login should return 401");
      assert(String(res.body.error).toLowerCase().includes("invalid"), "invalid login message should be generic");
    });

    await test("Customer cannot access admin customer routes", async () => {
      const res = await request("/api/admin/users", { token: customerToken });
      assert(res.status === 403, "customer admin access should be forbidden");
    });

    await test("Admin login succeeds", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: { email: admin.email, password: "AdminPassword123!" },
      });
      assert(res.status === 200, "admin login should return 200");
      adminToken = res.body.token;
    });

    await test("Get profile is sanitized", async () => {
      const res = await request("/api/users/me", { token: customerToken });
      assert(res.status === 200, "profile should return 200");
      assert(res.body.user.email === customer.email, "profile email mismatch");
      assert(Array.isArray(res.body.user.addresses), "profile addresses missing");
      assert(!containsSensitiveKey(res.body), "profile leaked sensitive fields");
    });

    await test("Profile update allowlist rejects role/status/verified modification", async () => {
      const res = await request("/api/users/me", {
        method: "PATCH",
        token: customerToken,
        body: { name: "Phase2H Updated", phone: "01000000000", userRole: 1, status: "blocked", verified: true },
      });
      assert(res.status === 200, "profile update should return 200");
      const updated = await userModel.findById(customer._id);
      assert(updated.userRole === 0, "profile changed role");
      assert(updated.status === "active", "profile changed status");
      assert(updated.verified === false, "profile changed verified");
      assert(updated.phone === "01000000000", "profile phone not saved");
    });

    await test("Email change is controlled and unsupported by approved form", async () => {
      const res = await request("/api/users/me", {
        method: "PATCH",
        token: customerToken,
        body: { email: `${TEST_PREFIX}new-email@example.com` },
      });
      assert(res.status === 400, "email change should be rejected");
      assert(res.body.code === "EMAIL_CHANGE_NOT_SUPPORTED", "email change code mismatch");
    });

    await test("Address add stores one default", async () => {
      const res = await request("/api/users/me/addresses", {
        method: "POST",
        token: customerToken,
        body: {
          label: "Home",
          fullName: "Phase2H Customer",
          phone: "01000000000",
          alternatePhone: "01100000000",
          governorate: "Cairo",
          city: "Nasr City",
          street: "Test street",
          notes: "Door code",
          tokenVersion: 999,
          secretKey: "do-not-store",
        },
      });
      assert(res.status === 201, "address add should return 201");
      assert(res.body.addresses.length === 1, "address not returned");
      assert(res.body.addresses[0].isDefault === true, "first address should default");
      assert(!Object.prototype.hasOwnProperty.call(res.body.addresses[0], "secretKey"), "address stored arbitrary field");
      addressId = res.body.addresses[0]._id;
    });

    await test("Address edit and default preserve one default", async () => {
      const addSecond = await request("/api/users/me/addresses", {
        method: "POST",
        token: customerToken,
        body: {
          label: "Office",
          fullName: "Phase2H Customer",
          phone: "01000000001",
          governorate: "Giza",
          city: "Dokki",
          street: "Office street",
        },
      });
      const secondId = addSecond.body.addresses.find((address) => address.label === "Office")._id;
      const setDefault = await request(`/api/users/me/addresses/${secondId}/default`, {
        method: "PATCH",
        token: customerToken,
      });
      assert(setDefault.status === 200, "set default should return 200");
      assert(setDefault.body.addresses.filter((address) => address.isDefault).length === 1, "multiple defaults found");
      const edit = await request(`/api/users/me/addresses/${addressId}`, {
        method: "PATCH",
        token: customerToken,
        body: {
          fullName: "Phase2H Customer",
          phone: "01000000000",
          governorate: "Cairo",
          city: "Heliopolis",
          street: "Updated street",
        },
      });
      assert(edit.status === 200, "address edit should return 200");
      assert(edit.body.addresses.some((address) => address.street === "Updated street"), "address edit not saved");
    });

    await test("Another user's address id cannot be used", async () => {
      const other = await userModel.create({
        name: "Phase2H Other Customer",
        email: `${TEST_PREFIX}other-customer@example.com`,
        password: bcrypt.hashSync("OtherPassword123!", 10),
        userRole: 0,
        status: "active",
        addresses: [{
          label: "Other",
          fullName: "Other Customer",
          phone: "01000000002",
          governorate: "Cairo",
          city: "Nasr City",
          street: "Other street",
          isDefault: true,
        }],
      });
      const otherAddressId = other.addresses[0]._id;
      const res = await request(`/api/users/me/addresses/${otherAddressId}`, {
        method: "DELETE",
        token: customerToken,
      });
      assert(res.status === 404, "foreign address id should be scoped out");
      const stillThere = await userModel.findById(other._id);
      assert(stillThere.addresses.id(otherAddressId), "foreign address was deleted");
    });

    await test("Deleting default promotes another address and deleting final address is safe", async () => {
      let current = await userModel.findById(customer._id);
      const defaultAddress = current.addresses.find((address) => address.isDefault);
      assert(defaultAddress, "default address missing before delete");
      const deletedDefault = await request(`/api/users/me/addresses/${defaultAddress._id}`, {
        method: "DELETE",
        token: customerToken,
      });
      assert(deletedDefault.status === 200, "delete default should return 200");
      assert(deletedDefault.body.addresses.length === 1, "one address should remain");
      assert(deletedDefault.body.addresses[0].isDefault === true, "remaining address should be promoted");
      const lastId = deletedDefault.body.addresses[0]._id;
      const deletedLast = await request(`/api/users/me/addresses/${lastId}`, {
        method: "DELETE",
        token: customerToken,
      });
      assert(deletedLast.status === 200, "delete final address should return 200");
      assert(Array.isArray(deletedLast.body.addresses) && deletedLast.body.addresses.length === 0, "final delete should return empty addresses");
    });

    await test("Foreign or malformed address id is rejected", async () => {
      const res = await request("/api/users/me/addresses/not-an-id", {
        method: "DELETE",
        token: customerToken,
      });
      assert(res.status === 400, "malformed address id should return 400");
    });

    await test("Password change requires current password and invalidates old token", async () => {
      const wrong = await request("/api/users/me/password", {
        method: "PATCH",
        token: customerToken,
        body: { oldPassword: "WrongPassword123!", newPassword: "ChangedPassword123!", confirmPassword: "ChangedPassword123!" },
      });
      assert(wrong.status === 401, "wrong current password should return 401");
      const changed = await request("/api/users/me/password", {
        method: "PATCH",
        token: customerToken,
        body: { oldPassword: "CustomerPassword123!", newPassword: "ChangedPassword123!", confirmPassword: "ChangedPassword123!" },
      });
      assert(changed.status === 200, "password change should return 200");
      const oldToken = await request("/api/users/me", { token: customerToken });
      assert(oldToken.status === 401 && oldToken.body.code === "SESSION_EXPIRED", "old token should be expired");
      const login = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "ChangedPassword123!" },
      });
      assert(login.status === 200, "new password login failed");
      changedPasswordToken = login.body.token;
    });

    await test("Forgot password has generic response for unknown email", async () => {
      const res = await request("/api/forgot-password", {
        method: "POST",
        body: { email: `${TEST_PREFIX}unknown@example.com` },
      });
      assert(res.status === 200, "unknown forgot should return 200");
      assert(res.body.message, "generic message missing");
    });

    await test("Forgot password public response shape does not enumerate account state", async () => {
      const blocked = await userModel.create({
        name: "Phase2H Blocked",
        email: `${TEST_PREFIX}blocked@example.com`,
        password: bcrypt.hashSync("BlockedPassword123!", 10),
        userRole: 0,
        status: "blocked",
      });
      await userModel.findByIdAndUpdate(customer._id, { resetCodeRequestedAt: new Date() });
      const cases = [
        { email: `${TEST_PREFIX}unknown-shape@example.com` },
        { email: blocked.email },
        { email: customer.email },
      ];
      const responses = [];
      for (const body of cases) {
        responses.push(await request("/api/forgot-password", { method: "POST", body }));
      }
      const shape = JSON.stringify(responses[0].body);
      responses.forEach((res) => {
        assert(res.status === 200, "forgot-password public status differed");
        assert(JSON.stringify(res.body) === shape, "forgot-password public body differed");
      });
      await userModel.findByIdAndUpdate(customer._id, { resetCodeRequestedAt: null });
    });

    await test("Forgot password stores hashed code and fake mail receives code", async () => {
      const res = await request("/api/forgot-password", {
        method: "POST",
        body: { email: customer.email },
      });
      assert(res.status === 200, "forgot should return 200");
      const messages = getFakeMessages();
      const message = messages.find((item) => item.to === customer.email);
      assert(message && /^\d{6}$/.test(message.code), "fake mail code missing");
      const stored = await userModel.findById(customer._id).select("+resetCodeHash +resetCodeExpiresAt +resetCodeAttempts");
      assert(stored.resetCodeHash && stored.resetCodeHash !== message.code, "reset code stored in plaintext");
      assert(stored.resetCodeAttempts === 0, "reset attempts not reset");
    });

    await test("Wrong reset code increments attempts", async () => {
      const res = await request("/api/verify-reset-code", {
        method: "POST",
        body: { email: customer.email, code: "000000" },
      });
      assert(res.status === 400, "wrong code should return 400");
      const stored = await userModel.findById(customer._id).select("+resetCodeAttempts");
      assert(stored.resetCodeAttempts === 1, "wrong attempt not counted");
    });

    await test("Reset code attempt limit invalidates further verification", async () => {
      const code = "333333";
      await userModel.findByIdAndUpdate(customer._id, {
        resetCodeHash: hmac(code),
        resetCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        resetCodeAttempts: config.passwordResetMaxAttempts - 1,
      });
      const wrong = await request("/api/verify-reset-code", {
        method: "POST",
        body: { email: customer.email, code: "333334" },
      });
      assert(wrong.status === 400, "limit-reaching wrong code should return 400");
      const correctAfterLimit = await request("/api/verify-reset-code", {
        method: "POST",
        body: { email: customer.email, code },
      });
      assert(correctAfterLimit.status === 400, "correct code after limit should remain invalid");
    });

    await test("Expired reset code is rejected", async () => {
      await userModel.findByIdAndUpdate(customer._id, {
        resetCodeHash: hmac("111111"),
        resetCodeExpiresAt: new Date(Date.now() - 1000),
        resetCodeAttempts: 0,
      });
      const res = await request("/api/verify-reset-code", {
        method: "POST",
        body: { email: customer.email, code: "111111" },
      });
      assert(res.status === 400, "expired code should return 400");
    });

    await test("Valid reset code issues one-time reset token", async () => {
      const code = "222222";
      await userModel.findByIdAndUpdate(customer._id, {
        resetCodeHash: hmac(code),
        resetCodeExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
        resetCodeAttempts: 0,
      });
      const res = await request("/api/verify-reset-code", {
        method: "POST",
        body: { email: customer.email, code },
      });
      assert(res.status === 200, "valid code should return 200");
      assert(res.body.resetToken && res.body.resetToken !== code, "reset token missing");
      resetToken = res.body.resetToken;
      const stored = await userModel.findById(customer._id).select("+resetTokenHash +resetCodeHash");
      assert(stored.resetTokenHash && stored.resetTokenHash !== resetToken, "reset token stored plaintext");
      assert(!stored.resetCodeHash, "reset code not consumed");
    });

    await test("Invalid reset token is rejected", async () => {
      const res = await request("/api/reset-password", {
        method: "POST",
        body: {
          email: customer.email,
          resetToken: "bad-token",
          newPassword: "ResetPassword123!",
          confirmPassword: "ResetPassword123!",
        },
      });
      assert(res.status === 400, "invalid reset token should return 400");
    });

    await test("Password reset succeeds once and invalidates existing JWT", async () => {
      const res = await request("/api/reset-password", {
        method: "POST",
        body: {
          email: customer.email,
          resetToken,
          newPassword: "ResetPassword123!",
          confirmPassword: "ResetPassword123!",
        },
      });
      assert(res.status === 200, "password reset should return 200");
      const reuse = await request("/api/reset-password", {
        method: "POST",
        body: {
          email: customer.email,
          resetToken,
          newPassword: "AnotherPassword123!",
          confirmPassword: "AnotherPassword123!",
        },
      });
      assert(reuse.status === 400, "reset token should be one-time");
      const oldToken = await request("/api/users/me", { token: changedPasswordToken });
      assert(oldToken.status === 401, "password reset should expire existing JWT");
    });

    await test("Production configuration cannot use fake mail transport", async () => {
      const original = {
        nodeEnv: config.nodeEnv,
        mailTransport: config.mailTransport,
        smtpHost: config.smtpHost,
      };
      config.nodeEnv = "production";
      config.mailTransport = "fake";
      config.smtpHost = "";
      let failedClosed = false;
      try {
        await sendPasswordResetCode({ to: "nobody@example.com", code: "999999" });
      } catch (err) {
        failedClosed = err.message === "SMTP_HOST is not configured";
      } finally {
        config.nodeEnv = original.nodeEnv;
        config.mailTransport = original.mailTransport;
        config.smtpHost = original.smtpHost;
      }
      assert(failedClosed, "production fake mail transport did not fail closed");
    });

    await test("Blocked login is rejected and blocked status survives reset", async () => {
      await userModel.findByIdAndUpdate(customer._id, { status: "blocked" });
      const login = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "ResetPassword123!" },
      });
      assert(login.status === 403 && login.body.code === "ACCOUNT_BLOCKED", "blocked login should be rejected");
      await userModel.findByIdAndUpdate(customer._id, { status: "active" });
    });

    await test("Admin customer list is sanitized and server-calculated", async () => {
      await orderModel.create([
        { user: customer._id, allProduct: [], transactionId: `${TEST_PREFIX}order-1`, total: 100, amount: 100, orderStatus: "delivered" },
        { user: customer._id, allProduct: [], transactionId: `${TEST_PREFIX}order-2`, total: 50, amount: 50, orderStatus: "cancelled" },
      ]);
      const res = await request("/api/admin/users", { token: adminToken });
      assert(res.status === 200, "admin list should return 200");
      const row = res.body.customers.find((item) => item.email === customer.email);
      assert(row, "customer missing from list");
      assert(row.ordersCount >= 2, "order count missing");
      assert(row.totalSpent >= 100, "total spent not calculated");
      assert(!containsSensitiveKey(res.body), "admin list leaked secrets");
    });

    await test("Admin customer details include recent orders and no secrets", async () => {
      const res = await request(`/api/admin/users/${customer._id}`, { token: adminToken });
      assert(res.status === 200, "admin details should return 200");
      assert(Array.isArray(res.body.user.recentOrders), "recent orders missing");
      assert(!containsSensitiveKey(res.body), "admin details leaked secrets");
    });

    await test("Admin cannot target admins or self through customer status route", async () => {
      const otherAdmin = await userModel.create({
        name: "Phase2H Other Admin",
        email: `${TEST_PREFIX}other-admin@example.com`,
        password: bcrypt.hashSync("AdminPassword123!", 10),
        userRole: 1,
        status: "active",
      });
      const targetAdmin = await request(`/api/admin/users/${admin._id}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "blocked" },
      });
      assert(targetAdmin.status === 400, "self target should be rejected");
      assert(targetAdmin.body.code === "SELF_STATUS_CHANGE_NOT_ALLOWED", "self target code mismatch");
      const otherAdminTarget = await request(`/api/admin/users/${otherAdmin._id}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "blocked" },
      });
      assert(otherAdminTarget.status === 400 || otherAdminTarget.status === 404, "admin target should be rejected");
      assert(["ADMIN_TARGET_NOT_ALLOWED", "CUSTOMER_NOT_FOUND"].includes(otherAdminTarget.body.code), "admin target code mismatch");
    });

    await test("Block increments token version and immediately blocks active sessions", async () => {
      const login = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "ResetPassword123!" },
      });
      const activeToken = login.body.token;
      const block = await request(`/api/admin/users/${customer._id}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "blocked", reason: "Smoke test", userRole: 1, verified: true },
      });
      assert(block.status === 200, "block should return 200");
      const blockedCustomer = await userModel.findById(customer._id);
      assert(blockedCustomer.userRole === 0, "status route changed customer role");
      assert(blockedCustomer.verified === false, "status route changed verified");
      const blocked = await request("/api/users/me", { token: activeToken });
      assert(blocked.status === 403 && blocked.body.code === "ACCOUNT_BLOCKED", "blocked token should fail immediately");
    });

    await test("Activate does not restore old blocked token", async () => {
      const activate = await request(`/api/admin/users/${customer._id}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "active" },
      });
      assert(activate.status === 200, "activate should return 200");
      const old = await request("/api/users/me", { token: changedPasswordToken });
      assert(old.status === 401, "old token should not revive");
    });

    await test("Legacy user missing status/tokenVersion behaves as active zero-version", async () => {
      const legacy = await userModel.collection.insertOne({
        name: "Phase2H Legacy",
        email: `${TEST_PREFIX}legacy@example.com`,
        password: bcrypt.hashSync("LegacyPassword123!", 10),
        userRole: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const legacyToken = jwt.sign({ _id: String(legacy.insertedId), role: 0 }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
      const profile = await request("/api/users/me", { token: legacyToken });
      assert(profile.status === 200, "legacy token should work when db tokenVersion missing");
      assert(profile.body.user.status === "active", "legacy missing status should serialize active");
      assert(Array.isArray(profile.body.user.addresses), "legacy addresses should default empty");
      const update = await request("/api/users/me", {
        method: "PATCH",
        token: legacyToken,
        body: { name: "Phase2H Legacy Updated", phone: "01000000003", userRole: 1 },
      });
      assert(update.status === 200, "legacy profile update should work");
      const addAddress = await request("/api/users/me/addresses", {
        method: "POST",
        token: legacyToken,
        body: {
          fullName: "Phase2H Legacy Updated",
          phone: "01000000003",
          governorate: "Cairo",
          city: "Nasr City",
          street: "Legacy street",
        },
      });
      assert(addAddress.status === 201, "legacy address add should work");
      const block = await request(`/api/admin/users/${legacy.insertedId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "blocked" },
      });
      assert(block.status === 200, "legacy block should work");
      const blockedLegacyToken = await request("/api/users/me", { token: legacyToken });
      assert(blockedLegacyToken.status === 403, "blocking legacy user should invalidate token immediately");
      const activate = await request(`/api/admin/users/${legacy.insertedId}/status`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "active" },
      });
      assert(activate.status === 200, "legacy activate should work");
      const revivedLegacyToken = await request("/api/users/me", { token: legacyToken });
      assert(revivedLegacyToken.status === 401, "activating legacy user should not revive old token");
    });

    await test("Legacy disabled status behaves as blocked", async () => {
      const legacy = await userModel.collection.insertOne({
        name: "Phase2H Disabled Legacy",
        email: `${TEST_PREFIX}disabled-legacy@example.com`,
        password: bcrypt.hashSync("LegacyPassword123!", 10),
        userRole: 0,
        status: "disabled",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const legacyToken = jwt.sign({ _id: String(legacy.insertedId), role: 0 }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
      const profile = await request("/api/users/me", { token: legacyToken });
      assert(profile.status === 403 && profile.body.code === "ACCOUNT_BLOCKED", "legacy disabled should be blocked");
    });

    await test("Avatar upload accepts image multipart and rejects bad MIME", async () => {
      const login = await request("/api/signin", {
        method: "POST",
        body: { email: customer.email, password: "ResetPassword123!" },
      });
      const good = new FormData();
      good.append("avatar", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "avatar.jpg");
      const uploaded = await request("/api/users/me/avatar", {
        method: "PATCH",
        token: login.body.token,
        body: good,
      });
      assert(uploaded.status === 200, "valid avatar upload should return 200");
      assert(uploaded.body.avatar && uploaded.body.avatar.includes("/uploads/avatars/"), "avatar response should include safe relative path");
      const bad = new FormData();
      bad.append("avatar", new Blob(["bad"], { type: "text/plain" }), "avatar.txt");
      const rejected = await request("/api/users/me/avatar", {
        method: "PATCH",
        token: login.body.token,
        body: bad,
      });
      assert(rejected.status === 400, "bad avatar MIME should be rejected");
      const mismatch = new FormData();
      mismatch.append("avatar", new Blob(["png-ish"], { type: "image/png" }), "avatar.txt");
      const mismatched = await request("/api/users/me/avatar", {
        method: "PATCH",
        token: login.body.token,
        body: mismatch,
      });
      assert(mismatched.status === 400, "avatar MIME/extension mismatch should be rejected");
      const oversized = new FormData();
      oversized.append("avatar", new Blob([Buffer.alloc(3 * 1024 * 1024)], { type: "image/png" }), "large.png");
      const tooLarge = await request("/api/users/me/avatar", {
        method: "PATCH",
        token: login.body.token,
        body: oversized,
      });
      assert(tooLarge.status === 413, "oversized avatar should be rejected");
    });

    await cleanup();
    console.log(`Customer auth smoke: ${results.length} passed`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await cleanup();
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error(err.message);
  try {
    await cleanup();
    await mongoose.connection.close();
  } catch (cleanupErr) {}
  process.exit(1);
});
