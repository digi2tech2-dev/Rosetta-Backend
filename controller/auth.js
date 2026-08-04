const { toTitleCase, validateEmail } = require("../config/function");
const bcrypt = require("bcryptjs");
const userModel = require("../models/users");
const jwt = require("jsonwebtoken");
const { config } = require("../config/appConfig");
const { sanitizeUser, sanitizeUsers } = require("../utils/sanitize");
const { normalizeEmail, pickAllowed } = require("../utils/validation");
const {
  requestPasswordReset,
  resetPassword,
  verifyResetCode,
} = require("../services/passwordResetService");
const { verifyGoogleCredential } = require("../services/googleAuthService");

function isBlocked(user) {
  return user && (user.status === "blocked" || user.status === "disabled");
}

function issueSigninResponse(user) {
  const token = jwt.sign(
    { _id: String(user._id), role: user.userRole, tokenVersion: user.tokenVersion || 0 },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return {
    token,
    user: sanitizeUser(user),
    expiresIn: config.jwtExpiresIn,
  };
}

function googleAuthError(res, status, code, error) {
  return res.status(status).json({
    success: false,
    code,
    error,
  });
}

function genericGoogleFailure(res) {
  return googleAuthError(res, 401, "AUTHENTICATION_FAILED", "Google authentication failed");
}

function localEnabled(user) {
  return !user.authProviders || !user.authProviders.local || user.authProviders.local.enabled !== false;
}

function safeGoogleName(identity) {
  const candidate = String(identity.name || identity.givenName || identity.email.split("@")[0] || "Customer")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = candidate.slice(0, 32);
  return toTitleCase(clipped || "Customer");
}

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
        status: "active",
        tokenVersion: 0,
        authProviders: {
          local: { enabled: true },
          google: { enabled: false, sub: null, linkedAt: null },
        },
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
      if (isBlocked(data)) {
        return res.status(403).json({
          success: false,
          code: "ACCOUNT_BLOCKED",
          error: "Account is blocked",
        });
      }
      if (!localEnabled(data) || !data.password) {
        return res.status(401).json(invalidResponse);
      }

      const login = await bcrypt.compare(password, data.password);
      if (!login) {
        return res.status(401).json(invalidResponse);
      }

      return res.json(issueSigninResponse(data));
    } catch (err) {
      return next(err);
    }
  }

  async postGoogleSignin(req, res, next) {
    try {
      if (!config.googleAuthEnabled) {
        return googleAuthError(res, 503, "GOOGLE_AUTH_DISABLED", "Google sign-in is not enabled");
      }

      const allowed = pickAllowed(req.body, ["credential"]);
      if (!allowed.credential) {
        return googleAuthError(res, 400, "GOOGLE_CREDENTIAL_REQUIRED", "Google credential is required");
      }

      let identity;
      try {
        identity = await verifyGoogleCredential(allowed.credential);
      } catch (err) {
        if (err.code === "GOOGLE_CREDENTIAL_REQUIRED") {
          return googleAuthError(res, 400, "GOOGLE_CREDENTIAL_REQUIRED", "Google credential is required");
        }
        if (err.code === "GOOGLE_EMAIL_NOT_VERIFIED") {
          return googleAuthError(res, 401, "GOOGLE_EMAIL_NOT_VERIFIED", "Google email is not verified");
        }
        return googleAuthError(res, 401, "INVALID_GOOGLE_CREDENTIAL", "Google credential is invalid");
      }

      const linkedUser = await userModel.findOne({ "authProviders.google.sub": identity.sub });
      if (linkedUser) {
        if (isBlocked(linkedUser)) {
          return googleAuthError(res, 403, "ACCOUNT_BLOCKED", "Account is blocked");
        }
        return res.json(issueSigninResponse(linkedUser));
      }

      const emailUser = await userModel.findOne({ email: identity.email });
      if (emailUser) {
        if (emailUser.userRole !== 0) {
          return genericGoogleFailure(res);
        }
        if (isBlocked(emailUser)) {
          return googleAuthError(res, 403, "ACCOUNT_BLOCKED", "Account is blocked");
        }

        try {
          const linked = await userModel.findOneAndUpdate(
            {
              _id: emailUser._id,
              userRole: 0,
              $or: [
                { "authProviders.google.sub": { $exists: false } },
                { "authProviders.google.sub": null },
                { "authProviders.google.sub": "" },
              ],
            },
            {
              $set: {
                verified: true,
                "authProviders.local.enabled": localEnabled(emailUser),
                "authProviders.google.enabled": true,
                "authProviders.google.sub": identity.sub,
                "authProviders.google.linkedAt": new Date(),
              },
            },
            { new: true, runValidators: true }
          );
          if (linked) {
            return res.json(issueSigninResponse(linked));
          }
          const recovered = await userModel.findOne({ "authProviders.google.sub": identity.sub });
          if (recovered && String(recovered._id) === String(emailUser._id) && recovered.userRole === 0 && !isBlocked(recovered)) {
            return res.json(issueSigninResponse(recovered));
          }
          return genericGoogleFailure(res);
        } catch (err) {
          if (err && err.code === 11000) {
            const recovered = await userModel.findOne({ "authProviders.google.sub": identity.sub });
            if (recovered && String(recovered._id) === String(emailUser._id) && recovered.userRole === 0 && !isBlocked(recovered)) {
              return res.json(issueSigninResponse(recovered));
            }
            return genericGoogleFailure(res);
          }
          throw err;
        }
      }

      try {
        const newUser = await userModel.create({
          name: safeGoogleName(identity),
          email: identity.email,
          userRole: 0,
          status: "active",
          verified: true,
          tokenVersion: 0,
          userImage: "user.png",
          authProviders: {
            local: { enabled: false },
            google: {
              enabled: true,
              sub: identity.sub,
              linkedAt: new Date(),
            },
          },
        });
        return res.status(201).json(issueSigninResponse(newUser));
      } catch (err) {
        if (err && err.code === 11000) {
          return genericGoogleFailure(res);
        }
        throw err;
      }
    } catch (err) {
      return next(err);
    }
  }

  async forgotPassword(req, res, next) {
    try {
      const result = await requestPasswordReset(req.body.email);
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  async verifyResetCode(req, res, next) {
    try {
      const result = await verifyResetCode(req.body);
      if (!result.success) {
        return res.status(result.status || 400).json(result);
      }
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }

  async resetPassword(req, res, next) {
    try {
      const result = await resetPassword(req.body);
      if (!result.success) {
        return res.status(result.status || 400).json(result);
      }
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  }
}

const authController = new Auth();
module.exports = authController;
