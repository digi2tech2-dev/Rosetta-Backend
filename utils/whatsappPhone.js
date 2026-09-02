function recipientError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function normalizeEgyptWhatsAppRecipient(value) {
  const raw = String(value || "").trim();
  if (!raw) throw recipientError("INVALID_RECIPIENT", "Customer phone number is missing");

  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0020")) {
    digits = `20${digits.slice(4)}`;
  } else if (digits.startsWith("0")) {
    digits = `20${digits.slice(1)}`;
  } else if (digits.startsWith("1") && digits.length === 10) {
    digits = `20${digits}`;
  }

  if (!/^201[0125]\d{8}$/.test(digits)) {
    throw recipientError("INVALID_RECIPIENT", "Customer phone number is not a supported Egyptian mobile number");
  }
  return digits;
}

function orderRecipientSource(order = {}) {
  return order.shippingAddress?.phone
    || order.customerSnapshot?.phone
    || order.guestCustomer?.phone
    || null;
}

function normalizeOrderWhatsAppRecipient(order) {
  return normalizeEgyptWhatsAppRecipient(orderRecipientSource(order));
}

module.exports = {
  normalizeEgyptWhatsAppRecipient,
  normalizeOrderWhatsAppRecipient,
  orderRecipientSource,
};
