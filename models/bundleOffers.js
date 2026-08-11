const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const bundleOfferSchema = new mongoose.Schema(
  {
    primaryProduct: {
      type: ObjectId,
      ref: "products",
      required: true,
    },
    additionalProduct: {
      type: ObjectId,
      ref: "products",
      required: true,
    },
    bundlePrice: {
      type: Number,
      required: true,
      min: 0.01,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: ObjectId,
      ref: "users",
      default: null,
    },
    updatedBy: {
      type: ObjectId,
      ref: "users",
      default: null,
    },
  },
  { timestamps: true }
);

bundleOfferSchema.index({ primaryProduct: 1, additionalProduct: 1 }, { unique: true });
bundleOfferSchema.index({ primaryProduct: 1, active: 1, updatedAt: -1 });

const bundleOfferModel = mongoose.model("bundleOffers", bundleOfferSchema);
module.exports = bundleOfferModel;
