const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const backendRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(backendRoot, "..");
const frontendRoot = path.join(repoRoot, "frontend");

const checks = [];

function pass(name) {
  checks.push({ name, ok: true });
}

function fail(name, message) {
  checks.push({ name, ok: false, message });
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function assertFile(relativePath) {
  if (exists(relativePath)) {
    pass(`file:${relativePath}`);
  } else {
    fail(`file:${relativePath}`, "missing");
  }
}

function listFiles(dir, result = []) {
  if (!fs.existsSync(dir)) return result;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", ".git", "dist", "coverage", "backups"].includes(entry.name)) {
        listFiles(fullPath, result);
      }
    } else {
      result.push(fullPath);
    }
  }
  return result;
}

function git(args, cwd = repoRoot) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitContext(relativePath) {
  if (relativePath.startsWith("backend/")) {
    return { cwd: backendRoot, relativePath: relativePath.slice("backend/".length) };
  }
  if (relativePath.startsWith("frontend/")) {
    return { cwd: frontendRoot, relativePath: relativePath.slice("frontend/".length) };
  }
  return { cwd: repoRoot, relativePath };
}

function isGitTracked(relativePath) {
  const context = gitContext(relativePath);
  const result = git(["ls-files", "--", context.relativePath], context.cwd);
  return result.status === 0 && result.stdout.trim().length > 0;
}

function isGitIgnored(relativePath) {
  const context = gitContext(relativePath);
  const result = git(["check-ignore", "--quiet", context.relativePath], context.cwd);
  return result.status === 0;
}

function assertDotenvNotPackaged(relativePath) {
  if (!exists(relativePath)) {
    pass(`secret-file:${relativePath}`);
    return;
  }
  if (isGitTracked(relativePath)) {
    fail(`secret-file:${relativePath}`, "tracked dotenv file must not be packaged");
    return;
  }
  if (isGitIgnored(relativePath)) {
    pass(`secret-file:${relativePath}:ignored-local`);
    return;
  }
  fail(`secret-file:${relativePath}`, "untracked dotenv file is not ignored");
}

function assertConfigRejects(name, env) {
  const script = "try { require('./config/appConfig').validateConfig(); process.exit(0); } catch (err) { process.exit(42); }";
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: backendRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status === 42) {
    pass(name);
  } else {
    fail(name, `expected rejection, exit=${result.status}`);
  }
}

[
  "backend/app.js",
  "backend/config/appConfig.js",
  "backend/services/googleAuthService.js",
  "backend/utils/uploadPaths.js",
  "backend/scripts/database-readiness.js",
  "backend/scripts/create-admin.js",
  "backend/scripts/release-readiness.js",
  "backend/scripts/payment-expiry-sweep.js",
  "frontend/src/components/shop/order/PaymentReturnPage.js",
  "frontend/src/components/shop/auth/GoogleSignInButton.js",
  "docs/ENVIRONMENT_VARIABLES.md",
  "docs/GOOGLE_AUTH_PRODUCTION_SETUP.md",
  "docs/MONGODB_TRANSACTION_READINESS.md",
  "docs/UPLOAD_STORAGE_DEPLOYMENT.md",
  "docs/DEPENDENCY_RISK_REPORT.md",
  "docs/DATABASE_BACKUP_RESTORE.md",
  "docs/PAYMENT_EXPIRY_SCHEDULING.md",
  "docs/BACKEND_DEPLOYMENT_RUNBOOK.md",
  "docs/FRONTEND_DEPLOYMENT_RUNBOOK.md",
  "docs/MANUAL_QA_CHECKLIST.md",
  "docs/GIT_RELEASE_PLAN.md",
].forEach(assertFile);

[
  "backend/.env",
  "backend/.env.production",
  "frontend/.env",
  "frontend/.env.production",
  ".env",
  ".env.production",
].forEach(assertDotenvNotPackaged);

const packagedDotenvFiles = listFiles(path.join(frontendRoot, "dist"))
  .map((file) => path.relative(frontendRoot, file))
  .filter((relativePath) => /^dist[\\/]\.env(?:\.|$)/i.test(relativePath));
if (packagedDotenvFiles.length) {
  for (const relativePath of packagedDotenvFiles) {
    fail(`secret-file:frontend/${relativePath}`, "dotenv file is present in build output");
  }
} else {
  pass("secret-file:frontend/dist");
}

const sourceText = [backendRoot, frontendRoot, path.join(repoRoot, "docs")]
  .flatMap((dir) => listFiles(dir))
  .filter((file) => /\.(js|jsx|json|md|example|txt)$/i.test(file))
  .map((file) => [file, fs.readFileSync(file, "utf8")]);

let conflictCount = 0;
for (const [file, text] of sourceText) {
  if (/^(<<<<<<<|=======|>>>>>>>)$/m.test(text)) {
    conflictCount += 1;
    fail(`conflict:${path.relative(repoRoot, file)}`, "merge conflict marker present");
  }
}
if (conflictCount === 0) {
  pass("conflict-markers");
}

const frontendEnvText = listFiles(path.join(frontendRoot, "src"))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
if (/PAYMOB_(SECRET|HMAC|PRIVATE)|VITE_PAYMOB/i.test(frontendEnvText)) {
  fail("frontend-paymob-secrets", "frontend references Paymob secret material");
} else {
  pass("frontend-paymob-secrets");
}

assertConfigRejects("reject-fake-mail-outside-test", {
  NODE_ENV: "production",
  DATABASE: "mongodb://127.0.0.1:27017/release_check",
  JWT_SECRET: "release-check-secret-value",
  PASSWORD_RESET_PEPPER: "release-check-reset-pepper",
  CLIENT_ORIGIN: "https://store.example.com",
  MAIL_TRANSPORT: "fake",
});

assertConfigRejects("reject-fake-paymob-outside-test", {
  NODE_ENV: "production",
  DATABASE: "mongodb://127.0.0.1:27017/release_check",
  JWT_SECRET: "release-check-secret-value",
  PASSWORD_RESET_PEPPER: "release-check-reset-pepper",
  CLIENT_ORIGIN: "https://store.example.com",
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "mailer",
  SMTP_PASS: "mailer-password",
  STORE_CURRENCY: "EGP",
  PAYMOB_ENABLED: "true",
  PAYMOB_ADAPTER: "fake",
  PAYMOB_MODE: "test",
  PAYMOB_SECRET_KEY: "placeholder",
  PAYMOB_PUBLIC_KEY: "placeholder",
  PAYMOB_HMAC_SECRET: "placeholder",
  PAYMOB_CARD_INTEGRATION_ID: "1",
  PAYMOB_WALLET_INTEGRATION_ID: "2",
  PAYMOB_MERCHANT_ID: "3",
  PAYMOB_CHECKOUT_BASE_URL: "https://accept.paymob.com",
  PAYMOB_WEBHOOK_URL: "https://api.example.com/api/payments/paymob/webhook",
  PAYMOB_SUCCESS_RETURN_URL: "https://store.example.com/payment/return",
  PAYMOB_FAILURE_RETURN_URL: "https://store.example.com/payment/return",
});

assertConfigRejects("reject-fake-google-verifier-outside-test", {
  NODE_ENV: "production",
  DATABASE: "mongodb://127.0.0.1:27017/release_check",
  JWT_SECRET: "release-check-secret-value",
  PASSWORD_RESET_PEPPER: "release-check-reset-pepper",
  CLIENT_ORIGIN: "https://store.example.com",
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "mailer",
  SMTP_PASS: "mailer-password",
  GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "release-client.apps.googleusercontent.com",
  GOOGLE_AUTH_VERIFIER: "fake",
});

assertConfigRejects("reject-google-enabled-without-client-id", {
  NODE_ENV: "production",
  DATABASE: "mongodb://127.0.0.1:27017/release_check",
  JWT_SECRET: "release-check-secret-value",
  PASSWORD_RESET_PEPPER: "release-check-reset-pepper",
  CLIENT_ORIGIN: "https://store.example.com",
  MAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "mailer",
  SMTP_PASS: "mailer-password",
  GOOGLE_AUTH_ENABLED: "true",
  GOOGLE_CLIENT_ID: "",
});

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.message ? ` ${check.message}` : ""}`);
}

if (failures.length) {
  console.error(`RELEASE_READINESS_FAIL failures=${failures.length}`);
  process.exitCode = 1;
} else {
  console.log(`RELEASE_READINESS_PASS total=${checks.length}`);
}
