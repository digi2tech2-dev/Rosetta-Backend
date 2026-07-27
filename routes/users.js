const express = require("express");
const router = express.Router();
const usersController = require("../controller/users");
const { requireAuth, requireRole, requireSelfOrRole } = require("../middleware/auth");

router.get("/all-user", requireAuth, requireRole("admin"), usersController.getAllUser);
router.post(
  "/signle-user",
  requireAuth,
  requireSelfOrRole((req) => req.body.uId || req.auth.userId, "admin"),
  usersController.getSingleUser
);

router.post("/add-user", requireAuth, requireRole("admin"), usersController.postAddUser);
router.post(
  "/edit-user",
  requireAuth,
  requireSelfOrRole((req) => req.body.uId || req.auth.userId, "admin"),
  usersController.postEditUser
);
router.post("/delete-user", requireAuth, requireRole("admin"), usersController.getDeleteUser);

router.post("/change-password", requireAuth, usersController.changePassword);

module.exports = router;
