const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const commerceSettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: "commerce", unique: true },
    currency: { type: String, default: "EGP", trim: true, maxlength: 8 },
    defaultShippingFee: { type: Number, default: 0, min: 0 },
    defaultFreeShippingThreshold: { type: Number, default: 0, min: 0 },
    automaticFirstOrderDiscountEnabled: { type: Boolean, default: false },
    automaticFirstOrderDiscountType: {
      type: String,
      enum: ["fixed", "percentage"],
      default: "percentage",
    },
    automaticFirstOrderDiscountValue: { type: Number, default: 0, min: 0 },
    automaticFirstOrderMaxDiscount: { type: Number, default: null, min: 0 },
    deliveryDuration: { type: String, default: "2 - 5 days", trim: true, maxlength: 80 },
    trackingUrl: { type: String, default: "", trim: true, maxlength: 500 },
    trackingPrefix: { type: String, default: "", trim: true, maxlength: 40 },
    priorityPackingEnabled: { type: Boolean, default: false },
    priorityPackingMinimum: { type: Number, default: 0, min: 0 },
    giftWrapEnabled: { type: Boolean, default: false },
    giftWrapMinimum: { type: Number, default: 0, min: 0 },
    updatedBy: { type: ObjectId, ref: "users" },
  },
  { timestamps: true }
);

const commerceSettingsModel = mongoose.model("commerceSettings", commerceSettingsSchema);
module.exports = commerceSettingsModel;
