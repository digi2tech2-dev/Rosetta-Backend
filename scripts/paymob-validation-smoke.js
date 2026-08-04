const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE_ENV = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE: "mongodb://127.0.0.1:27017/client_store_paymob_validation_disposable",
  JWT_SECRET: "paymob-validation-secret",
  PASSWORD_RESET_PEPPER: "validation-pepper",
  ENABLE_LEGACY_BRAINTREE: "false",
  PAYMOB_MODE: "test",
  PAYMOB_ADAPTER: "fake",
  STORE_CURRENCY: "EGP",
  PAYMOB_CURRENCY: "EGP",
  PAYMOB_SECRET_KEY: "test-secret",
  PAYMOB_PUBLIC_KEY: "test-public",
  PAYMOB_HMAC_SECRET: "test-hmac",
  PAYMOB_CARD_INTEGRATION_ID: "111",
  PAYMOB_WALLET_INTEGRATION_ID: "222",
  PAYMOB_MERCHANT_ID: "333",
  PAYMOB_CHECKOUT_BASE_URL: "https://accept.paymob.com",
  PAYMOB_WEBHOOK_URL: "https://api.example.test/api/payments/paymob/webhook",
  PAYMOB_SUCCESS_RETURN_URL: "https://example.test/payment/return",
  PAYMOB_FAILURE_RETURN_URL: "https://example.test/payment/return",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runNode(name, env, source, expectedStatus = 0) {
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: ROOT,
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
  });
  assert(
    result.status === expectedStatus,
    `${name} exited ${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`
  );
  console.log(`${name}: PASS`);
  return result;
}

const disabledSource = `
  const paymentService = require("./services/payments/paymentService");
  paymentService.createPaymobIntention(
    "507f1f77bcf86cd799439011",
    { paymentMethod: process.env.METHOD },
    "phase2-paymob-validation"
  )
    .then(() => process.exit(2))
    .catch((err) => {
      if (err.status === 503 && err.code === "PAYMENT_PROVIDER_UNAVAILABLE") process.exit(0);
      console.error(err.status, err.code, err.message);
      process.exit(1);
    });
`;

const unsupportedMethodSource = `
  const paymentService = require("./services/payments/paymentService");
  paymentService.createPaymobIntention(
    "507f1f77bcf86cd799439011",
    { paymentMethod: "manual-card" },
    "phase2-paymob-validation"
  )
    .then(() => process.exit(2))
    .catch((err) => {
      if (err.status === 400 && err.code === "UNSUPPORTED_PAYMENT_METHOD") process.exit(0);
      console.error(err.status, err.code, err.message);
      process.exit(1);
    });
`;

const configOnlySource = `
  const { validateConfig } = require("./config/appConfig");
  validateConfig();
  process.exit(0);
`;

runNode("Paymob disabled rejects card", { PAYMOB_ENABLED: "false", METHOD: "card" }, disabledSource);
runNode("Paymob disabled rejects wallet", { PAYMOB_ENABLED: "false", METHOD: "wallet" }, disabledSource);
runNode(
  "Missing card integration blocks startup",
  { PAYMOB_ENABLED: "true", PAYMOB_CARD_INTEGRATION_ID: "" },
  configOnlySource,
  1
);
runNode(
  "Missing wallet integration blocks startup",
  { PAYMOB_ENABLED: "true", PAYMOB_WALLET_INTEGRATION_ID: "" },
  configOnlySource,
  1
);
runNode("Valid test Paymob configuration loads", { PAYMOB_ENABLED: "true" }, configOnlySource);
runNode("Unsupported enabled method is rejected", { PAYMOB_ENABLED: "true" }, unsupportedMethodSource);

console.log("PAYMOB_VALIDATION_SMOKE_PASS");
