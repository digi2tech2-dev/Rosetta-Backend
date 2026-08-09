const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { commerceController } = require("../controller/commerce");
const { config } = require("../config/appConfig");
const { optionalCheckoutAuth, requireAuth, requireRole } = require("../middleware/auth");

const checkoutLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  max: Math.max(config.authRateLimitMax, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: "Too many checkout attempts. Please try again later.",
  },
});

router.post(
  "/checkout/quote",
  checkoutLimiter,
  optionalCheckoutAuth,
  commerceController.quote.bind(commerceController)
);
router.post(
  "/checkout/shipping-promotion",
  checkoutLimiter,
  commerceController.shippingPromotion.bind(commerceController)
);

router.get(
  "/admin/coupons",
  requireAuth,
  requireRole("admin"),
  commerceController.listCoupons.bind(commerceController)
);
router.post(
  "/admin/coupons",
  requireAuth,
  requireRole("admin"),
  commerceController.createCoupon.bind(commerceController)
);
router.get(
  "/admin/coupons/:couponId",
  requireAuth,
  requireRole("admin"),
  commerceController.getCoupon.bind(commerceController)
);
router.patch(
  "/admin/coupons/:couponId",
  requireAuth,
  requireRole("admin"),
  commerceController.updateCoupon.bind(commerceController)
);
router.patch(
  "/admin/coupons/:couponId/status",
  requireAuth,
  requireRole("admin"),
  commerceController.updateCouponStatus.bind(commerceController)
);
router.delete(
  "/admin/coupons/:couponId",
  requireAuth,
  requireRole("admin"),
  commerceController.deleteCoupon.bind(commerceController)
);

router.get(
  "/admin/shipping-rules",
  requireAuth,
  requireRole("admin"),
  commerceController.listShippingRules.bind(commerceController)
);
router.post(
  "/admin/shipping-rules",
  requireAuth,
  requireRole("admin"),
  commerceController.createShippingRule.bind(commerceController)
);
router.get(
  "/admin/shipping-rules/:ruleId",
  requireAuth,
  requireRole("admin"),
  commerceController.getShippingRule.bind(commerceController)
);
router.patch(
  "/admin/shipping-rules/:ruleId",
  requireAuth,
  requireRole("admin"),
  commerceController.updateShippingRule.bind(commerceController)
);
router.patch(
  "/admin/shipping-rules/:ruleId/status",
  requireAuth,
  requireRole("admin"),
  commerceController.updateShippingRuleStatus.bind(commerceController)
);
router.delete(
  "/admin/shipping-rules/:ruleId",
  requireAuth,
  requireRole("admin"),
  commerceController.deleteShippingRule.bind(commerceController)
);

router.get(
  "/admin/commerce-settings",
  requireAuth,
  requireRole("admin"),
  commerceController.getSettings.bind(commerceController)
);
router.patch(
  "/admin/commerce-settings",
  requireAuth,
  requireRole("admin"),
  commerceController.updateSettings.bind(commerceController)
);

module.exports = router;
