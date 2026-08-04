const fs = require("fs");
const { uploadFolderPath } = require("../utils/uploadPaths");

const uploadFolders = ["categories", "customize", "products", "avatars"];

const CreateAllFolder = () => {
  for (const folder of uploadFolders) {
    const folderPath = uploadFolderPath(folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, {
        recursive: true,
      });
    }
  }
};

module.exports = CreateAllFolder;
