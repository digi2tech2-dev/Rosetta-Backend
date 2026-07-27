const braintree = require("braintree");
const { config } = require("../config/appConfig");

const disabledBraintreeResponse = {
  success: false,
  code: "LEGACY_BRAINTREE_DISABLED",
  message: "Legacy Braintree checkout is temporarily unavailable while checkout security is being upgraded.",
};

function createGateway() {
  const environment =
    config.braintreeEnvironment === "Production"
      ? braintree.Environment.Production
      : braintree.Environment.Sandbox;

  return new braintree.BraintreeGateway({
    environment,
    merchantId: config.braintreeMerchantId,
    publicKey: config.braintreePublicKey,
    privateKey: config.braintreePrivateKey,
  });
}

class BrainTree {
  generateToken(req, res) {
    if (!config.legacyBraintreeEnabled) {
      return res.status(503).json(disabledBraintreeResponse);
    }

    const gateway = createGateway();
    return gateway.clientToken.generate({}, (err, response) => {
      if (err) {
        return res.status(502).json({ success: false, error: "Payment provider unavailable" });
      }
      return res.json(response);
    });
  }

  ganerateToken(req, res) {
    return this.generateToken(req, res);
  }

  paymentProcess(req, res) {
    if (!config.legacyBraintreeEnabled) {
      return res.status(503).json(disabledBraintreeResponse);
    }

    const { amountTotal, paymentMethod } = req.body;
    const gateway = createGateway();
    return gateway.transaction.sale(
      {
        amount: amountTotal,
        paymentMethodNonce: paymentMethod,
        options: {
          submitForSettlement: true,
        },
      },
      (err, result) => {
        if (err) {
          return res.status(502).json({ success: false, error: "Payment provider unavailable" });
        }

        if (result.success) {
          return res.json(result);
        }
        return res.status(400).json({ success: false, error: "Payment failed" });
      }
    );
  }
}

module.exports = {
  brainTreeController: new BrainTree(),
  disabledBraintreeResponse,
};
