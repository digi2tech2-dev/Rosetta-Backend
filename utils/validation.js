const mongoose = require("mongoose");

function isValidObjectId(value) {
  return Boolean(value) && mongoose.Types.ObjectId.isValid(String(value));
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function requireObjectId(res, value, fieldName) {
  if (!isValidObjectId(value)) {
    res.status(400).json({
      success: false,
      error: `${fieldName} must be a valid id`,
    });
    return false;
  }
  return true;
}

function pickAllowed(source, allowedFields) {
  const picked = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      picked[field] = source[field];
    }
  });
  return picked;
}

function isValidRole(value) {
  return value === 0 || value === 1 || value === "0" || value === "1";
}

module.exports = {
  isValidObjectId,
  normalizeEmail,
  requireObjectId,
  pickAllowed,
  isValidRole,
};
