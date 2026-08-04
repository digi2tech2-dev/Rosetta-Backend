const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { paymentsController } = require("../controller/payments");
const { config } = require("../config/appConfig");
const { optionalCheckoutAuth, requireAuth } = require("../middleware/auth");

const paymentLimiter = rateLimit({
  windowMs: config.authRateLimitWindowMs,
  max: Math.max(config.authRateLimitMax, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: "Too many payment attempts. Please try again later.",
  },
});

router.post(
  "/payments/paymob/intention",
  paymentLimiter,
  optionalCheckoutAuth,
  paymentsController.createPaymobIntention.bind(paymentsController)
);

router.post(
  "/payments/paymob/webhook",
  paymentsController.paymobWebhook.bind(paymentsController)
);

router.get(
  "/payments/:paymentAttemptId/status",
  requireAuth,
  paymentsController.getStatus.bind(paymentsController)
);

router.post(
  "/payments/guest/status",
  paymentLimiter,
  paymentsController.getGuestStatus.bind(paymentsController)
);

module.exports = router;
