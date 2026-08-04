const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, maxlength: 60 },
    fullName: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 20 },
    alternatePhone: { type: String, trim: true, maxlength: 20 },
    governorate: { type: String, trim: true, maxlength: 80 },
    city: { type: String, trim: true, maxlength: 80 },
    area: { type: String, trim: true, maxlength: 120 },
    street: { type: String, trim: true, maxlength: 180 },
    building: { type: String, trim: true, maxlength: 60 },
    floor: { type: String, trim: true, maxlength: 60 },
    apartment: { type: String, trim: true, maxlength: 60 },
    landmark: { type: String, trim: true, maxlength: 160 },
    postalCode: { type: String, trim: true, maxlength: 20 },
    notes: { type: String, trim: true, maxlength: 500 },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const accountStatusHistorySchema = new mongoose.Schema(
  {
    from: String,
    to: String,
    changedBy: { type: ObjectId, ref: "users" },
    reason: { type: String, trim: true, maxlength: 240 },
    changedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const authProvidersSchema = new mongoose.Schema(
  {
    local: {
      enabled: { type: Boolean, default: true },
    },
    google: {
      enabled: { type: Boolean, default: false },
      sub: {
        type: String,
        trim: true,
        default: null,
      },
      linkedAt: {
        type: Date,
        default: null,
      },
    },
  },
  { _id: false }
);

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      maxlength: 32,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: { unique: true },
      match: /^([a-zA-Z0-9_.-])+@(([a-zA-Z0-9-])+.)+([a-zA-Z0-9]{2,})+$/,
    },
    password: {
      type: String,
      required: function () {
        return !this.authProviders || !this.authProviders.local || this.authProviders.local.enabled !== false;
      },
      select: false,
    },
    userRole: {
      type: Number,
      required: true,
      default: 0,
      enum: [0, 1],
    },
    phoneNumber: {
      type: Number,
    },
    phone: {
      type: String,
      default: null,
      trim: true,
      maxlength: 20,
    },
    userImage: {
      type: String,
      default: "user.png",
    },
    verified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      default: "active",
      enum: ["active", "blocked", "disabled"],
    },
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
    },
    secretKey: {
      type: String,
      default: null,
      select: false,
    },
    history: {
      type: Array,
      default: [],
    },
    addresses: {
      type: [addressSchema],
      default: [],
    },
    passwordChangedAt: {
      type: Date,
      default: null,
    },
    resetCodeHash: {
      type: String,
      default: null,
      select: false,
    },
    resetCodeExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    resetCodeAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    resetCodeRequestedAt: {
      type: Date,
      default: null,
      select: false,
    },
    resetTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    resetTokenExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    accountStatusHistory: {
      type: [accountStatusHistorySchema],
      default: [],
    },
    authProviders: {
      type: authProvidersSchema,
      default: () => ({
        local: { enabled: true },
        google: { enabled: false, sub: null, linkedAt: null },
      }),
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.secretKey;
        delete ret.resetCodeHash;
        delete ret.resetCodeExpiresAt;
        delete ret.resetCodeAttempts;
        delete ret.resetCodeRequestedAt;
        delete ret.resetTokenHash;
        delete ret.resetTokenExpiresAt;
        delete ret.tokenVersion;
        delete ret.authProviders;
        delete ret.__v;
        ret.id = String(ret._id);
        ret.role = ret.userRole;
        return ret;
      },
    },
    toObject: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.secretKey;
        delete ret.resetCodeHash;
        delete ret.resetCodeExpiresAt;
        delete ret.resetCodeAttempts;
        delete ret.resetCodeRequestedAt;
        delete ret.resetTokenHash;
        delete ret.resetTokenExpiresAt;
        delete ret.tokenVersion;
        delete ret.authProviders;
        delete ret.__v;
        ret.id = String(ret._id);
        ret.role = ret.userRole;
        return ret;
      },
    },
  }
);

userSchema.index(
  { "authProviders.google.sub": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "authProviders.google.sub": { $type: "string" },
    },
  }
);

const userModel = mongoose.model("users", userSchema);
module.exports = userModel;
