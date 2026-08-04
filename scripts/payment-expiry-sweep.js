const mongoose = require("mongoose");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const { expirePendingAttempts } = require("../services/payments/paymentService");

async function main() {
  const dryRun = !process.argv.includes("--write");
  const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
  const limit = limitArg ? Math.min(Math.max(Number.parseInt(limitArg.split("=")[1], 10) || 50, 1), 500) : 50;
  if (!dryRun && process.env.PAYMENT_EXPIRY_WRITE_CONFIRM !== "true") {
    throw new Error("PAYMENT_EXPIRY_WRITE_CONFIRM=true is required for write mode");
  }
  if (!dryRun && config.nodeEnv === "production" && process.env.PAYMENT_EXPIRY_ALLOW_PRODUCTION !== "true") {
    throw new Error("Production write mode requires PAYMENT_EXPIRY_ALLOW_PRODUCTION=true");
  }
  if (config.nodeEnv === "test") {
    assertLocalMongoDatabase(config.databaseUrl, { requiredDatabaseName: process.env.REQUIRED_DB_NAME || undefined });
  }
  await mongoose.connect(config.databaseUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
  const result = await expirePendingAttempts({ dryRun, limit });
  console.log(`PAYMENT_EXPIRY_SWEEP_${dryRun ? "DRY_RUN" : "WRITE"} scanned=${result.scanned} expired=${result.expired}`);
}

main()
  .catch((error) => {
    console.error(`PAYMENT_EXPIRY_SWEEP_FAIL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
