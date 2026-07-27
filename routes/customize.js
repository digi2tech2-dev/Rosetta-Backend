const express = require("express");
const router = express.Router();
const customizeController = require("../controller/customize");
const { requireAuth, requireRole } = require("../middleware/auth");
const { imageUpload, uploadErrorHandler } = require("../utils/upload");

const upload = imageUpload("customize", 1);

router.get("/get-slide-image", customizeController.getImages);
router.post(
  "/delete-slide-image",
  requireAuth,
  requireRole("admin"),
  customizeController.deleteSlideImage
);
router.post(
  "/upload-slide-image",
  requireAuth,
  requireRole("admin"),
  upload.single("image"),
  uploadErrorHandler,
  customizeController.uploadSlideImage
);
router.post(
  "/dashboard-data",
  requireAuth,
  requireRole("admin"),
  customizeController.getAllData
);

module.exports = router;
