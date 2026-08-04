const express = require("express");
const mongoose = require("mongoose");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const helmet = require("helmet");
const { config, validateConfig } = require("./config/appConfig");

const app = express();

validateConfig();
app.disable("x-powered-by");

if (config.trustProxy) {
  app.set("trust proxy", config.trustProxy === "true" ? true : config.trustProxy);
}

const authRouter = require("./routes/auth");
const categoryRouter = require("./routes/categories");
const productRouter = require("./routes/products");
const brainTreeRouter = require("./routes/braintree");
const orderRouter = require("./routes/orders");
const cartRouter = require("./routes/cart");
const usersRouter = require("./routes/users");
const customerAccountsRouter = require("./routes/customerAccounts");
const commerceRouter = require("./routes/commerce");
const paymentsRouter = require("./routes/payments");
const customizeRouter = require("./routes/customize");
const CreateAllFolder = require("./config/uploadFolderCreateScript");

CreateAllFolder();

const allowedOrigins = config.clientOrigin
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("CORS origin is not allowed"));
  },
  credentials: true,
};

app.use(helmet());
app.use(morgan(config.nodeEnv === "test" ? "tiny" : "dev"));
app.use(cookieParser());
app.use(cors(corsOptions));
app.use(express.static("public"));
app.use(config.uploadPublicPath, express.static(config.uploadRoot));
app.use(express.urlencoded({ extended: false, limit: config.maxJsonBodySize }));
app.use(express.json({ limit: config.maxJsonBodySize }));

app.get("/api/health", (req, res) => {
  return res.json({
    success: true,
    status: "ok",
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

app.get("/api/ready", (req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  return res.status(databaseReady ? 200 : 503).json({
    success: databaseReady,
    status: databaseReady ? "ready" : "not_ready",
    checks: {
      config: "valid",
      database: databaseReady ? "connected" : "disconnected",
    },
  });
});

app.use("/api", authRouter);
app.use("/api/user", usersRouter);
app.use("/api/category", categoryRouter);
app.use("/api/product", productRouter);
app.use("/api", brainTreeRouter);
app.use("/api/cart", cartRouter);
app.use("/api/order", orderRouter);
app.use("/api", customerAccountsRouter);
app.use("/api", commerceRouter);
app.use("/api", paymentsRouter);
app.use("/api/customize", customizeRouter);

app.use("/api", (req, res) => {
  return res.status(404).json({
    success: false,
    code: "NOT_FOUND",
    error: "API route not found",
  });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  const message =
    status === 500 && config.nodeEnv === "production"
      ? "Internal server error"
      : err.message || "Internal server error";

  return res.status(status).json({
    success: false,
    error: message,
  });
});

async function connectDatabase() {
  await mongoose.connect(config.databaseUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
}

let server;

async function start() {
  await connectDatabase();
  console.log("Mongodb database connected successfully");
  server = app.listen(config.port, () => {
    console.log("Server is running on ", config.port);
  });
  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Server failed to start");
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  connectDatabase,
};
