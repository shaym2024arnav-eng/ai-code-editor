const AdmZip = require("adm-zip");
const zlib = require("zlib");
const { collectFiles } = require("./filters");
const { badRequest } = require("../middleware/errors");

// Decompress one entry ourselves with a hard output cap, so a "zip bomb" that
// lies about its size can't exhaust memory.
function readEntry(entry, maxBytes) {
  const compressed = entry.getCompressedData();
  const method = entry.header.method;
  if (method === 0) return compressed; // stored, no compression
  if (method === 8) {
    try {
      return zlib.inflateRawSync(compressed, { maxOutputLength: maxBytes + 1 });
    } catch (err) {
      if (err.code === "ERR_BUFFER_TOO_LARGE" || /larger than/i.test(err.message)) {
        return Buffer.alloc(maxBytes + 1); // treated as too large by collectFiles
      }
      throw badRequest(`Could not read "${entry.entryName}" from the zip.`);
    }
  }
  throw badRequest(`"${entry.entryName}" uses an unsupported zip compression method.`);
}

function filesFromZip(buffer, limits) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw badRequest("The uploaded file is not a valid zip archive.");
  }

  const entries = zip.getEntries();
  if (entries.length > limits.maxZipEntries) {
    throw badRequest("The zip has too many entries. Remove node_modules and build folders first.");
  }

  return collectFiles(
    entries
      .filter((e) => !e.isDirectory)
      .map((e) => ({
        path: e.entryName,
        size: e.header.size,
        read: () => readEntry(e, limits.maxFileBytes),
      })),
    limits
  );
}

module.exports = { filesFromZip };
