const { HttpError } = require("./errors");

// There are no user accounts in this demo. Each browser generates a random UUID
// (kept in localStorage) and sends it as X-Client-Id. Every project is owned by
// that ID and every lookup is filtered by it, so one visitor can never list or
// open another visitor's projects. Swap this for real auth (JWT) if you add accounts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireClientId(req, res, next) {
  const id = req.get("x-client-id");
  if (!id || !UUID_RE.test(id)) {
    return next(new HttpError(401, "Missing or invalid X-Client-Id header."));
  }
  req.clientId = id.toLowerCase();
  next();
}

module.exports = { requireClientId, UUID_RE };
