const express = require("express");
const router = express.Router();
const productController = require("../controller/products");
const { optionalAuth, requireAuth, requireRole } = require("../middleware/auth");
const { imageUpload, uploadErrorHandler } = require("../utils/upload");

const upload = imageUpload("products", 10);

router.get("/all-product", optionalAuth, productController.getAllProduct);
router.post("/product-by-category", productController.getProductByCategory);
router.post("/product-by-price", productController.getProductByPrice);
router.post("/wish-product", productController.getWishProduct);
router.post("/cart-product", productController.getCartProduct);

router.post(
  "/add-product",
  requireAuth,
  requireRole("admin"),
  upload.any(),
  uploadErrorHandler,
  productController.postAddProduct
);
router.post(
  "/edit-product",
  requireAuth,
  requireRole("admin"),
  upload.any(),
  uploadErrorHandler,
  productController.postEditProduct
);
router.post(
  "/delete-product",
  requireAuth,
  requireRole("admin"),
  productController.getDeleteProduct
);
router.post("/single-product", optionalAuth, productController.getSingleProduct);

router.post("/add-review", requireAuth, productController.postAddReview);
router.post("/delete-review", requireAuth, productController.deleteReview);

module.exports = router;
