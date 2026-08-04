const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { config } = require("../config/appConfig");
const userModel = require("../models/users");
const { normalizeEmail } = require("../utils/validation");
const { sendPasswordResetCode } = require("./mailService");

const GENERIC_RESET_RESPONSE = "If an account exists for this email, a reset code has been sent.";

function hmac(value) {
  return crypto
    .createHmac("sha256", config.passwordResetPepper)
    .update(String(value))
    .digest("hex");
}

function secureCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function secureToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a), "hex");
  const right = Buffer.from(String(b), "hex");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function resetFieldSelect() {
  return "+resetCodeHash +resetCodeExpiresAt +resetCodeAttempts +resetCodeRequestedAt +resetTokenHash +resetTokenExpiresAt +password";
}

function hasLocalPassword(user) {
  return user && user.authProviders && user.authProviders.local && user.authProviders.local.enabled === false
    ? false
    : Boolean(user && user.password);
}

function resetExpired(user) {
  return !user.resetCodeHash || !user.resetCodeExpiresAt || user.resetCodeExpiresAt.getTime() <= Date.now();
}

async function requestPasswordReset(emailInput) {
  const email = normalizeEmail(emailInput);
  if (!email) {
    return { success: true, message: GENERIC_RESET_RESPONSE };
  }

  const user = await userModel.findOne({ email }).select(resetFieldSelect());
  if (!user || user.status === "blocked" || user.status === "disabled") {
    return { success: true, message: GENERIC_RESET_RESPONSE };
  }

  const now = Date.now();
  const cooldownMs = config.passwordResetResendSeconds * 1000;
  if (user.resetCodeRequestedAt && now - user.resetCodeRequestedAt.getTime() < cooldownMs) {
    return { success: true, message: GENERIC_RESET_RESPONSE };
  }

  const code = secureCode();
  user.resetCodeHash = hmac(code);
  user.resetCodeExpiresAt = new Date(now + config.passwordResetCodeTtlMinutes * 60 * 1000);
  user.resetCodeAttempts = 0;
  user.resetCodeRequestedAt = new Date(now);
  user.resetTokenHash = null;
  user.resetTokenExpiresAt = null;
  await user.save();

  try {
    await sendPasswordResetCode({ to: email, code });
  } catch (err) {
    user.resetCodeHash = null;
    user.resetCodeExpiresAt = null;
    user.resetCodeAttempts = 0;
    user.resetCodeRequestedAt = null;
    await user.save();
  }

  return { success: true, message: GENERIC_RESET_RESPONSE };
}

async function verifyResetCode({ email: emailInput, code }) {
  const email = normalizeEmail(emailInput);
  const normalizedCode = String(code || "").replace(/\D/g, "");
  if (!email || normalizedCode.length !== 6) {
    return { success: false, status: 400, code: "INVALID_RESET_CODE", error: "Reset code is invalid or expired." };
  }

  const user = await userModel.findOne({ email }).select(resetFieldSelect());
  if (!user || user.status === "blocked" || user.status === "disabled" || resetExpired(user)) {
    return { success: false, status: 400, code: "INVALID_RESET_CODE", error: "Reset code is invalid or expired." };
  }

  if ((user.resetCodeAttempts || 0) >= config.passwordResetMaxAttempts) {
    user.resetCodeHash = null;
    user.resetCodeExpiresAt = null;
    await user.save();
    return { success: false, status: 429, code: "RESET_ATTEMPTS_EXCEEDED", error: "Reset code attempts exceeded." };
  }

  if (!safeEqual(user.resetCodeHash, hmac(normalizedCode))) {
    user.resetCodeAttempts = (user.resetCodeAttempts || 0) + 1;
    if (user.resetCodeAttempts >= config.passwordResetMaxAttempts) {
      user.resetCodeHash = null;
      user.resetCodeExpiresAt = null;
    }
    await user.save();
    return { success: false, status: 400, code: "INVALID_RESET_CODE", error: "Reset code is invalid or expired." };
  }

  const resetToken = secureToken();
  user.resetCodeHash = null;
  user.resetCodeExpiresAt = null;
  user.resetCodeAttempts = 0;
  user.resetTokenHash = hmac(resetToken);
  user.resetTokenExpiresAt = new Date(Date.now() + config.passwordResetTokenTtlMinutes * 60 * 1000);
  await user.save();

  return { success: true, resetToken, expiresInMinutes: config.passwordResetTokenTtlMinutes };
}

async function resetPassword({ email: emailInput, resetToken, newPassword, confirmPassword }) {
  const email = normalizeEmail(emailInput);
  if (!email || !resetToken || !newPassword || !confirmPassword) {
    return { success: false, status: 400, code: "VALIDATION_ERROR", error: "All reset fields are required." };
  }
  if (newPassword !== confirmPassword) {
    return { success: false, status: 400, code: "VALIDATION_ERROR", error: "Passwords do not match." };
  }
  if (String(newPassword).length < 8 || String(newPassword).length > 255) {
    return { success: false, status: 400, code: "VALIDATION_ERROR", error: "Password must be at least 8 characters." };
  }

  const user = await userModel.findOne({ email }).select(resetFieldSelect());
  if (!user || !user.resetTokenHash || !user.resetTokenExpiresAt || user.resetTokenExpiresAt.getTime() <= Date.now()) {
    return { success: false, status: 400, code: "INVALID_RESET_TOKEN", error: "Password reset link is invalid or expired." };
  }
  if (!safeEqual(user.resetTokenHash, hmac(resetToken))) {
    return { success: false, status: 400, code: "INVALID_RESET_TOKEN", error: "Password reset link is invalid or expired." };
  }
  const same = hasLocalPassword(user) ? await bcrypt.compare(newPassword, user.password) : false;
  if (same) {
    return { success: false, status: 400, code: "PASSWORD_UNCHANGED", error: "New password must be different from the current password." };
  }

  user.password = bcrypt.hashSync(newPassword, 10);
  user.authProviders = user.authProviders || {};
  user.authProviders.local = { ...(user.authProviders.local || {}), enabled: true };
  user.passwordChangedAt = new Date();
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  user.resetCodeHash = null;
  user.resetCodeExpiresAt = null;
  user.resetCodeAttempts = 0;
  user.resetCodeRequestedAt = null;
  user.resetTokenHash = null;
  user.resetTokenExpiresAt = null;
  await user.save();

  return { success: true, message: "Password reset successfully." };
}

module.exports = {
  GENERIC_RESET_RESPONSE,
  hmac,
  requestPasswordReset,
  resetPassword,
  verifyResetCode,
};
