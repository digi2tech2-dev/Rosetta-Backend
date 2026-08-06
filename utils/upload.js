const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { config } = require("../config/appConfig");
const { uploadFolderPath } = require("./uploadPaths");

const BYTES_PER_MB = 1024 * 1024;
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

function imageUpload(folder, maxFiles, options = {}) {
  const maxFileSizeMb = Number(options.maxFileSizeMb) || Math.ceil(config.uploadMaxFileSize / BYTES_PER_MB);
  const maxFileSizeBytes = Number(options.maxFileSizeBytes) || maxFileSizeMb * BYTES_PER_MB;
  const storage = multer.diskStorage({
    destination(req, file, cb) {
      req.uploadMaxFileSizeMb = maxFileSizeMb;
      req.uploadMaxFileSizeBytes = maxFileSizeBytes;
      cb(null, uploadFolderPath(folder));
    },
    filename(req, file, cb) {
      cb(null, safeUploadName(file));
    },
  });

  return multer({
    storage,
    fileFilter: imageFileFilter,
    limits: {
      // Busboy trips the limit at the boundary, so add one byte to make the advertised maximum inclusive.
      fileSize: maxFileSizeBytes + 1,
      files: maxFiles,
    },
  });
}

function cleanupUploadedFiles(req) {
  const files = [
    ...(Array.isArray(req.files) ? req.files : []),
    ...(req.file ? [req.file] : []),
  ];
  for (const file of files) {
    if (file && file.path) {
      fs.unlink(file.path, () => {});
    }
  }
}

function uploadErrorHandler(err, req, res, next) {
  if (!err) {
    return next();
  }
  cleanupUploadedFiles(req);
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    const code = err.code === "LIMIT_FILE_SIZE" ? "IMAGE_TOO_LARGE" : "VALIDATION_ERROR";
    const maxFileSizeMb = req.uploadMaxFileSizeMb || Math.ceil(config.uploadMaxFileSize / BYTES_PER_MB);
    const maxFileSizeBytes = req.uploadMaxFileSizeBytes || maxFileSizeMb * BYTES_PER_MB;
    return res.status(status).json({
      success: false,
      code,
      error: err.code === "LIMIT_FILE_SIZE"
        ? `Image exceeds the maximum allowed size of ${maxFileSizeMb} MB`
        : err.message,
      maxFileSizeMb: err.code === "LIMIT_FILE_SIZE" ? maxFileSizeMb : undefined,
      maxFileSizeBytes: err.code === "LIMIT_FILE_SIZE" ? maxFileSizeBytes : undefined,
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
