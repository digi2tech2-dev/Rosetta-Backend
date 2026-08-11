const express = require("express");
const router = express.Router();
const cartController = require("../controller/cart");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("customer", "admin"));

router.get("/", cartController.getCart);
router.post("/items", cartController.addItem);
router.post("/bundles", cartController.addBundle);
router.patch("/items/:productId", cartController.updateItem);
router.delete("/items/:productId", cartController.removeItem);
router.delete("/", cartController.clearCart);
router.post("/sync", cartController.sync);

module.exports = router;
