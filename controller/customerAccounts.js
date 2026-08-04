const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const userModel = require("../models/users");
const orderModel = require("../models/orders");
const { normalizeEmail, pickAllowed, isValidObjectId } = require("../utils/validation");
const {
  normalizedStatus,
  serializeAdminCustomer,
  serializeCustomerListItem,
  serializeCustomerSelf,
} = require("../services/customerSerializer");
const { uploadFilePath, uploadPublicUrl } = require("../utils/uploadPaths");

const ADDRESS_FIELDS = [
  "label",
  "fullName",
  "phone",
  "alternatePhone",
  "governorate",
  "city",
  "area",
  "street",
  "building",
  "floor",
  "apartment",
  "landmark",
  "postalCode",
  "notes",
  "isDefault",
];
const MAX_ADDRESSES = 10;
const PHONE_RE = /^(\+?\d[\d\s-]{6,18}|\d{7,20})$/;

function isBlocked(user) {
  return user && (user.status === "blocked" || user.status === "disabled");
}

function trim(value, max = 255) {
  if (value === undefined || value === null) return "";
  return String(value).trim().slice(0, max);
}

function normalizePhone(value) {
  const phone = trim(value, 20);
  return phone || null;
}

function normalizeAddress(body) {
  const source = pickAllowed(body, ADDRESS_FIELDS);
  const next = {};
  for (const field of ADDRESS_FIELDS) {
    if (field === "isDefault") continue;
    if (source[field] !== undefined) {
      next[field] = trim(source[field], field === "notes" ? 500 : 180);
    }
  }
  if (source.isDefault !== undefined) {
    next.isDefault = Boolean(source.isDefault);
  }
  if (!next.label) next.label = "Home";
  if (!next.fullName || !next.phone || !next.governorate || !next.city || !next.street) {
    const err = new Error("Required address fields are missing");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (!PHONE_RE.test(next.phone) || (next.alternatePhone && !PHONE_RE.test(next.alternatePhone))) {
    const err = new Error("Address phone number is invalid");
    err.status = 400;
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  return next;
}

function setDefaultAddress(addresses, targetId) {
  addresses.forEach((address) => {
    address.isDefault = String(address._id) === String(targetId);
  });
}

function promoteDefault(addresses) {
  if (!addresses.length) return;
  if (!addresses.some((address) => address.isDefault)) {
    addresses[0].isDefault = true;
  }
}

function safeAvatarPath(userImage) {
  if (!userImage || userImage === "user.png") return null;
  const fileName = path.basename(String(userImage));
  return uploadFilePath("avatars", fileName);
}

async function customerStats(match) {
  const rows = await orderModel.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$user",
        ordersCount: { $sum: 1 },
        totalSpent: {
          $sum: {
            $cond: [
              { $in: [{ $toLower: { $ifNull: ["$orderStatus", "$status"] } }, ["cancelled"]]},
              0,
              { $ifNull: ["$total", { $ifNull: ["$amount", 0] }] },
            ],
          },
        },
        lastOrderAt: { $max: "$createdAt" },
      },
    },
  ]);
  const map = new Map();
  rows.forEach((row) => map.set(String(row._id), row));
  return map;
}

async function recentOrdersFor(userId) {
  return orderModel
    .find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("_id total amount currency orderStatus status paymentStatus createdAt items shippingAddress")
    .lean();
}

class CustomerAccounts {
  async getMe(req, res, next) {
    try {
      const user = await userModel.findById(req.auth.userId);
      if (!user || isBlocked(user)) {
        return res.status(403).json({ success: false, code: "ACCOUNT_BLOCKED", error: "Account is blocked" });
      }
      return res.json({ success: true, user: serializeCustomerSelf(user), User: serializeCustomerSelf(user) });
    } catch (err) {
      return next(err);
    }
  }

  async updateMe(req, res, next) {
    try {
      const allowed = pickAllowed(req.body, ["name", "phone", "phoneNumber"]);
      if (req.body.email && normalizeEmail(req.body.email) !== req.user.email) {
        return res.status(400).json({ success: false, code: "EMAIL_CHANGE_NOT_SUPPORTED", error: "Email cannot be changed here." });
      }
      const update = {};
      if (allowed.name !== undefined) update.name = trim(allowed.name, 32);
      if (allowed.phone !== undefined || allowed.phoneNumber !== undefined) {
        const phone = normalizePhone(allowed.phone ?? allowed.phoneNumber);
        update.phone = phone;
        update.phoneNumber = phone && /^\d+$/.test(phone) ? Number(phone) : undefined;
      }
      if (!Object.keys(update).length) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "No editable fields provided" });
      }
      const user = await userModel.findByIdAndUpdate(req.auth.userId, update, { new: true, runValidators: true });
      return res.json({ success: "User updated successfully", user: serializeCustomerSelf(user), User: serializeCustomerSelf(user) });
    } catch (err) {
      return next(err);
    }
  }

  async changePassword(req, res, next) {
    try {
      const { oldPassword, currentPassword, newPassword, cPassword, confirmPassword } = req.body;
      const current = oldPassword || currentPassword;
      const confirmation = cPassword || confirmPassword;
      if (!current || !newPassword || !confirmation) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "All password fields are required" });
      }
      if (newPassword !== confirmation) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Passwords do not match" });
      }
      if (String(newPassword).length < 8 || String(newPassword).length > 255) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Password must be at least 8 characters" });
      }
      const user = await userModel.findById(req.auth.userId).select("+password +resetCodeHash +resetTokenHash");
      if (!user || !user.password || (user.authProviders && user.authProviders.local && user.authProviders.local.enabled === false)) {
        return res.status(400).json({
          success: false,
          code: "LOCAL_PASSWORD_NOT_SET",
          error: "Use password recovery to set a password before changing it.",
        });
      }
      const valid = user && await bcrypt.compare(current, user.password);
      if (!valid) {
        return res.status(401).json({ success: false, code: "INVALID_CURRENT_PASSWORD", error: "Current password is incorrect" });
      }
      const same = await bcrypt.compare(newPassword, user.password);
      if (same) {
        return res.status(400).json({ success: false, code: "PASSWORD_UNCHANGED", error: "New password must be different from the current password" });
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
      return res.json({ success: "Password updated successfully" });
    } catch (err) {
      return next(err);
    }
  }

  async uploadAvatar(req, res, next) {
    let newPath = null;
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Avatar image is required" });
      }
      newPath = req.file.path;
      const user = await userModel.findById(req.auth.userId);
      const oldAvatarPath = safeAvatarPath(user.userImage);
      const relative = uploadPublicUrl("avatars", req.file.filename);
      user.userImage = relative;
      await user.save();
      if (oldAvatarPath && fs.existsSync(oldAvatarPath)) {
        fs.unlinkSync(oldAvatarPath);
      }
      return res.json({ success: true, avatar: relative, user: serializeCustomerSelf(user) });
    } catch (err) {
      if (newPath && fs.existsSync(newPath)) {
        fs.unlinkSync(newPath);
      }
      return next(err);
    }
  }

  async listAddresses(req, res, next) {
    try {
      const user = await userModel.findById(req.auth.userId);
      return res.json({ success: true, addresses: serializeCustomerSelf(user).addresses });
    } catch (err) {
      return next(err);
    }
  }

  async addAddress(req, res, next) {
    try {
      const user = await userModel.findById(req.auth.userId);
      if ((user.addresses || []).length >= MAX_ADDRESSES) {
        return res.status(400).json({ success: false, code: "ADDRESS_LIMIT_REACHED", error: "Address limit reached" });
      }
      const address = normalizeAddress(req.body);
      if (!user.addresses.length) address.isDefault = true;
      user.addresses.push(address);
      if (address.isDefault) setDefaultAddress(user.addresses, user.addresses[user.addresses.length - 1]._id);
      promoteDefault(user.addresses);
      await user.save();
      return res.status(201).json({ success: true, addresses: serializeCustomerSelf(user).addresses });
    } catch (err) {
      return next(err);
    }
  }

  async updateAddress(req, res, next) {
    try {
      const { addressId } = req.params;
      if (!isValidObjectId(addressId)) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Address id is invalid" });
      }
      const user = await userModel.findById(req.auth.userId);
      const address = user.addresses.id(addressId);
      if (!address) {
        return res.status(404).json({ success: false, code: "ADDRESS_NOT_FOUND", error: "Address not found" });
      }
      Object.assign(address, normalizeAddress({ ...address.toObject(), ...req.body }));
      if (address.isDefault) setDefaultAddress(user.addresses, address._id);
      promoteDefault(user.addresses);
      await user.save();
      return res.json({ success: true, addresses: serializeCustomerSelf(user).addresses });
    } catch (err) {
      return next(err);
    }
  }

  async deleteAddress(req, res, next) {
    try {
      const { addressId } = req.params;
      if (!isValidObjectId(addressId)) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Address id is invalid" });
      }
      const user = await userModel.findById(req.auth.userId);
      const address = user.addresses.id(addressId);
      if (!address) {
        return res.status(404).json({ success: false, code: "ADDRESS_NOT_FOUND", error: "Address not found" });
      }
      address.remove();
      promoteDefault(user.addresses);
      await user.save();
      return res.json({ success: true, addresses: serializeCustomerSelf(user).addresses });
    } catch (err) {
      return next(err);
    }
  }

  async setDefaultAddress(req, res, next) {
    try {
      const { addressId } = req.params;
      if (!isValidObjectId(addressId)) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Address id is invalid" });
      }
      const user = await userModel.findById(req.auth.userId);
      const address = user.addresses.id(addressId);
      if (!address) {
        return res.status(404).json({ success: false, code: "ADDRESS_NOT_FOUND", error: "Address not found" });
      }
      setDefaultAddress(user.addresses, addressId);
      await user.save();
      return res.json({ success: true, addresses: serializeCustomerSelf(user).addresses });
    } catch (err) {
      return next(err);
    }
  }

  async listAdminUsers(req, res, next) {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const page = Math.max(Number(req.query.page) || 1, 1);
      const q = trim(req.query.q || "", 80);
      const status = normalizedStatus(req.query.status);
      const filter = { userRole: 0 };
      if (req.query.status && ["active", "blocked"].includes(status)) {
        filter.status = status === "blocked" ? { $in: ["blocked", "disabled"] } : "active";
      }
      if (q) {
        const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        filter.$or = [
          { name: new RegExp(escaped, "i") },
          { email: new RegExp(escaped, "i") },
          { phone: new RegExp(escaped, "i") },
        ];
      }
      const sort = req.query.sort === "oldest" ? { createdAt: 1 } : { createdAt: -1 };
      const [users, total] = await Promise.all([
        userModel.find(filter).sort(sort).skip((page - 1) * limit).limit(limit),
        userModel.countDocuments(filter),
      ]);
      const stats = await customerStats({ user: { $in: users.map((user) => user._id) } });
      const customers = users.map((user) => serializeCustomerListItem(user, stats.get(String(user._id))));
      return res.json({ success: true, customers, users: customers, total, page, limit });
    } catch (err) {
      return next(err);
    }
  }

  async getAdminUser(req, res, next) {
    try {
      const { userId } = req.params;
      if (!isValidObjectId(userId)) {
        return res.status(400).json({ success: false, code: "VALIDATION_ERROR", error: "Customer id is invalid" });
      }
      const user = await userModel.findOne({ _id: userId, userRole: 0 });
      if (!user) {
        return res.status(404).json({ success: false, code: "CUSTOMER_NOT_FOUND", error: "Customer not found" });
      }
      const orders = await recentOrdersFor(user._id);
      const stats = await customerStats({ user: mongoose.Types.ObjectId(user._id) });
      const stat = stats.get(String(user._id)) || {};
      return res.json({
        success: true,
        user: serializeAdminCustomer(user, {
          ...stat,
          recentOrders: orders,
        }),
      });
    } catch (err) {
      return next(err);
    }
  }

  async updateAdminUserStatus(req, res, next) {
    try {
      const { userId } = req.params;
      const nextStatus = normalizedStatus(req.body.status);
      if (!["active", "blocked"].includes(nextStatus)) {
        return res.status(400).json({ success: false, code: "INVALID_ACCOUNT_STATUS", error: "Invalid account status" });
      }
      if (String(userId) === String(req.auth.userId)) {
        return res.status(400).json({ success: false, code: "SELF_STATUS_CHANGE_NOT_ALLOWED", error: "Cannot change your own account status" });
      }
      const user = await userModel.findById(userId);
      if (!user || user.userRole !== 0) {
        return res.status(404).json({ success: false, code: "CUSTOMER_NOT_FOUND", error: "Customer not found" });
      }
      if (user.userRole === 1) {
        return res.status(400).json({ success: false, code: "ADMIN_TARGET_NOT_ALLOWED", error: "Admin accounts cannot be changed here" });
      }
      const current = normalizedStatus(user.status);
      if (current === nextStatus) {
        return res.status(409).json({ success: false, code: "ACCOUNT_ALREADY_IN_STATUS", error: "Account is already in this status" });
      }
      user.status = nextStatus;
      if (nextStatus === "blocked") {
        user.tokenVersion = (user.tokenVersion || 0) + 1;
      }
      user.accountStatusHistory.push({
        from: current,
        to: nextStatus,
        changedBy: req.auth.userId,
        reason: trim(req.body.reason || "", 240),
        changedAt: new Date(),
      });
      await user.save();
      return res.json({ success: true, user: serializeAdminCustomer(user) });
    } catch (err) {
      return next(err);
    }
  }
}

module.exports = new CustomerAccounts();
