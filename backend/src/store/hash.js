const crypto = require("crypto");

const hashContent = (content) =>
  crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);

module.exports = { hashContent };
