const multer = require("multer");

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const notFound = (what = "Resource") => new HttpError(404, `${what} not found`);
const badRequest = (message, details) => new HttpError(400, message, details);

// Express 5 forwards rejected promises from async handlers here automatically.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "A file is too large.",
      LIMIT_FILE_COUNT: "Too many files. Remove folders like node_modules and try again.",
      LIMIT_UNEXPECTED_FILE: "Unexpected upload field.",
    };
    return res.status(400).json({ message: messages[err.code] || err.message });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large." });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Invalid JSON body." });
  }

  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);

  res.status(status).json({
    message: status >= 500 && !(err instanceof HttpError) ?"Something went wrong on the server." : err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = { HttpError, notFound, badRequest, errorHandler };
