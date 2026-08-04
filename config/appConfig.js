require("dotenv").config();

const path = require("path");

const MIN_JWT_SECRET_LENGTH = 16;
const SUPPORTED_PAYMOB_CURRENCIES = new Set(["EGP"]);
const SUPPORTED_PAYMOB_MODES = new Set(["test", "live"]);
const SUPPORTED_PAYMOB_ADAPTERS = new Set(["real", "fake"]);
const SUPPORTED_GOOGLE_VERIFIERS = new Set(["google", "fake"]);

function readString(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return String(value).trim();
}

function readInt(name, fallback) {
  const value = readString(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBool(name, fallback) {
  const value = readString(name);
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readPath(name, fallback) {
  return path.resolve(readString(name, fallback));
}

const config = {
  nodeEnv: readString("NODE_ENV", "development").toLowerCase(),
  port: readInt("PORT", 8000),
  databaseUrl: readString("DATABASE"),
  jwtSecret: readString("JWT_SECRET"),
  jwtExpiresIn: readString("JWT_EXPIRES_IN", "7d"),
  clientOrigin: readString("CLIENT_ORIGIN", "http://localhost:3000"),
  trustProxy: readString("TRUST_PROXY"),
  legacyBraintreeEnabled: readBool("ENABLE_LEGACY_BRAINTREE", false),
  braintreeEnvironment: readString("BRAINTREE_ENVIRONMENT", "Sandbox"),
  braintreeMerchantId: readString("BRAINTREE_MERCHANT_ID"),
  braintreePublicKey: readString("BRAINTREE_PUBLIC_KEY"),
  braintreePrivateKey: readString("BRAINTREE_PRIVATE_KEY"),
  maxJsonBodySize: readString("MAX_JSON_BODY_SIZE", "100kb"),
  authRateLimitWindowMs: readInt("AUTH_RATE_LIMIT_WINDOW_MS", 900000),
  authRateLimitMax: readInt("AUTH_RATE_LIMIT_MAX", 20),
  googleAuthEnabled: readBool("GOOGLE_AUTH_ENABLED", false),
  googleClientId: readString("GOOGLE_CLIENT_ID"),
  googleAuthVerifier: readString("GOOGLE_AUTH_VERIFIER", "google").toLowerCase(),
  passwordResetRateLimitMax: readInt("PASSWORD_RESET_RATE_LIMIT_MAX", 10),
  passwordResetPepper: readString("PASSWORD_RESET_PEPPER"),
  passwordResetCodeTtlMinutes: readInt("PASSWORD_RESET_CODE_TTL_MINUTES", 10),
  passwordResetTokenTtlMinutes: readInt("PASSWORD_RESET_TOKEN_TTL_MINUTES", 15),
  passwordResetMaxAttempts: readInt("PASSWORD_RESET_MAX_ATTEMPTS", 5),
  passwordResetResendSeconds: readInt("PASSWORD_RESET_RESEND_SECONDS", 60),
  smtpHost: readString("SMTP_HOST"),
  smtpPort: readInt("SMTP_PORT", 587),
  smtpSecure: readBool("SMTP_SECURE", false),
  smtpUser: readString("SMTP_USER"),
  smtpPass: readString("SMTP_PASS"),
  mailFrom: readString("MAIL_FROM", "Rosetta <no-reply@localhost>"),
  mailTransport: readString("MAIL_TRANSPORT", "smtp").toLowerCase(),
  shippingFlatRate: readInt("SHIPPING_FLAT_RATE", 0),
  freeShippingMinimum: readInt("FREE_SHIPPING_MINIMUM", 0),
  storeCurrency: readString("STORE_CURRENCY", "USD").toUpperCase(),
  maxCartItems: readInt("MAX_CART_ITEMS", 50),
  maxItemQuantity: readInt("MAX_ITEM_QUANTITY", 99),
  uploadRoot: readPath("UPLOAD_ROOT", path.join(__dirname, "..", "public", "uploads")),
  uploadPublicPath: readString("UPLOAD_PUBLIC_PATH", "/uploads"),
  uploadMaxFileSize: readInt("UPLOAD_MAX_FILE_SIZE", 2 * 1024 * 1024),
  paymobEnabled: readBool("PAYMOB_ENABLED", false),
  paymobMode: readString("PAYMOB_MODE", "test").toLowerCase(),
  paymobAdapter: readString("PAYMOB_ADAPTER", "real").toLowerCase(),
  paymobBaseUrl: readString("PAYMOB_BASE_URL", "https://accept.paymob.com"),
  paymobCheckoutBaseUrl: readString("PAYMOB_CHECKOUT_BASE_URL", "https://accept.paymob.com"),
  paymobSecretKey: readString("PAYMOB_SECRET_KEY"),
  paymobPublicKey: readString("PAYMOB_PUBLIC_KEY"),
  paymobHmacSecret: readString("PAYMOB_HMAC_SECRET"),
  paymobCardIntegrationId: readString("PAYMOB_CARD_INTEGRATION_ID"),
  paymobWalletIntegrationId: readString("PAYMOB_WALLET_INTEGRATION_ID"),
  paymobMerchantId: readString("PAYMOB_MERCHANT_ID"),
  paymobWebhookUrl: readString("PAYMOB_WEBHOOK_URL"),
  paymobSuccessReturnUrl: readString("PAYMOB_SUCCESS_RETURN_URL"),
  paymobFailureReturnUrl: readString("PAYMOB_FAILURE_RETURN_URL"),
  paymobTimeoutMs: readInt("PAYMOB_TIMEOUT_MS", 10000),
  paymobPaymentTtlMinutes: readInt("PAYMOB_PAYMENT_TTL_MINUTES", 30),
  paymobCurrency: readString("PAYMOB_CURRENCY", readString("STORE_CURRENCY", "EGP")).toUpperCase(),
  paymobAllowLive: readBool("PAYMOB_ALLOW_LIVE", false),
};

function validateConfig() {
  const missing = [];
  if (!config.databaseUrl) {
    missing.push("DATABASE");
  }
  if (!config.jwtSecret) {
    missing.push("JWT_SECRET");
  }
  if (!config.passwordResetPepper) {
    missing.push("PASSWORD_RESET_PEPPER");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`);
  }
  if (config.mailTransport === "fake" && config.nodeEnv !== "test") {
    throw new Error("MAIL_TRANSPORT=fake is allowed only when NODE_ENV=test");
  }
  if (!SUPPORTED_GOOGLE_VERIFIERS.has(config.googleAuthVerifier)) {
    throw new Error("GOOGLE_AUTH_VERIFIER must be either google or fake");
  }
  if (config.googleAuthVerifier === "fake" && config.nodeEnv !== "test") {
    throw new Error("GOOGLE_AUTH_VERIFIER=fake is allowed only when NODE_ENV=test");
  }
  if (config.googleAuthEnabled && !config.googleClientId) {
    throw new Error("GOOGLE_CLIENT_ID is required when GOOGLE_AUTH_ENABLED=true");
  }
  if (config.nodeEnv === "production") {
    if (!config.clientOrigin || config.clientOrigin.includes("*") || config.clientOrigin.includes("localhost")) {
      throw new Error("CLIENT_ORIGIN must be explicit and production-safe when NODE_ENV=production");
    }
    if (config.legacyBraintreeEnabled) {
      throw new Error("ENABLE_LEGACY_BRAINTREE must be false for production releases");
    }
    if (config.mailTransport === "smtp" && (!config.smtpHost || !config.smtpUser || !config.smtpPass)) {
      throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASS are required for production SMTP");
    }
  }
  if (config.paymobEnabled) {
    const paymobMissing = [];
    for (const [name, value] of [
      ["PAYMOB_SECRET_KEY", config.paymobSecretKey],
      ["PAYMOB_PUBLIC_KEY", config.paymobPublicKey],
      ["PAYMOB_HMAC_SECRET", config.paymobHmacSecret],
      ["PAYMOB_CARD_INTEGRATION_ID", config.paymobCardIntegrationId],
      ["PAYMOB_WALLET_INTEGRATION_ID", config.paymobWalletIntegrationId],
      ["PAYMOB_MERCHANT_ID", config.paymobMerchantId],
      ["PAYMOB_CHECKOUT_BASE_URL", config.paymobCheckoutBaseUrl],
      ["PAYMOB_WEBHOOK_URL", config.paymobWebhookUrl],
      ["PAYMOB_SUCCESS_RETURN_URL", config.paymobSuccessReturnUrl],
      ["PAYMOB_FAILURE_RETURN_URL", config.paymobFailureReturnUrl],
    ]) {
      if (!value) {
        paymobMissing.push(name);
      }
    }
    if (paymobMissing.length > 0) {
      throw new Error(`Missing required Paymob environment variable(s): ${paymobMissing.join(", ")}`);
    }
    if (!SUPPORTED_PAYMOB_MODES.has(config.paymobMode)) {
      throw new Error("PAYMOB_MODE must be either test or live");
    }
    if (!SUPPORTED_PAYMOB_ADAPTERS.has(config.paymobAdapter)) {
      throw new Error("PAYMOB_ADAPTER must be either real or fake");
    }
    if (!SUPPORTED_PAYMOB_CURRENCIES.has(config.paymobCurrency)) {
      throw new Error("PAYMOB_CURRENCY must be EGP for the configured Paymob integration");
    }
    if (config.storeCurrency !== config.paymobCurrency) {
      throw new Error("STORE_CURRENCY must match PAYMOB_CURRENCY when Paymob is enabled");
    }
    if (config.paymobMode === "live" && !config.paymobAllowLive) {
      throw new Error("PAYMOB_ALLOW_LIVE=true is required before live Paymob mode can start");
    }
    if (config.paymobAdapter === "fake" && config.nodeEnv !== "test") {
      throw new Error("PAYMOB_ADAPTER=fake is allowed only when NODE_ENV=test");
    }
  }
}

module.exports = {
  config,
  validateConfig,
};
