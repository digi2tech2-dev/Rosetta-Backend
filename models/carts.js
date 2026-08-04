const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;
const { config } = require("../config/appConfig");

const cartItemSchema = new mongoose.Schema(
  {
    product: {
      type: ObjectId,
      ref: "products",
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: config.maxItemQuantity,
      validate: {
        validator: Number.isInteger,
        message: "Cart item quantity must be a whole number",
      },
    },
    selectedColor: {
      type: String,
      default: null,
    },
    selectedSize: {
      type: String,
      default: null,
    },
  },
  { _id: false }
);

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: ObjectId,
      ref: "users",
      required: true,
      unique: true,
      index: true,
    },
    items: {
      type: [cartItemSchema],
      default: [],
      validate: {
        validator(items) {
          const seen = new Set();
          for (const item of items || []) {
            const id = `${String(item.product)}::${item.selectedColor || ""}::${item.selectedSize || ""}`.toLowerCase();
            if (seen.has(id)) {
              return false;
            }
            seen.add(id);
          }
          return items.length <= config.maxCartItems;
        },
        message: "Cart cannot contain duplicate products or too many items",
      },
    },
  },
  { timestamps: true }
);

const cartModel = mongoose.model("carts", cartSchema);
module.exports = cartModel;
