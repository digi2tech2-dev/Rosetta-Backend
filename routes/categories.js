const express = require("express");
const router = express.Router();
const categoryController = require("../controller/categories");
const { requireAuth, requireRole } = require("../middleware/auth");
const { imageUpload, uploadErrorHandler } = require("../utils/upload");

const upload = imageUpload("categories", 1);

router.get("/all-category", categoryController.getAllCategory);
router.post(
  "/add-category",
  requireAuth,
  requireRole("admin"),
  upload.single("cImage"),
  uploadErrorHandler,
  categoryController.postAddCategory
);
router.post(
  "/edit-category",
  requireAuth,
  requireRole("admin"),
  categoryController.postEditCategory
);
router.post(
  "/delete-category",
  requireAuth,
  requireRole("admin"),
  categoryController.getDeleteCategory
);

module.exports = router;
