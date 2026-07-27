const { toTitleCase } = require("../config/function");
const categoryModel = require("../models/categories");
const fs = require("fs");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");

function safeUnlinkCategory(filename) {
  const basePath = path.resolve(__dirname, "..", "public", "uploads", "categories");
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

class Category {
  async getAllCategory(req, res, next) {
    try {
      const Categories = await categoryModel.find({}).sort({ _id: -1 });
      return res.json({ Categories });
    } catch (err) {
      return next(err);
    }
  }

  async postAddCategory(req, res, next) {
    try {
      let { cName, cDescription, cStatus } = req.body;
      const cImage = req.file && req.file.filename;

      if (!cName || !cDescription || !cStatus || !cImage) {
        safeUnlinkCategory(cImage);
        return res.status(400).json({ error: "All filled must be required" });
      }

      cName = toTitleCase(String(cName).trim());
      const checkCategoryExists = await categoryModel.findOne({ cName });
      if (checkCategoryExists) {
        safeUnlinkCategory(cImage);
        return res.status(409).json({ error: "Category already exists" });
      }

      await categoryModel.create({
        cName,
        cDescription,
        cStatus,
        cImage,
      });
      return res.json({ success: "Category created successfully" });
    } catch (err) {
      if (req.file && req.file.filename) {
        safeUnlinkCategory(req.file.filename);
      }
      return next(err);
    }
  }

  async postEditCategory(req, res, next) {
    try {
      const { cId, cDescription, cStatus } = req.body;
      if (!isValidObjectId(cId) || !cDescription || !cStatus) {
        return res.status(400).json({ error: "All filled must be required" });
      }

      const edit = await categoryModel.findByIdAndUpdate(
        cId,
        {
          cDescription,
          cStatus,
          updatedAt: Date.now(),
        },
        { new: true }
      );
      if (!edit) {
        return res.status(404).json({ error: "Category not found" });
      }
      return res.json({ success: "Category edit successfully" });
    } catch (err) {
      return next(err);
    }
  }

  async getDeleteCategory(req, res, next) {
    try {
      const { cId } = req.body;
      if (!isValidObjectId(cId)) {
        return res.status(400).json({ error: "cId must be a valid id" });
      }

      const deleteCategory = await categoryModel.findByIdAndDelete(cId);
      if (!deleteCategory) {
        return res.status(404).json({ error: "Category not found" });
      }
      safeUnlinkCategory(deleteCategory.cImage);
      return res.json({ success: "Category deleted successfully" });
    } catch (err) {
      return next(err);
    }
  }
}

const categoryController = new Category();
module.exports = categoryController;
