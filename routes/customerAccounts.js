const express = require("express");
const { imageUpload, uploadErrorHandler } = require("../utils/upload");
const customerAccounts = require("../controller/customerAccounts");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const avatarUpload = imageUpload("avatars", 1);

router.get("/users/me", requireAuth, customerAccounts.getMe);
router.patch("/users/me", requireAuth, customerAccounts.updateMe);
router.patch("/users/me/password", requireAuth, customerAccounts.changePassword);
router.patch(
  "/users/me/avatar",
  requireAuth,
  avatarUpload.single("avatar"),
  uploadErrorHandler,
  customerAccounts.uploadAvatar
);

router.get("/users/me/addresses", requireAuth, customerAccounts.listAddresses);
router.post("/users/me/addresses", requireAuth, customerAccounts.addAddress);
router.patch("/users/me/addresses/:addressId", requireAuth, customerAccounts.updateAddress);
router.delete("/users/me/addresses/:addressId", requireAuth, customerAccounts.deleteAddress);
router.patch("/users/me/addresses/:addressId/default", requireAuth, customerAccounts.setDefaultAddress);

router.get("/admin/users", requireAuth, requireRole("admin"), customerAccounts.listAdminUsers);
router.get("/admin/users/:userId", requireAuth, requireRole("admin"), customerAccounts.getAdminUser);
router.patch("/admin/users/:userId/status", requireAuth, requireRole("admin"), customerAccounts.updateAdminUserStatus);

module.exports = router;
