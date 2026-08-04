const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE = process.env.DATABASE || "mongodb://127.0.0.1:27017/client_store_upload_corp_disposable";
process.env.JWT_SECRET = process.env.JWT_SECRET || "upload-corp-smoke-jwt-secret";
process.env.PASSWORD_RESET_PEPPER = process.env.PASSWORD_RESET_PEPPER || "upload-corp-smoke-reset-pepper";
process.env.MAIL_TRANSPORT = process.env.MAIL_TRANSPORT || "fake";
process.env.UPLOAD_PUBLIC_PATH = process.env.UPLOAD_PUBLIC_PATH || "/uploads";
process.env.UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(os.tmpdir(), "rosetta-upload-corp-smoke");

const { app } = require("../app");

const PORT = Number(process.env.PORT || 8041);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const uploadRoot = process.env.UPLOAD_ROOT;
const nestedDir = path.join(uploadRoot, "products", "nested");
const fixturePath = path.join(nestedDir, "corp-test.txt");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(fixturePath, "uploaded media", "utf8");

  const server = app.listen(PORT);
  try {
    const uploaded = await fetch(`${BASE_URL}/uploads/products/nested/corp-test.txt`);
    assert(uploaded.status === 200, "uploaded file should return 200");
    assert(
      uploaded.headers.get("cross-origin-resource-policy") === "cross-origin",
      "uploaded file should receive cross-origin CORP"
    );
    assert(
      String(uploaded.headers.get("content-type") || "").includes("text/plain"),
      "uploaded file content type should remain intact"
    );

    const health = await fetch(`${BASE_URL}/api/health`);
    assert(health.status === 200, "health endpoint should return 200");
    assert(
      health.headers.get("cross-origin-resource-policy") !== "cross-origin",
      "generic API responses must not receive the upload CORP policy"
    );

    const missing = await fetch(`${BASE_URL}/uploads/products/nested/missing.txt`);
    assert(missing.status === 404, "missing uploaded file should return 404");

    console.log("UPLOAD_CORP_SMOKE_PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`UPLOAD_CORP_SMOKE_FAIL: ${err.message}`);
  try {
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  } catch (cleanupErr) {}
  process.exit(1);
});
