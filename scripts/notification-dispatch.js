const mongoose = require("mongoose");
const { config, validateConfig } = require("../config/appConfig");
const { dispatchBatch } = require("../services/notificationDispatcher");

async function main() {
  validateConfig();
  if (!config.openwaEnabled) {
    console.log("WHATSAPP_DISPATCH_SKIPPED disabled");
    return;
  }
  await mongoose.connect(config.databaseUrl, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
  });
  const results = await dispatchBatch();
  const sent = results.filter((result) => result.sent).length;
  const failed = results.filter((result) => result.failed).length;
  console.log(`WHATSAPP_DISPATCH_COMPLETE sent=${sent} failed=${failed}`);
}

main()
  .catch((err) => {
    console.error(`WHATSAPP_DISPATCH_FAILED ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
