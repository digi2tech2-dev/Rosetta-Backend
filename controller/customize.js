const fs = require("fs");
const path = require("path");
const categoryModel = require("../models/categories");
const productModel = require("../models/products");
const orderModel = require("../models/orders");
const userModel = require("../models/users");
const customizeModel = require("../models/customize");
const { isValidObjectId } = require("../utils/validation");
const { uploadFolderPath } = require("../utils/uploadPaths");

function safeUnlinkCustomize(filename) {
  const basePath = uploadFolderPath("customize");
  const safeFileName = path.basename(String(filename || ""));
  if (!safeFileName) {
    return;
  }
  const filePath = path.join(basePath, safeFileName);
  if (!filePath.startsWith(basePath)) {
    return;
  }
  fs.unlink(filePath, () => {});
}

class Customize {
  async getImages(req, res, next) {
    try {
      const Images = await customizeModel.find({});
      return res.json({ Images });
    } catch (err) {
      return next(err);
    }
  }

  async uploadSlideImage(req, res, next) {
    try {
      const image = req.file && req.file.filename;
      if (!image) {
        return res.status(400).json({ error: "All field required" });
      }

      await customizeModel.create({
        slideImage: image,
      });
      return res.json({ success: "Image upload successfully" });
    } catch (err) {
      if (req.file && req.file.filename) {
        safeUnlinkCustomize(req.file.filename);
      }
      return next(err);
    }
  }

  async deleteSlideImage(req, res, next) {
    try {
      const { id } = req.body;
      if (!isValidObjectId(id)) {
        return res.status(400).json({ error: "id must be a valid id" });
      }

      const deleteImage = await customizeModel.findByIdAndDelete(id);
      if (!deleteImage) {
        return res.status(404).json({ error: "Image not found" });
      }
      safeUnlinkCustomize(deleteImage.slideImage);
      return res.json({ success: "Image deleted successfully" });
    } catch (err) {
      return next(err);
    }
  }

  async getAllData(req, res, next) {
    try {
      const Categories = await categoryModel.countDocuments({});
      const Products = await productModel.countDocuments({});
      const Orders = await orderModel.countDocuments({});
      const Users = await userModel.countDocuments({});
      return res.json({ Categories, Products, Orders, Users });
    } catch (err) {
      return next(err);
    }
  }
}

const customizeController = new Customize();
module.exports = customizeController;
