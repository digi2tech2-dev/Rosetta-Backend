const express = require("express");
const router = express.Router();
const { brainTreeController, disabledBraintreeResponse } = require("../controller/braintree");
const { config } = require("../config/appConfig");
const { requireAuth } = require("../middleware/auth");

function legacyBraintreeDisabled(req, res, next) {
  if (!config.legacyBraintreeEnabled) {
    return res.status(503).json(disabledBraintreeResponse);
  }
  return next();
}

router.post(
  "/braintree/get-token",
  legacyBraintreeDisabled,
  requireAuth,
  brainTreeController.generateToken.bind(brainTreeController)
);
router.post(
  "/braintree/payment",
  legacyBraintreeDisabled,
  requireAuth,
  brainTreeController.paymentProcess.bind(brainTreeController)
);

module.exports = router;
