// Filters a picked folder in the browser before upload, so node_modules and
// build output never leave the user's machine. The server applies the same rules again.
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", ".next", ".nuxt", ".vercel",
  ".netlify", "coverage", ".cache", ".parcel-cache", ".turbo", "vendor", "__pycache__", ".venv",
  "venv", ".idea", ".vscode", "target", ".gradle",
]);
const IGNORED_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", ".DS_Store"]);
const MAX_FILE_BYTES = 300 * 1024;
const MAX_FILES = 400;

export function pickFolderEntries(fileList) {
  const entries = [];
  let skipped = 0;
  for (const file of fileList) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    const parts = path.split("/");
    const base = parts[parts.length - 1];
    const ignored =
      parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d)) ||
      IGNORED_FILES.has(base) ||
      (/^\.env(\..+)?$/.test(base) && base !== ".env.example") ||
      file.size > MAX_FILE_BYTES;
    if (ignored) skipped += 1;
    else entries.push({ file, path });
  }
  return { entries, skipped, tooMany: entries.length > MAX_FILES, max: MAX_FILES };
}

export function languageForPath(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "typescript", json: "json", md: "markdown", mdx: "markdown",
    css: "css", scss: "scss", less: "less", html: "html", htm: "html", xml: "xml", svg: "xml",
    yml: "yaml", yaml: "yaml", py: "python", java: "java", go: "go", rb: "ruby", php: "php",
    rs: "rust", c: "c", cpp: "cpp", h: "cpp", cs: "csharp", kt: "kotlin", swift: "swift",
    sql: "sql", sh: "shell", graphql: "graphql", gql: "graphql", toml: "ini", ini: "ini",
  };
  if (/(^|\/)Dockerfile$/.test(path)) return "dockerfile";
  return map[ext] || "plaintext";
}

export const isAnalyzable = (path) => /\.(m|c)?[jt]sx?$/.test(path);
