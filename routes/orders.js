const express = require("express");
const router = express.Router();
const { ordersController, disabledOrderResponse } = require("../controller/orders");
const { requireAuth, requireRole } = require("../middleware/auth");

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
  requireAuth,
  requireRole("customer"),
  ordersController.createCodOrder.bind(ordersController)
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
