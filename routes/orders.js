const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { ordersController, disabledOrderResponse } = require("../controller/orders");
const { config } = require("../config/appConfig");
const { optionalCheckoutAuth, requireAuth, requireRole } = require("../middleware/auth");

const guestTrackingLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  max: Math.max(config.authRateLimitMax, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: "Too many order attempts. Please try again later.",
  },
});

function legacyOrderCreationDisabled(req, res) {
  return res.status(503).json(disabledOrderResponse);
}

router.get(
  "/get-all-orders",
  requireAuth,
  requireRole("admin"),
  ordersController.getAllOrders
);
router.post("/order-by-user", requireAuth, ordersController.getOrderByUser);

router.post("/create-order", legacyOrderCreationDisabled);
router.post(
  "/create-cod-order",
  guestTrackingLimiter,
  optionalCheckoutAuth,
  ordersController.createCodOrder.bind(ordersController)
);
router.post(
  "/guest/track",
  guestTrackingLimiter,
  ordersController.trackGuestOrder.bind(ordersController)
);
router.get("/my-orders", requireAuth, ordersController.getMyOrders.bind(ordersController));
router.get(
  "/my-orders/:orderId",
  requireAuth,
  ordersController.getMyOrder.bind(ordersController)
);
router.get(
  "/admin/orders",
  requireAuth,
  requireRole("admin"),
  ordersController.getAdminOrders.bind(ordersController)
);
router.get(
  "/admin/orders/:orderId",
  requireAuth,
  requireRole("admin"),
  ordersController.getAdminOrder.bind(ordersController)
);
router.patch(
  "/admin/orders/:orderId/status",
  requireAuth,
  requireRole("admin"),
  ordersController.patchAdminOrderStatus.bind(ordersController)
);
router.post(
  "/update-order",
  requireAuth,
  requireRole("admin"),
  ordersController.postUpdateOrder.bind(ordersController)
);
router.post(
  "/delete-order",
  requireAuth,
  requireRole("admin"),
  ordersController.postDeleteOrder
);

module.exports = router;
