const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: { type: ObjectId, ref: "coupons", required: true },
    customer: { type: ObjectId, ref: "users", default: null },
    order: { type: ObjectId, ref: "orders", required: true },
    status: { type: String, enum: ["applied", "released"], default: "applied" },
    amount: { type: Number, required: true, min: 0 },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

couponRedemptionSchema.index({ coupon: 1, order: 1 }, { unique: true });
couponRedemptionSchema.index(
  { coupon: 1, customer: 1, status: 1 },
  { partialFilterExpression: { customer: { $type: "objectId" } } }
);

const couponRedemptionModel = mongoose.model("couponRedemptions", couponRedemptionSchema);
module.exports = couponRedemptionModel;
