process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || "200";

const { spawnSync } = require("child_process");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { app, connectDatabase } = require("../app");
const userModel = require("../models/users");
const orderModel = require("../models/orders");
const { config } = require("../config/appConfig");
const { hmac } = require("../services/passwordResetService");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");

const REQUIRED_DB = process.env.GOOGLE_AUTH_SMOKE_DATABASE_NAME || "client_store_phase2l_disposable";
const PORT = Number(process.env.PORT || 8037);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2l-google-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function containsForbiddenKey(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
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
      "authProviders",
      "credential",
      "rawClaims",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "sub",
    ].includes(key)) return true;
    return containsForbiddenKey(value[key]);
  });
}

function fakeCredential(payload = {}) {
  const fullPayload = {
    iss: "https://accounts.google.com",
    aud: config.googleClientId,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: `${TEST_PREFIX}sub-default`,
    email: `${TEST_PREFIX}default@example.com`,
    email_verified: true,
    name: "Phase2L Google Customer",
    ...payload,
  };
  return `fake:${Buffer.from(JSON.stringify(fullPayload)).toString("base64url")}`;
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

async function cleanup() {
  await orderModel.deleteMany({ transactionId: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ email: new RegExp(`^${TEST_PREFIX}`) });
}

function assertConfigRejects(name, env) {
  const script = "try { require('./config/appConfig').validateConfig(); process.exit(0); } catch (err) { process.exit(42); }";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: __dirname + "/..",
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert(result.status === 42, `${name} should fail closed`);
}

function assertConfigAccepts(name, env) {
  const script = "try { require('./config/appConfig').validateConfig(); process.exit(0); } catch (err) { console.error(err.message); process.exit(42); }";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: __dirname + "/..",
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert(result.status === 0, `${name} should be accepted: ${result.stderr}`);
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required");
  assert(process.env.PASSWORD_RESET_PEPPER && process.env.PASSWORD_RESET_PEPPER.length >= 16, "PASSWORD_RESET_PEPPER is required");
  assert(config.nodeEnv === "test", "google smoke must run under NODE_ENV=test");
  assert(config.googleAuthEnabled === true, "GOOGLE_AUTH_ENABLED=true is required");
  assert(config.googleAuthVerifier === "fake", "GOOGLE_AUTH_VERIFIER=fake is required for smoke");

  await connectDatabase();
  await cleanup();
  const server = app.listen(PORT);
  const results = [];

  async function test(name, fn) {
    await fn();
    results.push({ name, result: "PASS" });
  }

  let googleUser;
  let googleToken;
  let localUser;
  let localPasswordToken;
  let resetToken;

  try {
    await test("Configuration defaults and fail-closed checks", async () => {
      const defaultScript = "const { config } = require('./config/appConfig'); if (config.googleAuthEnabled) process.exit(42);";
      const defaultResult = spawnSync(process.execPath, ["-e", defaultScript], {
        cwd: __dirname + "/..",
        env: {
          ...process.env,
          GOOGLE_AUTH_ENABLED: "",
          GOOGLE_CLIENT_ID: "",
          GOOGLE_AUTH_VERIFIER: "",
        },
      });
      assert(defaultResult.status === 0, "Google auth should be disabled by default");
      assertConfigRejects("missing client id", {
        NODE_ENV: "test",
        DATABASE: process.env.DATABASE,
        JWT_SECRET: process.env.JWT_SECRET,
        PASSWORD_RESET_PEPPER: process.env.PASSWORD_RESET_PEPPER,
        MAIL_TRANSPORT: "fake",
        GOOGLE_AUTH_ENABLED: "true",
        GOOGLE_CLIENT_ID: "",
      });
      assertConfigRejects("fake verifier outside test", {
        NODE_ENV: "production",
        DATABASE: "mongodb://127.0.0.1:27017/release_check",
        JWT_SECRET: "release-check-secret-value",
        PASSWORD_RESET_PEPPER: "release-check-reset-pepper",
        CLIENT_ORIGIN: "https://rosetta-acc.com",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "smtp.example.com",
        SMTP_USER: "mailer",
        SMTP_PASS: "mailer-password",
        GOOGLE_AUTH_ENABLED: "true",
        GOOGLE_CLIENT_ID: "phase2l-test-client.apps.googleusercontent.com",
        GOOGLE_AUTH_VERIFIER: "fake",
      });
      assertConfigAccepts("no Google client secret required", {
        NODE_ENV: "test",
        DATABASE: process.env.DATABASE,
        JWT_SECRET: process.env.JWT_SECRET,
        PASSWORD_RESET_PEPPER: process.env.PASSWORD_RESET_PEPPER,
        MAIL_TRANSPORT: "fake",
        GOOGLE_AUTH_ENABLED: "true",
        GOOGLE_CLIENT_ID: "phase2l-test-client.apps.googleusercontent.com",
        GOOGLE_AUTH_VERIFIER: "fake",
      });
    });

    await test("Missing credential is rejected", async () => {
      const res = await request("/api/auth/google", { method: "POST", body: {} });
      assert(res.status === 400 && res.body.code === "GOOGLE_CREDENTIAL_REQUIRED", "missing credential code mismatch");
    });

    await test("Invalid credential and raw verifier errors are controlled", async () => {
      const res = await request("/api/auth/google", { method: "POST", body: { credential: "not-json" } });
      assert(res.status === 401 && res.body.code === "INVALID_GOOGLE_CREDENTIAL", "invalid credential code mismatch");
      assert(!JSON.stringify(res.body).includes("Unexpected"), "raw validation error leaked");
    });

    await test("Wrong audience, missing sub, missing email, unverified and expired credentials are rejected", async () => {
      const cases = [
        [fakeCredential({ aud: "wrong-client.apps.googleusercontent.com" }), "INVALID_GOOGLE_CREDENTIAL"],
        [fakeCredential({ sub: "" }), "INVALID_GOOGLE_CREDENTIAL"],
        [fakeCredential({ email: "" }), "INVALID_GOOGLE_CREDENTIAL"],
        [fakeCredential({ email_verified: false }), "GOOGLE_EMAIL_NOT_VERIFIED"],
        [fakeCredential({ exp: Math.floor(Date.now() / 1000) - 5 }), "INVALID_GOOGLE_CREDENTIAL"],
      ];
      for (const [credential, code] of cases) {
        const res = await request("/api/auth/google", { method: "POST", body: { credential } });
        assert(res.status === 401 && res.body.code === code, `expected ${code}`);
      }
    });

    await test("New verified Google customer is created with safe defaults and sanitized response", async () => {
      const res = await request("/api/auth/google", {
        method: "POST",
        body: {
          credential: fakeCredential({
            sub: `${TEST_PREFIX}sub-new`,
            email: `${TEST_PREFIX}new@example.com`,
          }),
          userRole: 1,
          role: 1,
          status: "blocked",
          verified: false,
          clientSecret: "do-not-trust",
        },
      });
      assert(res.status === 201, "new google user should return 201");
      assert(res.body.token, "Rosetta JWT missing");
      assert(res.body.user.userRole === 0, "Google signup elevated role");
      assert(res.body.user.status === "active", "Google signup trusted status");
      assert(res.body.user.verified === true, "verified Google email should mark account verified");
      assert(!containsForbiddenKey(res.body), "Google signup leaked forbidden fields");
      googleUser = await userModel.findOne({ email: `${TEST_PREFIX}new@example.com` }).select("+password");
      assert(googleUser.authProviders.google.sub === `${TEST_PREFIX}sub-new`, "Google sub not stored");
      assert(googleUser.authProviders.local.enabled === false, "Google-only local provider should be disabled");
      assert(!googleUser.password, "Google-only user should not have a fake password");
      googleToken = res.body.token;
      const decoded = jwt.verify(googleToken, config.jwtSecret);
      assert(decoded.tokenVersion === 0, "JWT tokenVersion incorrect");
    });

    await test("Existing Google customer logs in by stable sub and ignores changed email claims", async () => {
      await userModel.findByIdAndUpdate(googleUser._id, { name: "Edited Profile", status: "active", userRole: 0 });
      const res = await request("/api/auth/google", {
        method: "POST",
        body: {
          credential: fakeCredential({
            sub: `${TEST_PREFIX}sub-new`,
            email: `${TEST_PREFIX}changed@example.com`,
            name: "Should Not Overwrite",
          }),
        },
      });
      assert(res.status === 200, "existing Google login should return 200");
      assert(res.body.user.email === `${TEST_PREFIX}new@example.com`, "sub login should not follow changed email claim");
      assert(res.body.user.name === "Edited Profile", "profile should not be overwritten on login");
    });

    await test("Blocked Google customer is rejected", async () => {
      await userModel.findByIdAndUpdate(googleUser._id, { status: "blocked" });
      const res = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-new`, email: `${TEST_PREFIX}new@example.com` }) },
      });
      assert(res.status === 403 && res.body.code === "ACCOUNT_BLOCKED", "blocked Google user should be rejected");
      await userModel.findByIdAndUpdate(googleUser._id, { status: "active" });
    });

    await test("Matching local customer links Google sub and preserves local password/profile/address/order", async () => {
      localUser = await userModel.create({
        name: "Local Customer",
        email: `${TEST_PREFIX}local@example.com`,
        password: bcrypt.hashSync("LocalPassword123!", 10),
        userRole: 0,
        status: "active",
        verified: false,
        addresses: [{
          label: "Home",
          fullName: "Local Customer",
          phone: "01000000000",
          governorate: "Cairo",
          city: "Nasr City",
          street: "Saved street",
          isDefault: true,
        }],
      });
      await orderModel.create({ user: localUser._id, allProduct: [], transactionId: `${TEST_PREFIX}local-order`, amount: 10 });
      const res = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-local`, email: localUser.email }) },
      });
      assert(res.status === 200, "local link should return 200");
      const linked = await userModel.findById(localUser._id).select("+password");
      assert(linked.authProviders.google.sub === `${TEST_PREFIX}sub-local`, "Google sub not linked");
      assert(linked.authProviders.local.enabled !== false, "local password should remain enabled");
      assert(linked.addresses.length === 1, "addresses should be preserved");
      assert(linked.name === "Local Customer", "profile should be preserved");
      const localLogin = await request("/api/signin", {
        method: "POST",
        body: { email: localUser.email, password: "LocalPassword123!" },
      });
      assert(localLogin.status === 200, "local password should still work");
      localPasswordToken = localLogin.body.token;
    });

    await test("Repeated and concurrent first-link attempts do not duplicate users", async () => {
      const before = await userModel.countDocuments({ email: localUser.email });
      const credential = fakeCredential({ sub: `${TEST_PREFIX}sub-local`, email: localUser.email });
      const responses = await Promise.all([
        request("/api/auth/google", { method: "POST", body: { credential } }),
        request("/api/auth/google", { method: "POST", body: { credential } }),
      ]);
      assert(responses.every((res) => res.status === 200), "repeated Google login should succeed");
      const after = await userModel.countDocuments({ email: localUser.email });
      assert(after === before, "repeated Google login created duplicate user");
    });

    await test("Duplicate sub with different email returns the bound account", async () => {
      const res = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-local`, email: `${TEST_PREFIX}other-email@example.com` }) },
      });
      assert(res.status === 200, "bound sub should authenticate existing account");
      assert(res.body.user.email === localUser.email, "bound sub should not create duplicate email account");
    });

    await test("Existing admin email is not linked and request body cannot create admin", async () => {
      const admin = await userModel.create({
        name: "Admin Account",
        email: `${TEST_PREFIX}admin@example.com`,
        password: bcrypt.hashSync("AdminPassword123!", 10),
        userRole: 1,
        status: "active",
      });
      const adminEmail = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-admin`, email: admin.email }) },
      });
      assert(adminEmail.status === 401 && adminEmail.body.code === "AUTHENTICATION_FAILED", "admin email should fail generically");
      const adminAfter = await userModel.findById(admin._id);
      assert(!adminAfter.authProviders.google.sub, "admin should not be linked");
      const injected = await request("/api/auth/google", {
        method: "POST",
        body: {
          credential: fakeCredential({ sub: `${TEST_PREFIX}sub-injected`, email: `${TEST_PREFIX}injected@example.com` }),
          userRole: 1,
          status: "active",
        },
      });
      assert(injected.status === 201 && injected.body.user.userRole === 0, "role injection should not create admin");
    });

    await test("Blocked local customer email is not duplicated through Google", async () => {
      const blocked = await userModel.create({
        name: "Blocked Local",
        email: `${TEST_PREFIX}blocked@example.com`,
        password: bcrypt.hashSync("BlockedPassword123!", 10),
        userRole: 0,
        status: "blocked",
      });
      const res = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-blocked`, email: blocked.email }) },
      });
      assert(res.status === 403 && res.body.code === "ACCOUNT_BLOCKED", "blocked local email should be rejected");
      const count = await userModel.countDocuments({ email: blocked.email });
      assert(count === 1, "blocked local Google attempt created duplicate user");
    });

    await test("Google-only local signin is generic invalid credentials", async () => {
      const res = await request("/api/signin", {
        method: "POST",
        body: { email: googleUser.email, password: "AnyPassword123!" },
      });
      assert(res.status === 401, "Google-only local signin should be rejected");
      assert(String(res.body.error).toLowerCase().includes("invalid"), "Google-only local signin should be generic");
    });

    await test("Google-only current-password change returns controlled recovery guidance", async () => {
      const res = await request("/api/users/me/password", {
        method: "PATCH",
        token: googleToken,
        body: { oldPassword: "AnyPassword123!", newPassword: "NewLocalPassword123!", confirmPassword: "NewLocalPassword123!" },
      });
      assert(res.status === 400 && res.body.code === "LOCAL_PASSWORD_NOT_SET", "Google-only change password guidance mismatch");
    });

    await test("Password reset enables local provider and preserves Google link", async () => {
      resetToken = "phase2l-reset-token";
      await userModel.findByIdAndUpdate(googleUser._id, {
        resetTokenHash: hmac(resetToken),
        resetTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      const reset = await request("/api/reset-password", {
        method: "POST",
        body: {
          email: googleUser.email,
          resetToken,
          newPassword: "NewLocalPassword123!",
          confirmPassword: "NewLocalPassword123!",
        },
      });
      assert(reset.status === 200, "Google-only reset should succeed");
      const after = await userModel.findById(googleUser._id).select("+password");
      assert(after.authProviders.local.enabled === true, "local provider should be enabled after reset");
      assert(after.authProviders.google.sub === `${TEST_PREFIX}sub-new`, "Google link should remain after reset");
      const localLogin = await request("/api/signin", {
        method: "POST",
        body: { email: googleUser.email, password: "NewLocalPassword123!" },
      });
      assert(localLogin.status === 200, "local login should work after reset");
      const googleLogin = await request("/api/auth/google", {
        method: "POST",
        body: { credential: fakeCredential({ sub: `${TEST_PREFIX}sub-new`, email: googleUser.email }) },
      });
      assert(googleLogin.status === 200, "Google login should still work after reset");
      const oldToken = await request("/api/users/me", { token: googleToken });
      assert(oldToken.status === 401 && oldToken.body.code === "SESSION_EXPIRED", "password reset should invalidate old token");
    });

    await test("Public self and admin responses do not expose Google or reset internals", async () => {
      const profile = await request("/api/users/me", { token: localPasswordToken });
      assert(profile.status === 200, "self profile should return 200");
      assert(!containsForbiddenKey(profile.body), "self profile leaked forbidden field");
      const adminLogin = await request("/api/signin", {
        method: "POST",
        body: { email: `${TEST_PREFIX}admin@example.com`, password: "AdminPassword123!" },
      });
      const list = await request("/api/admin/users", { token: adminLogin.body.token });
      assert(list.status === 200, "admin customer list should return 200");
      assert(!containsForbiddenKey(list.body), "admin customer list leaked forbidden field");
      const detail = await request(`/api/admin/users/${localUser._id}`, { token: adminLogin.body.token });
      assert(detail.status === 200, "admin customer detail should return 200");
      assert(!containsForbiddenKey(detail.body), "admin customer detail leaked forbidden field");
    });

    await cleanup();
    console.log(`Google auth smoke: ${results.length} passed`);
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
