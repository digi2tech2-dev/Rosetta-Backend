const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function parseMongoDatabaseName(pathname) {
  return String(pathname || "").replace(/^\//, "").split("?")[0];
}

function assertLocalMongoDatabase(databaseUrl, options = {}) {
  const { requiredDatabaseName } = options;
  if (!databaseUrl) {
    throw new Error("DATABASE is required");
  }
  if (databaseUrl.startsWith("mongodb+srv://")) {
    throw new Error("Remote MongoDB SRV URLs are not allowed for this operation");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (err) {
    throw new Error("DATABASE must be a valid MongoDB URL");
  }

  if (parsed.protocol !== "mongodb:") {
    throw new Error("DATABASE must use mongodb://");
  }

  const hosts = parsed.host.split(",").map((hostPart) => {
    const host = hostPart.trim().replace(/:\d+$/, "");
    return host;
  });
  if (hosts.length === 0 || hosts.some((host) => !LOOPBACK_HOSTS.has(host))) {
    throw new Error("DATABASE must use only localhost, 127.0.0.1, or ::1");
  }

  const databaseName = parseMongoDatabaseName(parsed.pathname);
  if (!databaseName) {
    throw new Error("DATABASE must include a database name");
  }
  if (requiredDatabaseName && databaseName !== requiredDatabaseName) {
    throw new Error(`DATABASE must use disposable database ${requiredDatabaseName}`);
  }

  return {
    hosts,
    databaseName,
  };
}

module.exports = {
  assertLocalMongoDatabase,
};
