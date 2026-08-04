const crypto = require("crypto");
const { config } = require("../../config/appConfig");

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

class FakePaymobAdapter {
  constructor() {
    if (config.nodeEnv !== "test" || config.paymobAdapter !== "fake") {
      throw httpError(500, "PAYMENT_FAKE_ADAPTER_FORBIDDEN", "Fake payment adapter is test-only");
    }
    this.requests = [];
  }

  async createIntention(payload) {
    this.requests.push({
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      integrations: payload.integrations,
      internalReference: payload.internalReference,
      items: payload.items,
    });
    if (process.env.PAYMOB_FAKE_BEHAVIOR === "fail") {
      throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider is temporarily unavailable");
    }
    if (process.env.PAYMOB_FAKE_BEHAVIOR === "timeout") {
      throw httpError(503, "PAYMENT_PROVIDER_TIMEOUT", "Payment provider timed out");
    }
    if (process.env.PAYMOB_FAKE_BEHAVIOR === "malformed") {
      return {};
    }
    const digest = crypto.createHash("sha256").update(payload.internalReference).digest("hex").slice(0, 18);
    const clientSecret = `cs_test_${digest}`;
    return {
      providerIntentionId: `pi_test_${digest}`,
      providerOrderId: `po_test_${digest}`,
      clientSecret,
      checkoutUrl: `https://checkout.test.paymob.local/unifiedcheckout/?publicKey=pk_test_placeholder&clientSecret=${clientSecret}`,
    };
  }
}

module.exports = {
  FakePaymobAdapter,
};
