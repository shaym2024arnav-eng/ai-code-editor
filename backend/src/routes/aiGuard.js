const { HttpError } = require("../middleware/errors");

function requireAi(ai) {
  if (!ai) throw new HttpError(503, "AI features are off: set GEMINI_API_KEY on the server.");
}

module.exports = { requireAi };
