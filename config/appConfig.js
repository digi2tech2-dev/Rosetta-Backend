require("dotenv").config();

const MIN_JWT_SECRET_LENGTH = 16;

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

const config = {
  nodeEnv: readString("NODE_ENV", "development"),
  port: readInt("PORT", 8000),
  databaseUrl: readString("DATABASE"),
  jwtSecret: readString("JWT_SECRET"),
  jwtExpiresIn: readString("JWT_EXPIRES_IN", "7d"),
  clientOrigin: readString("CLIENT_ORIGIN", "http://localhost:3000"),
  legacyBraintreeEnabled: readBool("ENABLE_LEGACY_BRAINTREE", false),
  braintreeEnvironment: readString("BRAINTREE_ENVIRONMENT", "Sandbox"),
  braintreeMerchantId: readString("BRAINTREE_MERCHANT_ID"),
  braintreePublicKey: readString("BRAINTREE_PUBLIC_KEY"),
  braintreePrivateKey: readString("BRAINTREE_PRIVATE_KEY"),
  maxJsonBodySize: readString("MAX_JSON_BODY_SIZE", "100kb"),
  authRateLimitWindowMs: readInt("AUTH_RATE_LIMIT_WINDOW_MS", 900000),
  authRateLimitMax: readInt("AUTH_RATE_LIMIT_MAX", 20),
  shippingFlatRate: readInt("SHIPPING_FLAT_RATE", 0),
  freeShippingMinimum: readInt("FREE_SHIPPING_MINIMUM", 0),
  storeCurrency: readString("STORE_CURRENCY", "USD"),
  maxCartItems: readInt("MAX_CART_ITEMS", 50),
  maxItemQuantity: readInt("MAX_ITEM_QUANTITY", 99),
  uploadMaxFileSize: readInt("UPLOAD_MAX_FILE_SIZE", 2 * 1024 * 1024),
};

function validateConfig() {
  const missing = [];
  if (!config.databaseUrl) {
    missing.push("DATABASE");
  }
  if (!config.jwtSecret) {
    missing.push("JWT_SECRET");
  }
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
  if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`);
  }
}

module.exports = {
  config,
  validateConfig,
};
