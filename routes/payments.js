const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { paymentsController } = require("../controller/payments");
const { config } = require("../config/appConfig");
const { optionalCheckoutAuth, requireAuth } = require("../middleware/auth");

const paymentLimiter = rateLimit({
  windowMs: config.paymentRateLimitWindowMs,
  max: config.paymentRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: "Too many payment attempts. Please try again later.",
  },
});

const paymentStatusLimiter = rateLimit({
  windowMs: config.paymentRateLimitWindowMs,
  max: config.paymentStatusRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: "RATE_LIMITED",
    error: "Too many payment status requests. Please try again later.",
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
  paymentStatusLimiter,
  paymentsController.getGuestStatus.bind(paymentsController)
);

module.exports = router;
