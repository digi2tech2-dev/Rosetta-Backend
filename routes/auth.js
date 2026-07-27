const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const authController = require("../controller/auth");
const { config } = require("../config/appConfig");
const { requireAuth, requireRole } = require("../middleware/auth");

const authLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  max: config.authRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many authentication attempts. Please try again later.",
  },
});

router.post("/isadmin", requireAuth, authController.isAdmin);
router.post("/signup", authLimiter, authController.postSignup);
router.post("/signin", authLimiter, authController.postSignin);
router.post("/user", requireAuth, requireRole("admin"), authController.allUser);

module.exports = router;
