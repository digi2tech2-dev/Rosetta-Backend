const { spawn } = require("child_process");
const fs = require("fs");
const mongoose = require("mongoose");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const TEST_UPLOAD_ROOT = path.join(os.tmpdir(), "rosetta-product-catalog-smoke-uploads");
process.env.UPLOAD_ROOT = process.env.UPLOAD_ROOT || TEST_UPLOAD_ROOT;

const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const cartModel = require("../models/carts");
const orderModel = require("../models/orders");
const cartService = require("../services/cartService");
const orderService = require("../services/orderService");
const productController = require("../controller/products");
const categoryController = require("../controller/categories");
const { uploadFolderPath } = require("../utils/uploadPaths");
const { normalizeOptionalPositiveInteger, normalizeProductPayload } = require("../services/productNormalizationService");
const { serializeProduct } = require("../services/productSerializer");
const { validateProductOptions } = require("../services/productOptionService");

const REQUIRED_DB = process.env.PRODUCT_SMOKE_DATABASE_NAME || "client_store_phase2g_disposable";
const PORT = Number(process.env.PORT || 8060);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TEST_PREFIX = "phase2g-smoke-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function multipartRequest(path, { token, fields = {}, files = [] } = {}) {
  const formData = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) formData.append(key, String(value));
  });
  files.forEach((file) => {
    formData.append(
      file.field || "pImage",
      new Blob([Buffer.alloc(file.size, file.byte || 1)], { type: file.type || "image/png" }),
      file.filename
    );
  });
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function invokeController(handler, req = {}) {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nextError;
  await handler(req, res, (err) => {
    nextError = err;
  });
  if (nextError) throw nextError;
  return { status: res.statusCode, body: res.body };
}

function ensureUploadFolders() {
  fs.mkdirSync(uploadFolderPath("products"), { recursive: true });
  fs.mkdirSync(uploadFolderPath("categories"), { recursive: true });
}

function touchUpload(folder, filename) {
  ensureUploadFolders();
  const filePath = path.join(uploadFolderPath(folder), path.basename(filename));
  fs.writeFileSync(filePath, "smoke-test-file");
  return filePath;
}

async function cleanupUploads() {
  if (path.resolve(config.uploadRoot) === path.resolve(TEST_UPLOAD_ROOT)) {
    await fs.promises.rm(TEST_UPLOAD_ROOT, { recursive: true, force: true });
  }
}

function uploadFile(filename) {
  touchUpload("products", filename);
  return { filename, originalname: filename };
}

function uploadNames(folder = "products") {
  const folderPath = uploadFolderPath(folder);
  if (!fs.existsSync(folderPath)) return [];
  return fs.readdirSync(folderPath).sort();
}

function productUploadFields(seeded, nameSuffix, overrides = {}) {
  return {
    pName: `${TEST_PREFIX}upload-${nameSuffix}`,
    pDescription: "Large image upload smoke product",
    pStatus: "Active",
    pCategory: String(seeded.category._id),
    pQuantity: "5",
    pCost: "10",
    pPrice: "20",
    pOffer: "0",
    pColorImages: "{}",
    ...overrides,
  };
}

async function waitForServer() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become ready");
}

function startServer() {
  return spawn(process.execPath, ["app.js"], {
    cwd: __dirname + "/..",
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      ENABLE_LEGACY_BRAINTREE: "false",
      AUTH_RATE_LIMIT_MAX: "400",
      SHIPPING_FLAT_RATE: "0",
      FREE_SHIPPING_MINIMUM: "0",
      STORE_CURRENCY: "EGP",
    },
    stdio: "ignore",
  });
}

function tokenFor(user) {
  return jwt.sign({ _id: user._id, role: user.userRole }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
}

async function cleanup() {
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const productIds = products.map((product) => product._id);
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  await orderModel.deleteMany({ user: { $in: userIds } });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await productModel.deleteMany({ _id: { $in: productIds } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
}

async function seed() {
  const category = await categoryModel.create({
    cName: `${TEST_PREFIX}category`,
    cDescription: "Disposable catalog smoke category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const otherCategory = await categoryModel.create({
    cName: `${TEST_PREFIX}other-category`,
    cDescription: "Disposable other category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const admin = await userModel.create({
    name: "Phase2G Admin",
    email: `${TEST_PREFIX}admin@example.com`,
    password: bcrypt.hashSync("AdminPassword123!", 10),
    userRole: 1,
  });
  const customer = await userModel.create({
    name: "Phase2G Customer",
    email: `${TEST_PREFIX}customer@example.com`,
    password: bcrypt.hashSync("CustomerPassword123!", 10),
    userRole: 0,
  });
  const products = await productModel.create([
    {
      pName: `${TEST_PREFIX}simple`,
      pDescription: "Simple product",
      pPrice: 100,
      pCost: 40,
      pBarcode: `${TEST_PREFIX}barcode-1`,
      pQuantity: 10,
      pCategory: category._id,
      pImages: ["simple-a.png", "simple-b.png"],
      pOffer: "0",
      pStatus: "Active",
    },
    {
      pName: `${TEST_PREFIX}colors`,
      pDescription: "Color product",
      pPrice: 110,
      pQuantity: 10,
      pCategory: category._id,
      pImages: ["color-a.png", "color-b.png"],
      pOffer: "0",
      pStatus: "Active",
      pColors: ["Black", "Red"],
      inventoryMode: "shared_options",
    },
    {
      pName: `${TEST_PREFIX}sizes`,
      pDescription: "Size product",
      pPrice: 120,
      pQuantity: 10,
      pCategory: category._id,
      pImages: ["size-a.png", "size-b.png"],
      pOffer: "0",
      pStatus: "Active",
      pSizes: ["M", "L"],
      inventoryMode: "shared_options",
    },
    {
      pName: `${TEST_PREFIX}single-options`,
      pDescription: "Single option product",
      pPrice: 130,
      pQuantity: 10,
      pCategory: category._id,
      pImages: ["single-a.png", "single-b.png"],
      pOffer: "0",
      pStatus: "Active",
      pColors: ["Gold"],
      pSizes: ["One Size"],
      inventoryMode: "shared_options",
    },
    {
      pName: `${TEST_PREFIX}both-options`,
      pDescription: "Both options product",
      pPrice: 140,
      pQuantity: 5,
      pCategory: category._id,
      pImages: ["both-a.png", "both-b.png"],
      pOffer: "0",
      pStatus: "Active",
      pBrand: "Rosetta",
      pColors: ["Black", "Red"],
      pSizes: ["S", "M"],
      inventoryMode: "shared_options",
      pColorImages: { Black: { fileName: "black.png" } },
    },
    {
      pName: `${TEST_PREFIX}nearby`,
      pDescription: "Nearby product",
      pPrice: 142,
      pQuantity: 4,
      pCategory: category._id,
      pImages: ["nearby-a.png", "nearby-b.png"],
      pOffer: "0",
      pStatus: "Active",
      pBrand: "Rosetta",
    },
    {
      pName: `${TEST_PREFIX}far`,
      pDescription: "Far product",
      pPrice: 900,
      pQuantity: 4,
      pCategory: otherCategory._id,
      pImages: ["far-a.png", "far-b.png"],
      pOffer: "0",
      pStatus: "Active",
    },
  ]);
  return {
    admin,
    customer,
    adminToken: tokenFor(admin),
    customerToken: tokenFor(customer),
    category,
    otherCategory,
    simple: products[0],
    colors: products[1],
    sizes: products[2],
    singleOptions: products[3],
    bothOptions: products[4],
    nearby: products[5],
    far: products[6],
  };
}

const shippingAddress = {
  fullName: "Phase Customer",
  phone: "+201000000000",
  city: "Cairo",
  area: "Nasr City",
  street: "Test Street",
};

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16, "JWT_SECRET is required");

  const server = startServer();
  try {
    await waitForServer();
    await mongoose.connect(process.env.DATABASE, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      useCreateIndex: true,
    });
    await mongoose.connection.db.dropDatabase();
    await cleanup();
    await productModel.init();
    const seeded = await seed();
    const tests = [];
    async function test(name, fn) {
      tests.push(name);
      await fn();
      console.log(`${tests.length}. ${name}: PASS`);
    }

    await test("Simple product accepts no selected options", async () => {
      const options = validateProductOptions({ product: seeded.simple });
      assert(options.selectedColor === null && options.selectedSize === null, "simple product option normalization failed");
    });

    await test("Single color and size auto-normalize", async () => {
      const options = validateProductOptions({ product: seeded.singleOptions });
      assert(options.selectedColor === "Gold", "single color did not normalize");
      assert(options.selectedSize === "One Size", "single size did not normalize");
    });

    await test("Multiple colors require selection", async () => {
      let failed = false;
      try {
        validateProductOptions({ product: seeded.colors });
      } catch (err) {
        failed = err.code === "INVALID_PRODUCT_OPTION";
      }
      assert(failed, "missing color should fail");
    });

    await test("Multiple sizes require selection", async () => {
      let failed = false;
      try {
        validateProductOptions({ product: seeded.sizes });
      } catch (err) {
        failed = err.code === "INVALID_PRODUCT_OPTION";
      }
      assert(failed, "missing size should fail");
    });

    await test("Invalid color and size are rejected", async () => {
      let failed = false;
      try {
        validateProductOptions({ product: seeded.bothOptions, selectedColor: "Blue", selectedSize: "XL" });
      } catch (err) {
        failed = err.code === "INVALID_PRODUCT_OPTION";
      }
      assert(failed, "invalid option should fail");
    });

    await test("Duplicate options normalize case-insensitively", async () => {
      const normalized = normalizeProductPayload({
        pColors: JSON.stringify(["Black", " black ", "Red"]),
        pSizes: "M,m,L",
      });
      assert(normalized.pColors.length === 2, "duplicate colors were not normalized");
      assert(normalized.pSizes.length === 2, "duplicate sizes were not normalized");
    });

    await test("Invalid video URL is rejected", async () => {
      let failed = false;
      try {
        normalizeProductPayload({ pVideo: "javascript:alert(1)" });
      } catch (err) {
        failed = err.code === "INVALID_VIDEO_URL";
      }
      assert(failed, "invalid video URL should fail");
    });

    await test("Optional category order accepts only positive whole numbers", async () => {
      assert(normalizeOptionalPositiveInteger("", "pCategoryOrder") === null, "empty order should be unordered");
      assert(normalizeOptionalPositiveInteger(undefined, "pCategoryOrder") === null, "missing order should be unordered");
      assert(normalizeOptionalPositiveInteger("1", "pCategoryOrder") === 1, "order 1 should be accepted");
      for (const value of ["abc", "1.5", "-1", "0"]) {
        let failed = false;
        try {
          normalizeOptionalPositiveInteger(value, "pCategoryOrder");
        } catch (err) {
          failed = err.code === "VALIDATION_ERROR";
        }
        assert(failed, `invalid category order ${value} should fail`);
      }
    });

    await test("Category ordering is stable before pagination", async () => {
      const pagingCategory = await categoryModel.create({
        cName: `${TEST_PREFIX}paging-category`,
        cDescription: "Pagination ordering category",
        cStatus: "Active",
        cImage: "fixture.png",
      });
      const orderedProducts = [];
      for (let index = 0; index < 35; index += 1) {
        const position = index === 0 ? 2 : index === 1 ? 1 : index === 2 ? 3 : index === 3 ? 2 : null;
        orderedProducts.push({
          pName: `${TEST_PREFIX}paging-${String(index).padStart(2, "0")}`,
          pDescription: "Paging product",
          pPrice: 50 + index,
          pQuantity: 5,
          pCategory: pagingCategory._id,
          pImages: [`paging-${index}-a.png`, `paging-${index}-b.png`],
          pOffer: "0",
          pStatus: "Active",
          pCategoryOrder: position,
          createdAt: new Date(2020, 0, index + 1),
          updatedAt: new Date(2020, 0, index + 1),
        });
      }
      await productModel.insertMany(orderedProducts);
      const emptyCategory = await categoryModel.create({
        cName: `${TEST_PREFIX}empty-category`,
        cDescription: "Empty category",
        cStatus: "Active",
        cImage: "fixture.png",
      });
      const empty = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: emptyCategory._id, page: 1, limit: 16 },
      });
      assert(empty.status === 200 && empty.body.Products.length === 0, "empty category should return no products");
      assert(empty.body.pagination.totalItems === 0 && empty.body.pagination.totalPages === 1, "empty pagination metadata mismatch");

      const first = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: 1, limit: 16 },
      });
      const repeat = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: 1, limit: 16 },
      });
      const second = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: 2, limit: 16 },
      });
      const last = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: 3, limit: 16 },
      });
      assert(first.status === 200 && first.body.Products.length === 16, "first page should contain 16 products");
      assert(second.body.Products.length === 16, "second page should contain 16 products");
      assert(last.body.Products.length === 3, "third page should contain remaining products");
      assert(first.body.pagination.pageSize === 16 && first.body.pagination.totalItems === 35 && first.body.pagination.totalPages === 3, "pagination metadata mismatch");
      assert(first.body.Products.map((product) => product.pName).slice(0, 4).join(",") === `${TEST_PREFIX}paging-01,${TEST_PREFIX}paging-00,${TEST_PREFIX}paging-03,${TEST_PREFIX}paging-02`, "explicit and duplicate ordering mismatch");
      assert(first.body.Products.map((product) => product._id).join(",") === repeat.body.Products.map((product) => product._id).join(","), "ordering changed across repeated requests");
      const seen = new Set([...first.body.Products, ...second.body.Products, ...last.body.Products].map((product) => product._id));
      assert(seen.size === 35, "pagination produced duplicate or missing products");
      const invalidPage = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: "bad", limit: 16 },
      });
      const invalidLimit = await request("/api/product/product-by-category", {
        method: "POST",
        body: { catId: pagingCategory._id, page: 1, limit: 101 },
      });
      assert(invalidPage.status === 500 || invalidPage.status === 400, "invalid page should fail");
      assert(invalidLimit.status === 500 || invalidLimit.status === 400, "invalid limit should fail");
    });

    await test("Product upload accepts valid images through the configured 20 MB boundary", async () => {
      const maxBytes = config.uploadMaxFileSizeMb * 1024 * 1024;
      const cases = [
        {
          suffix: "small-valid",
          files: [
            { filename: "small-a.png", size: 1024 },
            { filename: "small-b.png", size: 2048 },
          ],
        },
        {
          suffix: "below-boundary",
          files: [
            { filename: "below-a.png", size: maxBytes - 1 },
            { filename: "below-b.png", size: 1024 },
          ],
        },
        {
          suffix: "exact-boundary",
          files: [
            { filename: "exact-a.png", size: maxBytes },
            { filename: "exact-b.png", size: 1024 },
          ],
        },
        {
          suffix: "multiple-valid",
          files: [
            { filename: "multi-a.png", size: 1024 * 1024 },
            { filename: "multi-b.png", size: 1024 * 1024 },
            { filename: "multi-c.png", size: 1024 * 1024 },
          ],
        },
      ];

      for (const scenario of cases) {
        const created = await multipartRequest("/api/product/add-product", {
          token: seeded.adminToken,
          fields: productUploadFields(seeded, scenario.suffix),
          files: scenario.files,
        });
        assert(created.status === 200, `${scenario.suffix} upload failed with ${created.status}`);
        assert(created.body.Product && created.body.Product.pImages.length === scenario.files.length, `${scenario.suffix} returned image list mismatch`);
        const saved = await productModel.findById(created.body.Product._id);
        assert(saved && saved.pImages.length === scenario.files.length, `${scenario.suffix} images did not persist`);
      }
    });

    await test("Oversized product creation returns IMAGE_TOO_LARGE without partial records or orphan files", async () => {
      const maxBytes = config.uploadMaxFileSizeMb * 1024 * 1024;
      const beforeUploads = uploadNames("products").join(",");
      const fields = productUploadFields(seeded, "oversized-create");
      const created = await multipartRequest("/api/product/add-product", {
        token: seeded.adminToken,
        fields,
        files: [
          { filename: "valid-before-oversized.png", size: 1024 },
          { filename: "too-large.png", size: maxBytes + 1 },
        ],
      });
      const afterUploads = uploadNames("products").join(",");
      const savedCount = await productModel.countDocuments({ pName: fields.pName });
      assert(created.status === 413, "oversized create should return HTTP 413");
      assert(created.body.code === "IMAGE_TOO_LARGE", "oversized create code mismatch");
      assert(created.body.maxFileSizeMb === config.uploadMaxFileSizeMb, "oversized create max MB missing");
      assert(savedCount === 0, "oversized create left a partial product");
      assert(afterUploads === beforeUploads, "oversized create left orphan uploads");
    });

    await test("Oversized product edit keeps existing images unchanged and cleans new uploads", async () => {
      const maxBytes = config.uploadMaxFileSizeMb * 1024 * 1024;
      const imageProduct = await productModel.create({
        pName: `${TEST_PREFIX}oversized-edit`,
        pDescription: "Oversized edit product",
        pPrice: 88,
        pQuantity: 4,
        pCategory: seeded.category._id,
        pImages: ["oversized-old-a.png", "oversized-old-b.png"],
        pOffer: "0",
        pStatus: "Active",
      });
      touchUpload("products", "oversized-old-a.png");
      touchUpload("products", "oversized-old-b.png");
      const beforeUploads = uploadNames("products").join(",");
      const edit = await multipartRequest("/api/product/edit-product", {
        token: seeded.adminToken,
        fields: productUploadFields(seeded, "oversized-edit", {
          pId: String(imageProduct._id),
          pName: imageProduct.pName,
          pDescription: "Oversized edit attempted",
          pImages: JSON.stringify(["oversized-old-b.png"]),
        }),
        files: [
          { field: "pEditImages", filename: "oversized-replacement.png", size: maxBytes + 1 },
        ],
      });
      const saved = await productModel.findById(imageProduct._id);
      const afterUploads = uploadNames("products").join(",");
      assert(edit.status === 413, "oversized edit should return HTTP 413");
      assert(edit.body.code === "IMAGE_TOO_LARGE", "oversized edit code mismatch");
      assert(JSON.stringify(saved.pImages) === JSON.stringify(["oversized-old-a.png", "oversized-old-b.png"]), "oversized edit changed existing images");
      assert(afterUploads === beforeUploads, "oversized edit left orphan uploads");
    });

    await test("Invalid product upload MIME returns a structured validation error and cleans files", async () => {
      const beforeUploads = uploadNames("products").join(",");
      const fields = productUploadFields(seeded, "invalid-mime");
      const created = await multipartRequest("/api/product/add-product", {
        token: seeded.adminToken,
        fields,
        files: [
          { filename: "valid-before-invalid.png", size: 1024 },
          { filename: "invalid.txt", size: 1024, type: "text/plain" },
        ],
      });
      const afterUploads = uploadNames("products").join(",");
      const savedCount = await productModel.countDocuments({ pName: fields.pName });
      assert(created.status === 400, "invalid MIME should return HTTP 400");
      assert(created.body.code === "VALIDATION_ERROR", "invalid MIME code mismatch");
      assert(savedCount === 0, "invalid MIME left a partial product");
      assert(afterUploads === beforeUploads, "invalid MIME left orphan uploads");
    });

    await test("Color image map persists safe filenames", async () => {
      const normalized = normalizeProductPayload({
        pColors: "Black",
        pColorImages: JSON.stringify({ Black: { fileName: "/uploads/products/black.png" } }),
      });
      assert(normalized.pColorImages.Black.fileName === "black.png", "color image filename was not normalized");
    });

    await test("Unsafe color image path is rejected", async () => {
      let failed = false;
      try {
        normalizeProductPayload({
          pColors: "Black",
          pColorImages: JSON.stringify({ Black: { fileName: "C:\\secret\\black.png" } }),
        });
      } catch (err) {
        failed = err.code === "INVALID_COLOR_IMAGE";
      }
      assert(failed, "unsafe color image path should fail");
    });

    await test("Self relationship is rejected", async () => {
      let failed = false;
      try {
        normalizeProductPayload({ relatedProducts: [seeded.simple._id] }, { currentProductId: seeded.simple._id });
      } catch (err) {
        failed = err.code === "INVALID_RELATED_PRODUCT";
      }
      assert(failed, "self relationship should fail");
    });

    await test("Missing relationship is rejected through admin edit", async () => {
      const missingId = new mongoose.Types.ObjectId();
      const res = await request("/api/product/edit-product", {
        method: "POST",
        token: seeded.adminToken,
        body: {
          pId: seeded.simple._id,
          pName: seeded.simple.pName,
          pDescription: seeded.simple.pDescription,
          pPrice: seeded.simple.pPrice,
          pQuantity: seeded.simple.pQuantity,
          pCategory: seeded.category._id,
          pOffer: "0",
          pStatus: "Active",
          pImages: seeded.simple.pImages.join(","),
          relatedProducts: [missingId],
        },
      });
      assert(res.status === 400, "missing relationship should fail");
      assert(res.body.code === "INVALID_RELATED_PRODUCT", "relationship error code mismatch");
    });

    await test("Duplicate barcode is rejected with a controlled conflict", async () => {
      const created = await request("/api/product/add-product", {
        method: "POST",
        token: seeded.adminToken,
        body: {},
      });
      assert(created.status !== 409 || created.body.code !== "DUPLICATE_BARCODE", "empty add request should not masquerade as duplicate barcode");
      const res = await request("/api/product/edit-product", {
        method: "POST",
        token: seeded.adminToken,
        body: {
          pId: seeded.colors._id,
          pName: seeded.colors.pName,
          pDescription: seeded.colors.pDescription,
          pPrice: seeded.colors.pPrice,
          pQuantity: seeded.colors.pQuantity,
          pCategory: seeded.category._id,
          pOffer: "0",
          pStatus: "Active",
          pImages: seeded.colors.pImages.join(","),
          pColors: seeded.colors.pColors,
          pBarcode: `${TEST_PREFIX}barcode-1`,
        },
      });
      assert(res.status === 409, "duplicate barcode should fail");
      assert(res.body.code === "DUPLICATE_BARCODE", "duplicate barcode code mismatch");
    });

    await test("Multiple products without barcode can coexist", async () => {
      await productModel.create([
        {
          pName: `${TEST_PREFIX}no-barcode-a`,
          pDescription: "No barcode A",
          pPrice: 10,
          pQuantity: 1,
          pCategory: seeded.category._id,
          pImages: ["no-barcode-a.png", "no-barcode-b.png"],
          pOffer: "0",
          pStatus: "Active",
        },
        {
          pName: `${TEST_PREFIX}no-barcode-b`,
          pDescription: "No barcode B",
          pPrice: 11,
          pQuantity: 1,
          pCategory: seeded.category._id,
          pImages: ["no-barcode-c.png", "no-barcode-d.png"],
          pOffer: "0",
          pStatus: "Active",
        },
      ]);
    });

    await test("Cost is visible to admin serializer only", async () => {
      const adminProduct = serializeProduct(seeded.simple, { admin: true });
      const publicProduct = serializeProduct(seeded.simple);
      assert(adminProduct.pCost === 40, "admin cost missing");
      assert(!Object.prototype.hasOwnProperty.call(publicProduct, "pCost"), "public cost leaked");
    });

    await test("Public all-product endpoint never exposes cost", async () => {
      const res = await request("/api/product/all-product");
      assert(res.status === 200, "public all-product failed");
      assert(!JSON.stringify(res.body).includes("pCost"), "public all-product leaked cost");
    });

    await test("Admin all-product endpoint includes cost", async () => {
      const res = await request("/api/product/all-product", { token: seeded.adminToken });
      assert(res.status === 200, "admin all-product failed");
      assert(JSON.stringify(res.body).includes("pCost"), "admin all-product did not include cost");
    });

    await test("All-product remains backward compatible without pagination params", async () => {
      const legacy = await request("/api/product/all-product");
      assert(legacy.status === 200, "legacy all-product failed");
      assert(legacy.body.Products.length >= 7, "legacy all-product unexpectedly paginated the full catalog");
      assert(legacy.body.pagination && legacy.body.pagination.totalItems >= legacy.body.Products.length, "legacy pagination metadata missing");
    });

    await test("Product edit persists retained, removed, and new images", async () => {
      const imageProduct = await productModel.create({
        pName: `${TEST_PREFIX}image-edit`,
        pDescription: "Image edit product",
        pPrice: 88,
        pQuantity: 4,
        pCategory: seeded.category._id,
        pImages: ["image-old-a.png", "image-old-b.png"],
        pOffer: "0",
        pStatus: "Active",
      });
      touchUpload("products", "image-old-a.png");
      touchUpload("products", "image-old-b.png");
      const replace = await invokeController(productController.postEditProduct, {
        body: {
          pId: String(imageProduct._id),
          pName: imageProduct.pName,
          pDescription: "Image edit product updated",
          pPrice: "88",
          pQuantity: "4",
          pCategory: String(seeded.category._id),
          pOffer: "0",
          pStatus: "Active",
          pImages: JSON.stringify(["image-old-b.png"]),
          pColorImages: "{}",
          pCategoryOrder: "2",
        },
        files: [uploadFile("image-new-a.png")],
      });
      assert(replace.status === 200, "image replacement edit failed");
      assert(JSON.stringify(replace.body.Product.pImages) === JSON.stringify(["image-old-b.png", "image-new-a.png"]), "returned image list was not final");
      let saved = await productModel.findById(imageProduct._id);
      assert(JSON.stringify(saved.pImages) === JSON.stringify(["image-old-b.png", "image-new-a.png"]), "replacement image list did not persist");
      assert(saved.pCategoryOrder === 2, "product category order did not persist on edit");

      const noChange = await invokeController(productController.postEditProduct, {
        body: {
          pId: String(imageProduct._id),
          pName: imageProduct.pName,
          pDescription: "Image edit product saved without image changes",
          pPrice: "89",
          pQuantity: "4",
          pCategory: String(seeded.category._id),
          pOffer: "0",
          pStatus: "Active",
          pImages: JSON.stringify(["image-old-b.png", "image-new-a.png"]),
          pColorImages: "{}",
          pCategoryOrder: "",
        },
        files: [],
      });
      assert(noChange.status === 200, "save without image changes failed");
      saved = await productModel.findById(imageProduct._id);
      assert(JSON.stringify(saved.pImages) === JSON.stringify(["image-old-b.png", "image-new-a.png"]), "save without image changes altered images");
      assert(saved.pCategoryOrder === null, "empty order should persist as unordered");

      const removeOne = await invokeController(productController.postEditProduct, {
        body: {
          pId: String(imageProduct._id),
          pName: imageProduct.pName,
          pDescription: "Image edit product remove one",
          pPrice: "89",
          pQuantity: "4",
          pCategory: String(seeded.category._id),
          pOffer: "0",
          pStatus: "Active",
          pImages: JSON.stringify(["image-new-a.png"]),
          pColorImages: "{}",
          pCategoryOrder: "",
        },
        files: [],
      });
      assert(removeOne.status === 200, "remove-one image edit failed");
      saved = await productModel.findById(imageProduct._id);
      assert(JSON.stringify(saved.pImages) === JSON.stringify(["image-new-a.png"]), "removed image stayed in database");

      const invalid = await invokeController(productController.postEditProduct, {
        body: {
          pId: String(imageProduct._id),
          pName: imageProduct.pName,
          pDescription: "Invalid image edit",
          pPrice: "89",
          pQuantity: "4",
          pCategory: String(seeded.category._id),
          pOffer: "0",
          pStatus: "Active",
          pImages: JSON.stringify(["image-new-a.png"]),
          pColorImages: "{}",
          pCategoryOrder: "0",
        },
        files: [uploadFile("image-orphan.png")],
      });
      assert(invalid.status === 400, "invalid order after upload should fail");
    });

    await test("Category edit persists fields and preserves/replaces images", async () => {
      const category = await categoryModel.create({
        cName: `${TEST_PREFIX}editable-category`,
        cDescription: "Before",
        cStatus: "Active",
        cImage: "category-old.png",
      });
      touchUpload("categories", "category-old.png");
      const noImage = await invokeController(categoryController.postEditCategory, {
        body: {
          cId: String(category._id),
          cName: `${TEST_PREFIX}editable-category-renamed`,
          cDescription: "",
          cStatus: "Disabled",
        },
      });
      assert(noImage.status === 200 && noImage.body.Category, "category text/status edit failed");
      let saved = await categoryModel.findById(category._id);
      assert(saved.cName === noImage.body.Category.cName && saved.cName !== category.cName, "category name did not persist");
      assert(saved.cDescription === "", "category description did not persist");
      assert(saved.cStatus === "Disabled", "category status did not persist");
      assert(saved.cImage === "category-old.png", "category image should have been preserved");

      touchUpload("categories", "category-new.png");
      const withImage = await invokeController(categoryController.postEditCategory, {
        body: {
          cId: String(category._id),
          cName: `${TEST_PREFIX}editable-category-renamed`,
          cDescription: "After",
          cStatus: "Active",
        },
        file: { filename: "category-new.png" },
      });
      assert(withImage.status === 200 && withImage.body.Category.cImage === "category-new.png", "category image edit response mismatch");
      saved = await categoryModel.findById(category._id);
      assert(saved.cDescription === "After" && saved.cStatus === "Active" && saved.cImage === "category-new.png", "category image edit did not persist");
    });

    await test("Recommended toggle is admin-protected, persistent, paginated, and unique", async () => {
      const customerAttempt = await request("/api/product/recommend-product", {
        method: "POST",
        token: seeded.customerToken,
        body: { pId: seeded.simple._id, recommended: true },
      });
      assert(customerAttempt.status === 403, "customer should not toggle recommended products");
      const recommend = await request("/api/product/recommend-product", {
        method: "POST",
        token: seeded.adminToken,
        body: { pId: seeded.simple._id, recommended: true },
      });
      assert(recommend.status === 200 && recommend.body.Product.pRecommended === true, "admin recommend failed");
      const repeat = await request("/api/product/recommend-product", {
        method: "POST",
        token: seeded.adminToken,
        body: { pId: seeded.simple._id, recommended: true },
      });
      assert(repeat.status === 200 && repeat.body.Product.pRecommended === true, "repeated recommend should be idempotent");
      await productModel.updateMany({ pName: new RegExp(`^${TEST_PREFIX}`), pStatus: "Active" }, { pRecommended: true, pQuantity: 5 });
      await productModel.findByIdAndUpdate(seeded.far._id, { pRecommended: true, pStatus: "Disabled" });
      const first = await request("/api/product/recommended?page=1&limit=16");
      const second = await request("/api/product/recommended?page=2&limit=16");
      assert(first.status === 200 && first.body.Products.length <= 16, "recommended first page failed");
      assert(first.body.pagination.pageSize === 16, "recommended page size mismatch");
      const ids = [...first.body.Products, ...second.body.Products].map((product) => product._id);
      assert(ids.length === new Set(ids).size, "recommended products duplicated across pages");
      assert(first.body.Products.every((product) => product.pRecommended === true && product.pStatus === "Active"), "recommended response leaked hidden products");
      const unrecommend = await request("/api/product/recommend-product", {
        method: "POST",
        token: seeded.adminToken,
        body: { pId: seeded.simple._id, recommended: false },
      });
      assert(unrecommend.status === 200 && unrecommend.body.Product.pRecommended === false, "unrecommend failed");
    });

    await test("Admin cart deletion removes only the admin's own item and refreshes totals", async () => {
      const adminAdd = await request("/api/cart/items", {
        method: "POST",
        token: seeded.adminToken,
        body: { productId: seeded.simple._id, quantity: 2 },
      });
      assert(adminAdd.status === 201 && adminAdd.body.cart.summary.itemCount === 2, "admin add to cart failed");
      const customerAdd = await request("/api/cart/items", {
        method: "POST",
        token: seeded.customerToken,
        body: { productId: seeded.simple._id, quantity: 1 },
      });
      assert(customerAdd.status === 201, "customer add to cart failed");
      const adminRemove = await request(`/api/cart/items/${seeded.simple._id}`, {
        method: "DELETE",
        token: seeded.adminToken,
      });
      assert(adminRemove.status === 200, "admin cart remove failed");
      assert(adminRemove.body.cart.items.length === 0, "admin cart item remained after delete");
      assert(adminRemove.body.cart.summary.itemCount === 0 && adminRemove.body.cart.summary.total === 0, "admin cart totals did not refresh");
      const adminRefresh = await request("/api/cart", { token: seeded.adminToken });
      const customerRefresh = await request("/api/cart", { token: seeded.customerToken });
      assert(adminRefresh.body.cart.items.length === 0, "deleted admin item returned after refresh");
      assert(customerRefresh.body.cart.items.length === 1, "admin deletion touched customer cart");
      await cartService.clearCart(seeded.admin._id);
      await cartService.clearCart(seeded.customer._id);
    });

    await test("Authenticated customer product responses do not include cost or barcode", async () => {
      const res = await request("/api/product/all-product", { token: seeded.customerToken });
      assert(res.status === 200, "customer all-product failed");
      assert(!JSON.stringify(res.body).includes("pCost"), "customer response leaked cost");
      assert(!JSON.stringify(res.body).includes("pBarcode"), "customer response leaked barcode");
    });

    await test("Invalid optional auth token does not grant admin serialization", async () => {
      const res = await request("/api/product/all-product", { token: "invalid-token" });
      assert(res.status === 200, "invalid optional token should still get public response");
      assert(!JSON.stringify(res.body).includes("pCost"), "invalid token leaked cost");
      assert(!JSON.stringify(res.body).includes("pBarcode"), "invalid token leaked barcode");
    });

    await test("Search is bounded and public-safe", async () => {
      const res = await request(`/api/product/all-product?q=${encodeURIComponent(TEST_PREFIX)}&limit=2`);
      assert(res.status === 200, "search failed");
      assert(res.body.Products.length <= 2, "search limit was not bounded");
      assert(!JSON.stringify(res.body).includes("pCost"), "search leaked cost");
    });

    await test("Manual and automatic recommendations are public-safe", async () => {
      await productModel.findByIdAndUpdate(seeded.far._id, { pStatus: "Disabled", pCost: 500, pBarcode: `${TEST_PREFIX}barcode-disabled` });
      seeded.bothOptions.similarProducts = [seeded.far._id];
      seeded.bothOptions.suggestedProducts = [seeded.simple._id];
      await seeded.bothOptions.save();
      const manual = await request("/api/product/single-product", {
        method: "POST",
        body: { pId: seeded.bothOptions._id },
      });
      assert(!manual.body.Product.similarProducts.some((product) => product._id === String(seeded.far._id)), "inactive manual similar product leaked publicly");
      assert(manual.body.Product.suggestedProducts[0]._id === String(seeded.simple._id), "manual suggested override missing");
      assert(!JSON.stringify(manual.body).includes("pCost"), "recommendations leaked cost");
      assert(!JSON.stringify(manual.body).includes("pBarcode"), "recommendations leaked barcode");
      await productModel.findByIdAndUpdate(seeded.bothOptions._id, { similarProducts: [], suggestedProducts: [] });
      const fallback = await request("/api/product/single-product", {
        method: "POST",
        body: { pId: seeded.bothOptions._id },
      });
      assert(fallback.body.Product.similarProducts.some((product) => product._id === String(seeded.nearby._id)), "fallback similar product missing");
    });

    await test("Cart lines split by selected options", async () => {
      await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 1, { selectedColor: "Black", selectedSize: "S" });
      const cart = await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 1, { selectedColor: "Red", selectedSize: "S" });
      assert(cart.items.length === 2, "cart lines did not split by color");
    });

    await test("Option-specific removal keeps sibling option rows", async () => {
      let cart = await cartService.removeItem(seeded.customer._id, seeded.bothOptions._id, { selectedColor: "Black", selectedSize: "S" });
      assert(cart.items.length === 1, "removing one option row should leave one sibling row");
      assert(cart.items[0].selectedColor === "Red", "wrong option row remained");
    });

    await test("Ambiguous remove without options is rejected when multiple product rows exist", async () => {
      await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 1, { selectedColor: "Black", selectedSize: "S" });
      let failed = false;
      try {
        await cartService.removeItem(seeded.customer._id, seeded.bothOptions._id);
      } catch (err) {
        failed = err.code === "CART_ITEM_AMBIGUOUS";
      }
      assert(failed, "ambiguous remove should fail");
      const cart = await cartService.getCartForUser(seeded.customer._id);
      assert(cart.items.length === 2, "ambiguous remove deleted rows");
    });

    await test("Shared stock accepts total five and rejects total six across option lines", async () => {
      await cartService.clearCart(seeded.customer._id);
      await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 3, { selectedColor: "Black", selectedSize: "M" });
      const accepted = await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 2, { selectedColor: "Red", selectedSize: "M" });
      assert(accepted.items.reduce((sum, item) => sum + item.quantity, 0) === 5, "total stock five should be accepted");
      let failed = false;
      try {
        await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 1, { selectedColor: "Black", selectedSize: "S" });
      } catch (err) {
        failed = err.code === "CONFLICT";
      }
      assert(failed, "shared product stock should reject total six");
    });

    await test("Shared stock is enforced during update", async () => {
      let failed = false;
      try {
        await cartService.updateItem(seeded.customer._id, seeded.bothOptions._id, 4, { selectedColor: "Black", selectedSize: "M" });
      } catch (err) {
        failed = err.code === "CONFLICT";
      }
      assert(failed, "update should reject aggregate quantity above stock");
    });

    await test("Cart normalization marks aggregate overstock unavailable", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.customer._id },
        {
          user: seeded.customer._id,
          items: [
            { product: seeded.bothOptions._id, quantity: 4, selectedColor: "Black", selectedSize: "M" },
            { product: seeded.bothOptions._id, quantity: 2, selectedColor: "Red", selectedSize: "M" },
          ],
        },
        { upsert: true, new: true }
      );
      const cart = await cartService.getCartForUser(seeded.customer._id);
      assert(cart.items.every((item) => item.available === false), "aggregate overstock should be unavailable");
    });

    await test("Guest cart sync preserves selected options", async () => {
      await cartService.clearCart(seeded.customer._id);
      const synced = await cartService.syncGuestCart(seeded.customer._id, [
        { productId: seeded.bothOptions._id, quantity: 1, selectedColor: "Black", selectedSize: "S" },
      ]);
      assert(synced.cart.items[0].selectedColor === "Black", "synced color missing");
      assert(synced.cart.items[0].selectedSize === "S", "synced size missing");
    });

    await test("Guest cart sync enforces aggregate shared stock", async () => {
      await cartService.clearCart(seeded.customer._id);
      const synced = await cartService.syncGuestCart(seeded.customer._id, [
        { productId: seeded.bothOptions._id, quantity: 3, selectedColor: "Black", selectedSize: "S" },
        { productId: seeded.bothOptions._id, quantity: 3, selectedColor: "Red", selectedSize: "S" },
      ]);
      const total = synced.cart.items.reduce((sum, item) => sum + item.quantity, 0);
      assert(total === 5, "guest sync should cap aggregate quantity to shared stock");
      assert(synced.warnings.some((warning) => warning.code === "QUANTITY_REDUCED"), "guest sync should warn when reducing quantity");
    });

    await test("COD order snapshots selected options", async () => {
      await cartService.clearCart(seeded.customer._id);
      await cartService.addItem(seeded.customer._id, seeded.bothOptions._id, 1, { selectedColor: "Black", selectedSize: "S" });
      const created = await orderService.createCodOrder(
        seeded.customer._id,
        { shippingAddress },
        `${TEST_PREFIX}cod-options`
      );
      assert(created.order.items[0].selectedColor === "Black", "order color snapshot missing");
      assert(created.order.items[0].selectedSize === "S", "order size snapshot missing");
    });

    await test("COD order rejects aggregate overstock legacy cart", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.customer._id },
        {
          user: seeded.customer._id,
          items: [
            { product: seeded.bothOptions._id, quantity: 4, selectedColor: "Black", selectedSize: "M" },
            { product: seeded.bothOptions._id, quantity: 2, selectedColor: "Red", selectedSize: "M" },
          ],
        },
        { upsert: true, new: true }
      );
      let failed = false;
      try {
        await orderService.createCodOrder(
          seeded.customer._id,
          { shippingAddress },
          `${TEST_PREFIX}cod-overstock`
        );
      } catch (err) {
        failed = err.code === "OUT_OF_STOCK";
      }
      assert(failed, "COD should reject aggregate overstock cart");
    });

    await test("Old product/cart/order records remain compatible", async () => {
      const legacyProductId = new mongoose.Types.ObjectId();
      await productModel.collection.insertOne({
        _id: legacyProductId,
        pName: `${TEST_PREFIX}legacy-product`,
        pDescription: "Legacy product with missing Phase 2G fields",
        pPrice: 25,
        pQuantity: 2,
        pCategory: seeded.category._id,
        pImages: ["legacy-a.png", "legacy-b.png"],
        pOffer: "0",
        pStatus: "Active",
      });
      const legacyProduct = await productModel.findById(legacyProductId);
      const publicLegacy = serializeProduct(legacyProduct);
      assert(publicLegacy.inventoryMode === "simple", "legacy product should behave as simple");
      assert(!Object.prototype.hasOwnProperty.call(publicLegacy, "pCost"), "legacy public product leaked cost");
      await cartModel.findOneAndUpdate(
        { user: seeded.customer._id },
        { user: seeded.customer._id, items: [{ product: legacyProductId, quantity: 1 }] },
        { upsert: true, new: true }
      );
      let cart = await cartService.getCartForUser(seeded.customer._id);
      assert(cart.items[0].selectedColor === null && cart.items[0].selectedSize === null, "legacy cart options should default null");
      await cartService.updateItem(seeded.customer._id, legacyProductId, 2);
      cart = await cartService.removeItem(seeded.customer._id, legacyProductId);
      assert(cart.items.length === 0, "legacy simple cart line should remove by product id");
      const legacyOrder = await orderModel.create({
        user: seeded.customer._id,
        allProduct: [{ id: legacyProductId, quantitiy: 1 }],
        amount: 100,
        transactionId: `${TEST_PREFIX}legacy-order`,
        address: "Legacy address",
        phone: 1000000000,
      });
      const normalized = orderService.normalizeOrder(legacyOrder);
      assert(normalized.items[0].selectedColor === null, "legacy selectedColor should default null");
      assert(normalized.items[0].selectedSize === null, "legacy selectedSize should default null");
    });

    await test("Braintree endpoints remain disabled", async () => {
      const token = await request("/api/braintree/get-token", { method: "POST" });
      const payment = await request("/api/braintree/payment", { method: "POST", body: {} });
      assert(token.status === 503, "Braintree token enabled");
      assert(payment.status === 503, "Braintree payment enabled");
    });

    await test("Phase 2G records are cleaned", async () => {
      await cleanup();
      const remaining = await productModel.countDocuments({ pName: new RegExp(`^${TEST_PREFIX}`) });
      assert(remaining === 0, "test products not cleaned");
    });

    console.log(`PRODUCT_CATALOG_SMOKE_PASS ${tests.length} tests`);
  } finally {
    await cleanup().catch(() => {});
    await cleanupUploads().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    if (server && !server.killed) server.kill();
  }
}

main().catch((error) => {
  console.error(`PRODUCT_CATALOG_SMOKE_FAIL: ${error.message}`);
  process.exitCode = 1;
});
