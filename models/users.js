const mongoose = require("mongoose");

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
      required: true,
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
      enum: ["active", "disabled"],
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
  },
  {
    timestamps: true,
    toJSON: {
      transform: function (doc, ret) {
        delete ret.password;
        delete ret.secretKey;
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
        delete ret.__v;
        ret.id = String(ret._id);
        ret.role = ret.userRole;
        return ret;
      },
    },
  }
);

const userModel = mongoose.model("users", userSchema);
module.exports = userModel;
