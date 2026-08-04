const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const shippingRuleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    governorate: { type: String, default: null, trim: true, maxlength: 80 },
    city: { type: String, default: null, trim: true, maxlength: 80 },
    fee: { type: Number, required: true, min: 0 },
    freeShippingThreshold: { type: Number, default: null, min: 0 },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },
    deliveryDuration: { type: String, default: "", trim: true, maxlength: 80 },
    createdBy: { type: ObjectId, ref: "users" },
    updatedBy: { type: ObjectId, ref: "users" },
  },
  { timestamps: true }
);

shippingRuleSchema.index({ governorate: 1, city: 1, active: 1, priority: -1 });

const shippingRuleModel = mongoose.model("shippingRules", shippingRuleSchema);
module.exports = shippingRuleModel;
