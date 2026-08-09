const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const orderModel = require("../models/orders");
const cartModel = require("../models/carts");
const productController = require("../controller/products");
const orderService = require("../services/orderService");
const { normalizeGuestCustomer } = require("../services/guestCheckoutService");
const { serializeProduct } = require("../services/productSerializer");
const { clearFakeMessages, getFakeMessages } = require("../services/mailService");

const REQUIRED_DB = process.env.STABILIZATION_SMOKE_DATABASE_NAME || "client_store_stabilization_disposable";
const TEST_PREFIX = "stabilization-smoke-";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function uploadFile(filename) {
  return { filename, originalname: filename };
}

function baseProductFields(category, suffix, overrides = {}) {
  return {
    pName: `${TEST_PREFIX}${suffix}`,
    pDescription: "Focused stabilization product",
    pPrice: "100",
    pQuantity: "20",
    pCategory: String(category._id),
    pOffer: "0",
    pStatus: "Active",
    pColorImages: "{}",
    ...overrides,
  };
}

async function cleanup() {
  const users = await userModel.find({ email: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const userIds = users.map((user) => user._id);
  const products = await productModel.find({ pName: new RegExp(`^${TEST_PREFIX}`) }).select("_id");
  const productIds = products.map((product) => product._id);
  await orderModel.deleteMany({
    $or: [
      { user: { $in: userIds } },
      { "items.product": { $in: productIds } },
      { idempotencyKey: new RegExp(`^${TEST_PREFIX}`) },
      { idempotencyScope: new RegExp(`^guest:`) },
    ],
  });
  await cartModel.deleteMany({ user: { $in: userIds } });
  await productModel.deleteMany({ _id: { $in: productIds } });
  await categoryModel.deleteMany({ cName: new RegExp(`^${TEST_PREFIX}`) });
  await userModel.deleteMany({ _id: { $in: userIds } });
}

async function seed() {
  const category = await categoryModel.create({
    cName: `${TEST_PREFIX}category`,
    cDescription: "Disposable stabilization category",
    cStatus: "Active",
    cImage: "fixture.png",
  });
  const registered = await userModel.create({
    name: "Registered Account Name",
    email: `${TEST_PREFIX}registered@example.com`,
    password: bcrypt.hashSync("Password123!", 10),
    userRole: 0,
    status: "active",
  });
  return { category, registered };
}

const shippingAddress = {
  fullName: "Order Snapshot Name",
  phone: "+201000000000",
  governorate: "Cairo",
  city: "Nasr City",
  street: "Snapshot Street",
};

function guestCustomer(overrides = {}) {
  return {
    fullName: "Guest Visible Name",
    phone: "+201000000000",
    email: `${TEST_PREFIX}guest@example.com`,
    ...overrides,
  };
}

function cart(product, quantity = 1) {
  return [{ productId: String(product._id), quantity }];
}

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE, { requiredDatabaseName: REQUIRED_DB });
  assert(config.nodeEnv === "test", "NODE_ENV=test is required");
  assert(config.jwtSecret && config.jwtSecret.length >= 16, "JWT_SECRET is required");
  await mongoose.connect(process.env.DATABASE, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
  await cleanup();
  await Promise.all([productModel.init(), orderModel.init()]);
  clearFakeMessages();
  const tests = [];
  async function test(name, fn) {
    await fn();
    tests.push(name);
    console.log(`${tests.length}. ${name}: PASS`);
  }

  try {
    const seeded = await seed();

    let merchantProductId;
    await test("create product with merchant persists admin-only metadata", async () => {
      const created = await invokeController(productController.postAddProduct, {
        body: baseProductFields(seeded.category, "merchant-create", {
          pMerchantName: "  Cairo Supplier  ",
        }),
        files: [uploadFile("merchant-a.png"), uploadFile("merchant-b.png")],
      });
      assert(created.status === 200, "merchant product create failed");
      merchantProductId = created.body.Product._id;
      const saved = await productModel.findById(merchantProductId).lean();
      assert(saved.pMerchantName === "Cairo Supplier", "merchant name was not trimmed and persisted");
      assert(created.body.Product.pMerchantName === "Cairo Supplier", "admin create response missed merchant name");
      assert(!Object.prototype.hasOwnProperty.call(serializeProduct(saved), "pMerchantName"), "public product serialization leaked merchant name");
    });

    await test("edit merchant persists and create without merchant remains valid", async () => {
      const product = await productModel.findById(merchantProductId).lean();
      const edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "merchant-create", {
          pId: String(product._id),
          pDescription: product.pDescription,
          pImages: JSON.stringify(product.pImages),
          pMerchantName: "Alexandria Supplier",
        }),
        files: [],
      });
      assert(edited.status === 200, "merchant edit failed");
      let saved = await productModel.findById(merchantProductId).lean();
      assert(saved.pMerchantName === "Alexandria Supplier", "merchant edit did not persist");
      const withoutMerchant = await invokeController(productController.postAddProduct, {
        body: baseProductFields(seeded.category, "no-merchant"),
        files: [uploadFile("no-merchant-a.png"), uploadFile("no-merchant-b.png")],
      });
      assert(withoutMerchant.status === 200, "product without merchant should be valid");
      saved = await productModel.findById(withoutMerchant.body.Product._id).lean();
      assert(saved.pMerchantName === null || saved.pMerchantName === undefined, "missing merchant should stay empty");
    });

    await test("non-string merchant values are rejected", async () => {
      const product = await productModel.findById(merchantProductId).lean();
      const invalid = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "merchant-create", {
          pId: String(product._id),
          pImages: JSON.stringify(product.pImages),
          pMerchantName: { bad: true },
        }),
        files: [],
      });
      assert(invalid.status === 400 && invalid.body.code === "VALIDATION_ERROR", "non-string merchant should fail validation");
    });

    let colorProduct;
    await test("color image edits preserve unchanged images with zero new uploads", async () => {
      colorProduct = await productModel.create({
        pName: `${TEST_PREFIX}color-product`,
        pDescription: "Color edit product",
        pPrice: 150,
        pQuantity: 20,
        pCategory: seeded.category._id,
        pImages: ["main-a.png", "main-b.png"],
        pOffer: "0",
        pStatus: "Active",
        pColors: ["Black", "Red"],
        pColorImages: { Black: { fileName: "black.png" }, Red: { fileName: "red.png" } },
        inventoryMode: "shared_options",
      });
      for (const [field, value] of [
        ["pName", `${TEST_PREFIX}color-product-renamed`],
        ["pDescription", "Description changed only"],
        ["pPrice", "175"],
      ]) {
        const body = baseProductFields(seeded.category, "color-product", {
          pId: String(colorProduct._id),
          pName: colorProduct.pName,
          pDescription: colorProduct.pDescription,
          pPrice: String(colorProduct.pPrice),
          pImages: JSON.stringify(colorProduct.pImages),
          pColors: "Black, Red",
          pColorImages: JSON.stringify({ Black: "black.png", Red: "red.png" }),
          [field]: value,
        });
        const edited = await invokeController(productController.postEditProduct, { body, files: [] });
        assert(edited.status === 200, `${field} edit with unchanged color images failed`);
      }
      const saved = await productModel.findById(colorProduct._id).lean();
      assert(saved.pColorImages.Black.fileName === "black.png" && saved.pColorImages.Red.fileName === "red.png", "unchanged color images were not preserved");
    });

    await test("color label edit, replace, add, remove, and two-file mapping stay isolated", async () => {
      let edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-label", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Red",
          pColorImages: JSON.stringify({ Jet: "black.png", Red: "red.png" }),
        }),
        files: [],
      });
      assert(edited.status === 200, "color label edit without image change failed");

      edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-replace", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Red",
          pColorImages: JSON.stringify({ Jet: "black.png", Red: { fileName: "red-new.png", uploadIndex: 0 } }),
        }),
        files: [uploadFile("red-new.png")],
      });
      assert(edited.status === 200, "replace one color image failed");
      let saved = await productModel.findById(colorProduct._id).lean();
      assert(saved.pColorImages.Jet.fileName === "black.png" && saved.pColorImages.Red.fileName === "red-new.png", "replace changed the wrong color image");

      edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-add", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Red, Blue",
          pColorImages: JSON.stringify({ Jet: "black.png", Red: "red-new.png", Blue: { fileName: "blue.png", uploadIndex: 0 } }),
        }),
        files: [uploadFile("blue.png")],
      });
      assert(edited.status === 200, "add color image failed");
      saved = await productModel.findById(colorProduct._id).lean();
      assert(saved.pColorImages.Blue.fileName === "blue.png", "new color image was not mapped");

      edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-remove", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Blue",
          pColorImages: JSON.stringify({ Jet: "black.png", Blue: "blue.png" }),
        }),
        files: [],
      });
      assert(edited.status === 200, "remove color failed");
      saved = await productModel.findById(colorProduct._id).lean();
      assert(!saved.pColorImages.Red && saved.pColorImages.Blue.fileName === "blue.png", "removed color association remained");

      edited = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-two-files", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Blue",
          pColorImages: JSON.stringify({
            Jet: { fileName: "jet-new.png", uploadIndex: 0 },
            Blue: { fileName: "blue-new.png", uploadIndex: 1 },
          }),
        }),
        files: [uploadFile("jet-new.png"), uploadFile("blue-new.png")],
      });
      assert(edited.status === 200, "two color image upload failed");
      saved = await productModel.findById(colorProduct._id).lean();
      assert(saved.pColorImages.Jet.fileName === "jet-new.png" && saved.pColorImages.Blue.fileName === "blue-new.png", "two color images swapped or failed");
    });

    await test("malformed color upload indexes fail but retained paths are not treated as uploads", async () => {
      let invalid = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-invalid-index", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Blue",
          pColorImages: JSON.stringify({ Jet: { uploadIndex: 99 }, Blue: "blue-new.png" }),
        }),
        files: [],
      });
      assert(invalid.status === 400 && invalid.body.code === "INVALID_COLOR_IMAGE", "malformed upload index should be rejected");

      const retained = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-retained-index", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Blue",
          pColorImages: JSON.stringify({ Jet: { fileName: "jet-new.png", uploadIndex: 99 }, Blue: { fileName: "blue-new.png" } }),
        }),
        files: [],
      });
      assert(retained.status === 200, "retained image path with stale uploadIndex should not fail");

      const mainUploadSameName = await invokeController(productController.postEditProduct, {
        body: baseProductFields(seeded.category, "color-product-main-upload", {
          pId: String(colorProduct._id),
          pImages: JSON.stringify(["main-a.png", "main-b.png"]),
          pColors: "Jet, Blue",
          pColorImages: JSON.stringify({ Jet: { fileName: "jet-new.png" }, Blue: "blue-new.png" }),
        }),
        files: [uploadFile("jet-new.png")],
      });
      assert(mainUploadSameName.status === 200, "main image upload with retained color filename should not become INVALID_COLOR_IMAGE");
    });

    await test("guest email is optional but invalid non-empty email is rejected", async () => {
      const validEmail = normalizeGuestCustomer(guestCustomer({ email: `${TEST_PREFIX}valid@example.com` }));
      const missingEmail = normalizeGuestCustomer(guestCustomer({ email: undefined }));
      const emptyEmail = normalizeGuestCustomer(guestCustomer({ email: "" }));
      assert(validEmail.email === `${TEST_PREFIX}valid@example.com`, "valid email did not normalize");
      assert(missingEmail.email === null && emptyEmail.email === null, "missing or empty email should normalize to null");
      let failed = false;
      try {
        normalizeGuestCustomer(guestCustomer({ email: "not-an-email" }));
      } catch (err) {
        failed = err.code === "VALIDATION_ERROR";
      }
      assert(failed, "invalid non-empty email should fail");
    });

    let guestOrderId;
    await test("guest COD works with valid, missing, and empty email without notifications", async () => {
      clearFakeMessages();
      for (const [label, email] of [["valid", `${TEST_PREFIX}cod@example.com`], ["missing", undefined], ["empty", ""]]) {
        const result = await orderService.createGuestCodOrder({
          guestCustomer: guestCustomer({ email }),
          shippingAddress,
          cartItems: cart(await productModel.findById(merchantProductId)),
        }, `${TEST_PREFIX}guest-cod-${label}`);
        assert(result.order.customerType === "guest", `${label} guest COD failed`);
        if (label === "missing") guestOrderId = result.order.id;
      }
      assert(getFakeMessages().length === 0, "guest COD without email should not trigger email notifications");
    });

    await test("authenticated checkout persists customer snapshot and remains unaffected", async () => {
      await cartModel.findOneAndUpdate(
        { user: seeded.registered._id },
        { user: seeded.registered._id, items: [{ product: merchantProductId, quantity: 1 }] },
        { upsert: true, new: true, runValidators: true }
      );
      const result = await orderService.createCodOrder(
        seeded.registered._id,
        { shippingAddress },
        `${TEST_PREFIX}registered-cod`
      );
      assert(result.order.customerType === "registered", "registered checkout failed");
      assert(result.order.customer.name === shippingAddress.fullName, "registered order did not use order-time customer snapshot");
      await userModel.findByIdAndUpdate(seeded.registered._id, { name: "Changed Later" });
      const normalized = orderService.normalizeOrder(await orderModel.findById(result.order.id).populate("user", "name email phoneNumber"));
      assert(normalized.customer.name === shippingAddress.fullName, "order customer snapshot changed after profile edit");
    });

    await test("order snapshots preserve merchant after product edit and admin serialization exposes it", async () => {
      const order = await orderModel.findById(guestOrderId).lean();
      assert(order.items[0].merchantName === "Alexandria Supplier", "order item did not snapshot merchant");
      await productModel.findByIdAndUpdate(merchantProductId, { pMerchantName: "Changed Supplier" });
      const adminOrder = await orderService.getAdminOrder(guestOrderId);
      assert(adminOrder.items[0].merchantName === "Alexandria Supplier", "historical merchant snapshot changed after product edit");
      assert(adminOrder.customer.name === "Guest Visible Name", "admin order missed guest customer name");
      assert(adminOrder.guestCustomer.email === "", "admin guest order without email should serialize empty email safely");
    });

    await test("legacy guest order without customer or merchant serializes safely", async () => {
      const legacy = await orderModel.create({
        customerType: "guest",
        orderNumber: `${TEST_PREFIX}LEGACY`,
        items: [{
          product: merchantProductId,
          name: "Legacy Line",
          unitPrice: 10,
          quantity: 1,
          lineTotal: 10,
        }],
        subtotal: 10,
        total: 10,
        amount: 10,
        currency: "EGP",
        shippingAddress: { phone: "01000000000", street: "Legacy Street" },
        paymentMethod: "cash_on_delivery",
        paymentStatus: "unpaid",
        orderStatus: "pending",
        status: "Not processed",
      });
      const normalized = orderService.normalizeOrder(legacy, { admin: true });
      assert(normalized.customer.name === "زائر", "legacy guest fallback name mismatch");
      assert(normalized.items[0].merchantName === null, "legacy order without merchant should serialize null");
    });

    console.log(`STABILIZATION_SMOKE_PASS ${tests.length} tests`);
  } finally {
    await cleanup().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch(async (err) => {
  console.error(`STABILIZATION_SMOKE_FAIL: ${err.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
