const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const productSchema = new mongoose.Schema(
  {
    pName: {
      type: String,
      required: true,
    },
    pDescription: {
      type: String,
      required: true,
    },
    pPrice: {
      type: Number,
      required: true,
    },
    pSold: {
      type: Number,
      default: 0,
    },
    pQuantity: {
      type: Number,
      default: 0,
    },
    pCost: {
      type: Number,
      default: null,
      min: 0,
    },
    pBarcode: {
      type: String,
      trim: true,
    },
    pBrand: {
      type: String,
      default: null,
      trim: true,
      maxlength: 120,
    },
    pVideo: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },
    pColors: {
      type: [String],
      default: [],
    },
    pSizes: {
      type: [String],
      default: [],
    },
    pColorImages: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    inventoryMode: {
      type: String,
      enum: ["simple", "shared_options"],
      default: "simple",
    },
    relatedProducts: [{
      type: ObjectId,
      ref: "products",
    }],
    similarProducts: [{
      type: ObjectId,
      ref: "products",
    }],
    suggestedProducts: [{
      type: ObjectId,
      ref: "products",
    }],
    pCategoryOrder: {
      type: Number,
      default: null,
      min: 1,
    },
    pRecommended: {
      type: Boolean,
      default: false,
    },
    pCategory: {
      type: ObjectId,
      ref: "categories",
    },
    pImages: {
      type: Array,
      required: true,
    },
    pOffer: {
      type: String,
      default: null,
    },
    pRatingsReviews: [
      {
        review: String,
        user: { type: ObjectId, ref: "users" },
        rating: String,
        createdAt: {
          type: Date,
          default: Date.now(),
        },
      },
    ],
    pStatus: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

productSchema.index(
  { pBarcode: 1 },
  {
    unique: true,
    partialFilterExpression: { pBarcode: { $type: "string" } },
  }
);

const productModel = mongoose.model("products", productSchema);
module.exports = productModel;
