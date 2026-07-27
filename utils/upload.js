const crypto = require("crypto");
const path = require("path");
const multer = require("multer");
const { config } = require("../config/appConfig");

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function safeUploadName(file) {
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(12).toString("hex")}${ext}`;
}

function imageFileFilter(req, file, cb) {
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  if (!IMAGE_MIME_TYPES.has(file.mimetype) || !IMAGE_EXTENSIONS.has(ext)) {
    return cb(Object.assign(new Error("Only JPEG, PNG, and WebP images are allowed"), {
      status: 400,
      code: "VALIDATION_ERROR",
    }));
  }
  return cb(null, true);
}

function imageUpload(folder, maxFiles) {
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      cb(null, path.join("public", "uploads", folder));
    },
    filename(req, file, cb) {
      cb(null, safeUploadName(file));
    },
  });

  return multer({
    storage,
    fileFilter: imageFileFilter,
    limits: {
      fileSize: config.uploadMaxFileSize,
      files: maxFiles,
    },
  });
}

function uploadErrorHandler(err, req, res, next) {
  if (!err) {
    return next();
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      success: false,
      code: status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR",
      error: err.message,
    });
  }
  return res.status(err.status || 400).json({
    success: false,
    code: err.code || "VALIDATION_ERROR",
    error: err.message,
  });
}

module.exports = {
  IMAGE_EXTENSIONS,
  IMAGE_MIME_TYPES,
  imageUpload,
  uploadErrorHandler,
};
