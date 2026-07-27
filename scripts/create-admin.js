require("dotenv").config();

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const userModel = require("../models/users");
const { assertLocalMongoDatabase } = require("../utils/localDatabase");
const { normalizeEmail } = require("../utils/validation");

async function main() {
  assertLocalMongoDatabase(process.env.DATABASE);

  const name = String(process.env.ADMIN_NAME || "").trim();
  const email = normalizeEmail(process.env.ADMIN_EMAIL);
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !email || !password) {
    throw new Error("ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD are required");
  }
  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD must be at least 12 characters long");
  }

  await mongoose.connect(process.env.DATABASE, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });

  const existingUser = await userModel.findOne({ email }).select("+password");
  if (existingUser) {
    if (existingUser.userRole !== 1) {
      existingUser.userRole = 1;
      await existingUser.save();
      console.log("Existing local user promoted to administrator.");
    } else {
      console.log("Administrator already exists for the supplied email.");
    }
    return;
  }

  await userModel.create({
    name,
    email,
    password: bcrypt.hashSync(password, 10),
    userRole: 1,
  });
  console.log("Administrator created.");
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
