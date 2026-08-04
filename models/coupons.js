const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    type: { type: String, enum: ["fixed", "percentage"], required: true },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: null, min: 0 },
    minimumSubtotal: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    active: { type: Boolean, default: true },
    globalUsageLimit: { type: Number, default: null, min: 1 },
    perCustomerUsageLimit: { type: Number, default: null, min: 1 },
    firstOrderOnly: { type: Boolean, default: false },
    usageCount: { type: Number, default: 0, min: 0 },
    customerUsage: { type: Map, of: Number, default: undefined, select: false },
    createdBy: { type: ObjectId, ref: "users" },
    updatedBy: { type: ObjectId, ref: "users" },
  },
  { timestamps: true }
);

couponSchema.index({ code: 1 }, { unique: true });

const couponModel = mongoose.model("coupons", couponSchema);
module.exports = couponModel;
