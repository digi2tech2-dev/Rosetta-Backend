const { toTitleCase, validateEmail } = require("../config/function");
const bcrypt = require("bcryptjs");
const userModel = require("../models/users");
const jwt = require("jsonwebtoken");
const { config } = require("../config/appConfig");
const { sanitizeUser, sanitizeUsers } = require("../utils/sanitize");
const { normalizeEmail, pickAllowed } = require("../utils/validation");

class Auth {
  async isAdmin(req, res) {
    return res.json({
      role: req.auth.role,
      isAdmin: req.auth.role === 1,
    });
  }

  async allUser(req, res, next) {
    try {
      const allUser = await userModel.find({}).sort({ _id: -1 });
      return res.json({ users: sanitizeUsers(allUser) });
    } catch (err) {
      return next(err);
    }
  }

  async postSignup(req, res, next) {
    try {
      let { name, email, password, cPassword } = pickAllowed(req.body, [
        "name",
        "email",
        "password",
        "cPassword",
      ]);

      const error = {};
      if (!name || !email || !password || !cPassword) {
        return res.status(400).json({
          error: {
            name: !name ? "Field must not be empty" : "",
            email: !email ? "Field must not be empty" : "",
            password: !password ? "Field must not be empty" : "",
            cPassword: !cPassword ? "Field must not be empty" : "",
          },
        });
      }

      name = String(name).trim();
      email = normalizeEmail(email);

      if (password !== cPassword) {
        error.cPassword = "Passwords do not match";
        return res.status(400).json({ error });
      }
      if (name.length < 3 || name.length > 25) {
        error.name = "Name must be 3-25 character";
        return res.status(400).json({ error });
      }
      if (!validateEmail(email)) {
        error.email = "Email is not valid";
        return res.status(400).json({ error });
      }
      if (password.length > 255 || password.length < 8) {
        error.password = "Password must be at least 8 characters";
        return res.status(400).json({ error });
      }

      const existingUser = await userModel.findOne({ email });
      if (existingUser) {
        return res.status(409).json({
          error: {
            email: "Email already exists",
          },
        });
      }

      const hashedPassword = bcrypt.hashSync(password, 10);
      const newUser = await userModel.create({
        name: toTitleCase(name),
        email,
        password: hashedPassword,
        userRole: 0,
      });

      return res.status(201).json({
        success: "Account create successfully. Please login",
        user: sanitizeUser(newUser),
      });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({
          error: {
            email: "Email already exists",
          },
        });
      }
      return next(err);
    }
  }

  async postSignin(req, res, next) {
    try {
      const email = normalizeEmail(req.body.email);
      const password = req.body.password;
      if (!email || !password) {
        return res.status(400).json({
          error: "Fields must not be empty",
        });
      }

      const data = await userModel.findOne({ email }).select("+password");
      const invalidResponse = {
        error: "Invalid email or password",
      };
      if (!data) {
        return res.status(401).json(invalidResponse);
      }

      const login = await bcrypt.compare(password, data.password);
      if (!login) {
        return res.status(401).json(invalidResponse);
      }

      const token = jwt.sign(
        { _id: String(data._id), role: data.userRole },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
      );

      return res.json({
        token,
        user: sanitizeUser(data),
        expiresIn: config.jwtExpiresIn,
      });
    } catch (err) {
      return next(err);
    }
  }
}

const authController = new Auth();
module.exports = authController;
