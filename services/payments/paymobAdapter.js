const { config } = require("../../config/appConfig");

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function ensureConfigured() {
  if (!config.paymobEnabled) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Online payment is temporarily unavailable");
  }
  const missing = [
    ["PAYMOB_SECRET_KEY", config.paymobSecretKey],
    ["PAYMOB_PUBLIC_KEY", config.paymobPublicKey],
    ["PAYMOB_BASE_URL", config.paymobBaseUrl],
    ["PAYMOB_CHECKOUT_BASE_URL", config.paymobCheckoutBaseUrl],
  ].filter(([, value]) => !value);
  if (missing.length) {
    throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Online payment is temporarily unavailable");
  }
}

function safeBilling(customer, shippingAddress) {
  const [firstName, ...rest] = String(shippingAddress.fullName || customer.name || "Rosetta Customer").trim().split(/\s+/);
  return {
    first_name: firstName || "Rosetta",
    last_name: rest.join(" ") || "Customer",
    email: String(customer.email || "customer@example.invalid").trim().slice(0, 120),
    phone_number: String(shippingAddress.phone || customer.phoneNumber || "+200000000000").trim().slice(0, 32),
    country: "EG",
    city: String(shippingAddress.city || shippingAddress.governorate || "Cairo").slice(0, 80),
    street: String(shippingAddress.street || "Not provided").slice(0, 180),
    building: String(shippingAddress.building || "NA").slice(0, 40),
    floor: String(shippingAddress.apartment || "NA").slice(0, 40),
    apartment: String(shippingAddress.apartment || "NA").slice(0, 40),
  };
}

function buildCheckoutUrl(clientSecret) {
  const base = String(config.paymobCheckoutBaseUrl || config.paymobBaseUrl).replace(/\/+$/, "");
  const params = new URLSearchParams({
    publicKey: config.paymobPublicKey,
    clientSecret,
  });
  return `${base}/unifiedcheckout/?${params.toString()}`;
}

class PaymobAdapter {
  async createIntention(payload) {
    ensureConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.paymobTimeoutMs);
    try {
      const response = await fetch(`${String(config.paymobBaseUrl).replace(/\/+$/, "")}/v1/intention/`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Token ${config.paymobSecretKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          amount: payload.amountMinor,
          currency: payload.currency,
          payment_methods: payload.integrations,
          notification_url: payload.notificationUrl,
          redirection_url: payload.redirectionUrl,
          items: payload.items.map((item) => ({
            name: item.name,
            amount: item.amountMinor,
            description: "Rosetta order item",
            quantity: item.quantity,
          })),
          billing_data: safeBilling(payload.customer, payload.shippingAddress || {}),
          customer: {
            first_name: safeBilling(payload.customer, payload.shippingAddress || {}).first_name,
            last_name: safeBilling(payload.customer, payload.shippingAddress || {}).last_name,
            email: String(payload.customer.email || "customer@example.invalid").slice(0, 120),
          },
          extras: {
            rosetta_reference: payload.internalReference,
            order_id: payload.internalReference,
          },
        }),
      });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (err) {
        throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider returned an invalid response");
      }
      if (!response.ok) {
        throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider is temporarily unavailable");
      }
      if (!data.client_secret || !data.id) {
        throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider response was incomplete");
      }
      return {
        providerIntentionId: String(data.id),
        providerOrderId: data.intention_order_id ? String(data.intention_order_id) : "",
        clientSecret: String(data.client_secret),
        checkoutUrl: buildCheckoutUrl(String(data.client_secret)),
      };
    } catch (err) {
      if (err.name === "AbortError") {
        throw httpError(503, "PAYMENT_PROVIDER_TIMEOUT", "Payment provider timed out");
      }
      if (err.status) throw err;
      throw httpError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "Payment provider is temporarily unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  PaymobAdapter,
  buildCheckoutUrl,
};
