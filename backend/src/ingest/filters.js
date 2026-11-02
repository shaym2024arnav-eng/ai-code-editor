// Decides which files from an upload or repo are kept, and normalizes their paths.
const path = require("path").posix;
const { badRequest } = require("../middleware/errors");

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", ".next", ".nuxt",
  ".vercel", ".netlify", "coverage", ".cache", ".parcel-cache", ".turbo", "vendor",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "target", ".gradle",
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", ".DS_Store", "Thumbs.db",
]);

const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt", ".css", ".scss",
  ".sass", ".less", ".html", ".htm", ".vue", ".svelte", ".yml", ".yaml", ".toml", ".ini", ".xml",
  ".svg", ".graphql", ".gql", ".sql", ".sh", ".py", ".java", ".go", ".rb", ".php", ".rs", ".c",
  ".cpp", ".h", ".cs", ".kt", ".swift", ".prisma", ".env.example",
]);

// Files without an extension that are still useful to see.
const TEXT_BASENAMES = new Set([
  "Dockerfile", "Makefile", "Procfile", "LICENSE", "README", ".gitignore", ".dockerignore",
  ".editorconfig", ".prettierrc", ".eslintrc", ".babelrc", ".nvmrc", ".npmrc",
]);

const ANALYZABLE = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

// Normalize a user-supplied path to "a/b/c.js". Returns null for paths that try
// to escape the project (".."), are absolute on Windows, or are empty.
function normalizePath(raw) {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!cleaned || /^[a-zA-Z]:/.test(cleaned)) return null;
  const parts = cleaned.split("/").filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}

const extensionOf = (p) => {
  const base = path.basename(p);
  if (base.endsWith(".env.example")) return ".env.example";
  return path.extname(base).toLowerCase();
};

// Why a path should be skipped, or null if it should be kept.
function skipReason(p) {
  const parts = p.split("/");
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((dir) => IGNORED_DIRS.has(dir))) return "ignored-folder";
  if (IGNORED_FILES.has(base)) return "ignored-file";
  // Never store secrets: .env, .env.local, .env.production ... (but keep .env.example)
  if (/^\.env(\..+)?$/.test(base) && base !== ".env.example") return "secret";
  if (/\.(min\.js|map)$/.test(base)) return "generated";
  if (!TEXT_EXTENSIONS.has(extensionOf(p)) && !TEXT_BASENAMES.has(base)) return "unsupported-type";
  return null;
}

// A NUL byte in the first 8 KB is a reliable sign of a binary file.
const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

const isAnalyzable = (p) => ANALYZABLE.has(extensionOf(p));

// Many uploads arrive wrapped in one top folder ("my-app/src/...", or GitHub's
// "owner-repo-sha/..."). Strip it so paths start at the project root.
function stripCommonRoot(files) {
  if (files.length === 0) return files;
  const first = files[0].path.split("/")[0];
  const allShare = files.every((f) => f.path.includes("/") && f.path.split("/")[0] === first);
  if (!allShare) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(first.length + 1) }));
}

// Collects entries ({ path, size, read() }) into [{ path, content }] while
// enforcing all limits. `read` is only called for entries that pass the filters.
function collectFiles(entries, limits) {
  const kept = [];
  const skipped = { count: 0, reasons: {} };
  const skip = (reason) => {
    skipped.count += 1;
    skipped.reasons[reason] = (skipped.reasons[reason] || 0) + 1;
  };
  let totalBytes = 0;
  const seen = new Set();

  for (const entry of entries) {
    const p = normalizePath(entry.path);
    if (!p) { skip("invalid-path"); continue; }
    const reason = skipReason(p);
    if (reason) { skip(reason); continue; }
    if (entry.size > limits.maxFileBytes) { skip("too-large"); continue; }
    if (seen.has(p)) { skip("duplicate"); continue; }
    if (kept.length >= limits.maxFiles) {
      throw badRequest(`Project has more than ${limits.maxFiles} source files. Upload a smaller project or a sub-folder.`);
    }
    if (totalBytes + entry.size > limits.maxTotalBytes) {
      throw badRequest(`Project is larger than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB of source code.`);
    }

    const buffer = entry.read();
    if (buffer.length > limits.maxFileBytes) { skip("too-large"); continue; }
    if (looksBinary(buffer)) { skip("binary"); continue; }

    totalBytes += buffer.length;
    seen.add(p);
    kept.push({ path: p, content: buffer.toString("utf8") });
  }

  const files = stripCommonRoot(kept).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    throw badRequest("No supported source files were found in the upload.");
  }
  return { files, skipped, totalBytes };
}

module.exports = { normalizePath, skipReason, isAnalyzable, collectFiles, stripCommonRoot, extensionOf };
