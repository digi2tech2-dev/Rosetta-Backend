const { toTitleCase } = require("../config/function");
const categoryModel = require("../models/categories");
const fs = require("fs");
const path = require("path");
const { isValidObjectId } = require("../utils/validation");
const { uploadFolderPath } = require("../utils/uploadPaths");

function safeUnlinkCategory(filename) {
  const basePath = uploadFolderPath("categories");
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

async function safeUnlinkCategoryIfUnreferenced(filename, currentCategoryId) {
  const safeFileName = path.basename(String(filename || ""));
  if (!safeFileName) return;
  const stillUsed = await categoryModel.exists({
    _id: { $ne: currentCategoryId },
    cImage: safeFileName,
  });
  if (!stillUsed) {
    safeUnlinkCategory(safeFileName);
  }
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
      let { cId, cName, cDescription, cStatus } = req.body;
      const newImage = req.file && req.file.filename;
      if (!isValidObjectId(cId) || !cName || cDescription === undefined || !cStatus) {
        safeUnlinkCategory(newImage);
        return res.status(400).json({ error: "All filled must be required" });
      }

      cName = toTitleCase(String(cName).trim());
      const currentCategory = await categoryModel.findById(cId);
      if (!currentCategory) {
        safeUnlinkCategory(newImage);
        return res.status(404).json({ error: "Category not found" });
      }

      const duplicateCategory = await categoryModel.findOne({
        _id: { $ne: cId },
        cName,
      });
      if (duplicateCategory) {
        safeUnlinkCategory(newImage);
        return res.status(409).json({ error: "Category already exists" });
      }

      const update = {
        cName,
        cDescription: String(cDescription || "").trim(),
        cStatus,
        updatedAt: Date.now(),
      };
      if (newImage) update.cImage = newImage;

      const edit = await categoryModel.findByIdAndUpdate(
        cId,
        update,
        { new: true, runValidators: true }
      );
      if (newImage && currentCategory.cImage && currentCategory.cImage !== newImage) {
        await safeUnlinkCategoryIfUnreferenced(currentCategory.cImage, edit._id);
      }
      return res.json({ success: "Category edit successfully", Category: edit });
    } catch (err) {
      if (req.file && req.file.filename) {
        safeUnlinkCategory(req.file.filename);
      }
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
