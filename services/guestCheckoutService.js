const crypto = require("crypto");
const userModel = require("../models/users");
const { config } = require("../config/appConfig");
const { isValidObjectId } = require("../utils/validation");

function httpError(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...extra });
}

function cleanGuestText(value, field, max, required = true) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, "VALIDATION_ERROR", `${field} is required`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw httpError(400, "VALIDATION_ERROR", `${field} must be plain text`);
  }
  const text = String(value).trim().replace(/\s+/g, " ");
  if (required && !text) throw httpError(400, "VALIDATION_ERROR", `${field} is required`);
  if (text.length > max) throw httpError(400, "VALIDATION_ERROR", `${field} is too long`);
  if (/[\u0000-\u001f<>]/.test(text)) {
    throw httpError(400, "VALIDATION_ERROR", `${field} contains invalid characters`);
  }
  return text;
}

function normalizeEmail(value) {
  const email = cleanGuestText(value, "email", 254).toLowerCase();
  if (!/^([a-zA-Z0-9_.+-])+@(([a-zA-Z0-9-])+\.)+([a-zA-Z0-9]{2,})+$/.test(email)) {
    throw httpError(400, "VALIDATION_ERROR", "email is invalid");
  }
  return email;
}

function normalizeEgyptPhone(value) {
  const raw = cleanGuestText(value, "phone", 32);
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0020")) digits = `0${digits.slice(4)}`;
  if (digits.startsWith("20")) digits = `0${digits.slice(2)}`;
  if (digits.length === 10 && digits.startsWith("1")) digits = `0${digits}`;
  if (!/^01[0125]\d{8}$/.test(digits)) {
    throw httpError(400, "VALIDATION_ERROR", "phone must be a valid Egyptian mobile number");
  }
  return digits;
}

function normalizeGuestCustomer(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const fullName = cleanGuestText(value.fullName || value.name, "fullName", 120);
  const email = normalizeEmail(value.email);
  const phone = normalizeEgyptPhone(value.phone || value.phoneNumber);
  return {
    fullName,
    email,
    phone,
    normalizedEmail: email,
    normalizedPhone: phone,
  };
}

function normalizeGuestCartItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw httpError(409, "CART_EMPTY", "Cart is empty");
  }
  if (rawItems.length > config.maxCartItems) {
    throw httpError(400, "VALIDATION_ERROR", "Cart contains too many items");
  }
  return rawItems.map((item) => {
    const value = item && typeof item === "object" ? item : {};
    const productId = String(value.productId || value.product || value.id || "").trim();
    const quantity = Number(value.quantity);
    if (!isValidObjectId(productId)) {
      throw httpError(400, "VALIDATION_ERROR", "Cart item productId must be valid");
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > config.maxItemQuantity) {
      throw httpError(400, "VALIDATION_ERROR", "Cart item quantity is invalid");
    }
    return {
      productId,
      quantity,
      selectedColor: cleanGuestText(value.selectedColor, "selectedColor", 80, false) || null,
      selectedSize: cleanGuestText(value.selectedSize, "selectedSize", 80, false) || null,
    };
  });
}

function guestIdentityHash(guest) {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(`${guest.normalizedEmail}|${guest.normalizedPhone}`)
    .digest("hex");
}

function generateTrackingToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashTrackingToken(token),
  };
}

function hashTrackingToken(token) {
  return crypto
    .createHmac("sha256", config.jwtSecret)
    .update(String(token || ""))
    .digest("hex");
}

function verifyTrackingToken(order, token) {
  const expected = order && order.guestTrackingTokenHash;
  if (!expected || !token) return false;
  const actual = hashTrackingToken(token);
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) {
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(expected));
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function assertGuestNotBlocked(guest) {
  const phoneNumber = Number(guest.normalizedPhone);
  const filters = [
    { email: guest.normalizedEmail },
    { phone: guest.normalizedPhone },
  ];
  if (Number.isFinite(phoneNumber)) filters.push({ phoneNumber });
  const blocked = await userModel.findOne({
    status: { $in: ["blocked", "disabled"] },
    $or: filters,
  });
  if (blocked) {
    throw httpError(403, "CHECKOUT_UNAVAILABLE", "Checkout is unavailable for this customer");
  }
  return true;
}

function publicGuestCustomer(guestCustomer = {}) {
  const email = String(guestCustomer.email || "");
  const phone = String(guestCustomer.phone || "");
  return {
    fullName: guestCustomer.fullName || "",
    email: email ? email.replace(/^(.).+(@.+)$/, "$1***$2") : "",
    phone: phone ? `${phone.slice(0, 3)}****${phone.slice(-2)}` : "",
  };
}

module.exports = {
  assertGuestNotBlocked,
  generateTrackingToken,
  guestIdentityHash,
  hashTrackingToken,
  normalizeGuestCartItems,
  normalizeGuestCustomer,
  publicGuestCustomer,
  verifyTrackingToken,
};
