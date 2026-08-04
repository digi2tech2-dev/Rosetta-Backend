const mongoose = require("mongoose");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const productModel = require("../models/products");
const {
  deriveInventoryMode,
  normalizeBarcode,
  normalizeStringArray,
} = require("../services/productNormalizationService");

const WRITE_MODE = process.argv.includes("--write");
const DRY_RUN = !WRITE_MODE || process.argv.includes("--dry-run");

function assertWriteAllowed() {
  if (WRITE_MODE && process.env.PHASE_2G_MIGRATION_WRITE !== "true") {
    throw new Error("Write mode requires PHASE_2G_MIGRATION_WRITE=true");
  }
}

function idList(value) {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

async function main() {
  assertLocalMongoDatabase(config.databaseUrl);
  assertWriteAllowed();
  await mongoose.connect(config.databaseUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });

  const products = await productModel.find({}).lean();
  const allIds = new Set(products.map((product) => String(product._id)));
  const barcodeCounts = new Map();
  const findings = [];
  let writableUpdates = 0;

  for (const product of products) {
    const updates = {};
    const colors = normalizeStringArray(product.pColors || [], "pColors");
    const sizes = normalizeStringArray(product.pSizes || [], "pSizes");
    const barcode = normalizeBarcode(product.pBarcode);
    const inventoryMode = deriveInventoryMode(colors, sizes);

    if (!Array.isArray(product.pColors)) updates.pColors = colors;
    if (!Array.isArray(product.pSizes)) updates.pSizes = sizes;
    if (!product.pColorImages || typeof product.pColorImages !== "object") updates.pColorImages = {};
    if (product.pBarcode !== barcode) updates.pBarcode = barcode;
    if (product.inventoryMode !== inventoryMode) updates.inventoryMode = inventoryMode;

    if (barcode) {
      const count = barcodeCounts.get(barcode) || 0;
      barcodeCounts.set(barcode, count + 1);
    }

    for (const field of ["relatedProducts", "similarProducts", "suggestedProducts"]) {
      const invalid = idList(product[field]).filter((id) => id === String(product._id) || !allIds.has(id));
      if (invalid.length) {
        findings.push({
          productId: String(product._id),
          field,
          code: "INVALID_RELATED_PRODUCT",
          count: invalid.length,
        });
      }
    }

    if (Object.keys(updates).length) {
      writableUpdates += 1;
      findings.push({
        productId: String(product._id),
        code: "NORMALIZATION_REQUIRED",
        fields: Object.keys(updates),
      });
      if (WRITE_MODE && !DRY_RUN) {
        await productModel.updateOne({ _id: product._id }, { $set: updates });
      }
    }
  }

  for (const [barcode, count] of barcodeCounts.entries()) {
    if (count > 1) {
      findings.push({ code: "DUPLICATE_BARCODE", barcode, count });
    }
  }

  console.log(JSON.stringify({
    mode: WRITE_MODE && !DRY_RUN ? "write" : "dry-run",
    database: mongoose.connection.name,
    productsScanned: products.length,
    productsNeedingNormalization: writableUpdates,
    findings,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(`PRODUCT_CATALOG_MIGRATION_FAIL: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
