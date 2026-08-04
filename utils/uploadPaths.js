const path = require("path");
const { config } = require("../config/appConfig");

function uploadFolderPath(folder) {
  const safeFolder = path.basename(String(folder || ""));
  const folderPath = path.resolve(config.uploadRoot, safeFolder);
  const rootWithSeparator = config.uploadRoot.endsWith(path.sep)
    ? config.uploadRoot
    : `${config.uploadRoot}${path.sep}`;

  if (!safeFolder || !folderPath.startsWith(rootWithSeparator)) {
    throw new Error("Invalid upload folder");
  }
  return folderPath;
}

function uploadFilePath(folder, filename) {
  const safeFileName = path.basename(String(filename || ""));
  if (!safeFileName) {
    return null;
  }
  return path.join(uploadFolderPath(folder), safeFileName);
}

function uploadPublicUrl(folder, filename) {
  const safeFolder = path.basename(String(folder || ""));
  const safeFileName = path.basename(String(filename || ""));
  const basePath = config.uploadPublicPath.startsWith("/")
    ? config.uploadPublicPath
    : `/${config.uploadPublicPath}`;
  return `${basePath.replace(/\/$/, "")}/${safeFolder}/${safeFileName}`;
}

module.exports = {
  uploadFilePath,
  uploadFolderPath,
  uploadPublicUrl,
};
