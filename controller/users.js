const userModel = require("../models/users");
const bcrypt = require("bcryptjs");
const { sanitizeUser, sanitizeUsers } = require("../utils/sanitize");
const {
  isValidObjectId,
  normalizeEmail,
  pickAllowed,
  isValidRole,
} = require("../utils/validation");

class User {
  async getAllUser(req, res, next) {
    try {
      const Users = await userModel.find({}).sort({ _id: -1 });
      return res.json({ Users: sanitizeUsers(Users) });
    } catch (err) {
      return next(err);
    }
  }

  async getSingleUser(req, res, next) {
    try {
      const uId = req.auth.role === 1 && req.body.uId ? req.body.uId : req.auth.userId;
      if (!isValidObjectId(uId)) {
        return res.status(400).json({ error: "uId must be a valid id" });
      }

      const User = await userModel
        .findById(uId)
        .select("name email phoneNumber userImage userRole status updatedAt createdAt");
      if (!User) {
        return res.status(404).json({ error: "User not found" });
      }
      return res.json({ User: sanitizeUser(User) });
    } catch (err) {
      return next(err);
    }
  }

  async postAddUser(req, res, next) {
    try {
      const body = pickAllowed(req.body, [
        "name",
        "email",
        "password",
        "cPassword",
        "userRole",
        "phoneNumber",
        "userImage",
      ]);
      const { password, cPassword } = body;
      const name = String(body.name || "").trim();
      const email = normalizeEmail(body.email);

      if (!name || !email || !password || !cPassword) {
        return res.status(400).json({ message: "All filled must be required" });
      }
      if (password !== cPassword) {
        return res.status(400).json({ error: "Passwords do not match" });
      }
      if (password.length < 8 || password.length > 255) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      if (body.userRole !== undefined && !isValidRole(body.userRole)) {
        return res.status(400).json({ error: "userRole must be 0 or 1" });
      }

      const existingUser = await userModel.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ error: "Email already exists" });
      }

      const newUser = await userModel.create({
        name,
        email,
        password: bcrypt.hashSync(password, 10),
        userRole: body.userRole === undefined ? 0 : Number(body.userRole),
        phoneNumber: body.phoneNumber,
        userImage: body.userImage,
      });
      return res.status(201).json({
        success: "User created successfully",
        User: sanitizeUser(newUser),
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "Email already exists" });
      }
      return next(err);
    }
  }

  async postEditUser(req, res, next) {
    try {
      const requestedId = req.body.uId || req.auth.userId;
      const uId = req.auth.role === 1 ? requestedId : req.auth.userId;
      if (!isValidObjectId(uId)) {
        return res.status(400).json({ error: "uId must be a valid id" });
      }

      const allowedFields = ["name", "email", "phoneNumber", "userImage"];
      const update = pickAllowed(req.body, allowedFields);
      if (update.email) {
        update.email = normalizeEmail(update.email);
      }
      if (update.name) {
        update.name = String(update.name).trim();
      }

      if (req.auth.role === 1 && req.body.userRole !== undefined) {
        if (!isValidRole(req.body.userRole)) {
          return res.status(400).json({ error: "userRole must be 0 or 1" });
        }
        update.userRole = Number(req.body.userRole);
      }

      if (Object.keys(update).length === 0) {
        return res.status(400).json({ message: "No editable fields provided" });
      }

      update.updatedAt = Date.now();
      const updatedUser = await userModel.findByIdAndUpdate(uId, update, {
        new: true,
        runValidators: true,
      });
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      return res.json({
        success: "User updated successfully",
        User: sanitizeUser(updatedUser),
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ error: "Email already exists" });
      }
      return next(err);
    }
  }

  async getDeleteUser(req, res, next) {
    try {
      const uId = req.body.uId || req.body.oId;
      if (!isValidObjectId(uId)) {
        return res.status(400).json({ error: "uId must be a valid id" });
      }

      const update = { status: "blocked", updatedAt: Date.now(), $inc: { tokenVersion: 1 } };
      if (req.body.status === "active" || req.body.status === "blocked") {
        update.status = req.body.status;
        if (req.body.status === "active") {
          delete update.$inc;
        }
      }

      const updatedUser = await userModel.findByIdAndUpdate(uId, update, {
        new: true,
      });
      if (!updatedUser) {
        return res.status(404).json({ error: "User not found" });
      }
      return res.json({
        success: "User updated successfully",
        User: sanitizeUser(updatedUser),
      });
    } catch (err) {
      return next(err);
    }
  }

  async changePassword(req, res, next) {
    try {
      const { oldPassword, newPassword, cPassword, confirmPassword } = req.body;
      const passwordConfirmation = cPassword || confirmPassword;
      if (!oldPassword || !newPassword || !passwordConfirmation) {
        return res.status(400).json({ message: "All filled must be required" });
      }
      if (newPassword !== passwordConfirmation) {
        return res.status(400).json({ error: "Passwords do not match" });
      }
      if (newPassword.length < 8 || newPassword.length > 255) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const data = await userModel.findById(req.auth.userId).select("+password");
      if (!data) {
        return res.status(401).json({ error: "Invalid user" });
      }
      if (!data.password || (data.authProviders && data.authProviders.local && data.authProviders.local.enabled === false)) {
        return res.status(400).json({
          success: false,
          code: "LOCAL_PASSWORD_NOT_SET",
          error: "Use password recovery to set a password before changing it.",
        });
      }

      const oldPassCheck = await bcrypt.compare(oldPassword, data.password);
      if (!oldPassCheck) {
        return res.status(401).json({ error: "Your old password is wrong!!" });
      }

      data.password = bcrypt.hashSync(newPassword, 10);
      data.authProviders = data.authProviders || {};
      data.authProviders.local = { ...(data.authProviders.local || {}), enabled: true };
      data.passwordChangedAt = new Date();
      data.tokenVersion = (data.tokenVersion || 0) + 1;
      data.resetCodeHash = null;
      data.resetCodeExpiresAt = null;
      data.resetCodeAttempts = 0;
      data.resetCodeRequestedAt = null;
      data.resetTokenHash = null;
      data.resetTokenExpiresAt = null;
      await data.save();
      return res.json({ success: "Password updated successfully" });
    } catch (err) {
      return next(err);
    }
  }
}

const usersController = new User();
module.exports = usersController;
