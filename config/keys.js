const { config } = require("./appConfig");

module.exports = {
  JWT_SECRET: config.jwtSecret,
};
