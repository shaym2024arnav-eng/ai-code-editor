const { badRequest } = require("./errors");
const { normalizePath } = require("../ingest/filters");

function requireString(value, field, { max = 10000, min = 1 } = {}) {
  if (typeof value !== "string") throw badRequest(`"${field}" is required.`);
  const v = value.trim();
  if (v.length < min) throw badRequest(`"${field}" is required.`);
  if (v.length > max) throw badRequest(`"${field}" must be at most ${max} characters.`);
  return v;
}

function optionalString(value, field, { max = 10000 } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest(`"${field}" must be text.`);
  const v = value.trim();
  if (v.length > max) throw badRequest(`"${field}" must be at most ${max} characters.`);
  return v || undefined;
}

function requirePath(value, field = "path") {
  const p = normalizePath(requireString(value, field, { max: 500 }));
  if (!p) throw badRequest(`"${field}" is not a valid project path.`);
  return p;
}

function parseScope(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw badRequest('"scope" must be a list of paths or globs.');
  if (value.length > 20) throw badRequest('"scope" can have at most 20 entries.');
  return [...new Set(value.map((s) => requireString(s, "scope", { max: 200 }).replace(/\\/g, "/").replace(/^\.?\//, "")))];
}

function parseSelection(value, totalLines) {
  if (value === undefined || value === null) return null;
  const start = Number(value.startLine);
  const end = Number(value.endLine);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw badRequest('"selection" needs whole-number startLine and endLine, with startLine <= endLine.');
  }
  if (start > totalLines) throw badRequest('"selection" starts after the end of the file.');
  return { startLine: start, endLine: Math.min(end, totalLines) };
}

module.exports = { requireString, optionalString, requirePath, parseScope, parseSelection };
