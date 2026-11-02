// Central place for limits and settings, so they are easy to find and tune.

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const config = {
  port: toInt(process.env.PORT, 5000),
  mongoUri: process.env.MONGO_URI || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  githubToken: process.env.GITHUB_TOKEN || "",
  // Comma-separated list of allowed browser origins. Empty = allow all (local dev only).
  corsOrigins: (process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  limits: {
    maxFiles: toInt(process.env.MAX_FILES, 400),
    maxFileBytes: toInt(process.env.MAX_FILE_BYTES, 300 * 1024),
    maxTotalBytes: toInt(process.env.MAX_TOTAL_BYTES, 8 * 1024 * 1024),
    maxZipBytes: toInt(process.env.MAX_ZIP_BYTES, 25 * 1024 * 1024),
    maxZipEntries: 10000,
    maxProjectsPerClient: toInt(process.env.MAX_PROJECTS_PER_CLIENT, 20),
    maxImproveFileBytes: 80 * 1024,
    maxQuestionChars: 2000,
    maxInstructionsChars: 2000,
  },
};

module.exports = config;
