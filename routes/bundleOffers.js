const express = require("express");
const router = express.Router();
const bundleOffersController = require("../controller/bundleOffers");
const { requireAuth, requireRole } = require("../middleware/auth");

router.get("/bundle-offers/by-product/:productId", bundleOffersController.getByProduct.bind(bundleOffersController));

router.get(
  "/admin/bundle-offers",
  requireAuth,
  requireRole("admin"),
  bundleOffersController.listAdmin.bind(bundleOffersController)
);
router.post(
  "/admin/bundle-offers",
  requireAuth,
  requireRole("admin"),
  bundleOffersController.createAdmin.bind(bundleOffersController)
);
router.patch(
  "/admin/bundle-offers/:offerId",
  requireAuth,
  requireRole("admin"),
  bundleOffersController.updateAdmin.bind(bundleOffersController)
);
router.delete(
  "/admin/bundle-offers/:offerId",
  requireAuth,
  requireRole("admin"),
  bundleOffersController.deleteAdmin.bind(bundleOffersController)
);

module.exports = router;
