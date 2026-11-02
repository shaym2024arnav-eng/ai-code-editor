// Verifies AI output before the user accepts it. The model can be wrong, so we
// check its code ourselves: does it still parse, did it remove exports other
// files rely on, did exported function signatures change?
const { parseFile } = require("../analysis/parseFile");
const { makeResolver } = require("../analysis/buildGraph");
const { isAnalyzable } = require("../ingest/filters");

// Remove ``` fences the model sometimes adds despite instructions.
function cleanCode(code) {
  if (typeof code !== "string") return "";
  const fenced = code.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return fenced ? fenced[1] : code;
}

function exportedSignatures(facts) {
  const sigs = new Map();
  const byName = new Map(facts.functions.map((f) => [f.name, f]));
  for (const e of facts.exports) {
    const fn = byName.get(e.local);
    sigs.set(e.name, fn ? { params: fn.params, async: fn.async } : null);
  }
  return sigs;
}

// Which project files import any of `names` from `targetPath`?
function findUsers(allFiles, targetPath, names) {
  const fileSet = new Set(allFiles.map((f) => f.path));
  const resolve = makeResolver(fileSet);
  const users = new Map(names.map((n) => [n, []]));
  for (const f of allFiles) {
    if (f.path === targetPath || !isAnalyzable(f.path)) continue;
    const facts = parseFile(f.path, f.content);
    for (const imp of facts.imports) {
      if (resolve(f.path, imp.source) !== targetPath) continue;
      for (const s of imp.specifiers) {
        if (users.has(s.imported) && !users.get(s.imported).includes(f.path)) users.get(s.imported).push(f.path);
      }
      // const ctrl = require("./x"); ctrl.removedFn()
      const moduleLocals = imp.specifiers.filter((s) => s.imported === "module" || s.imported === "*").map((s) => s.local);
      if (moduleLocals.length) {
        for (const c of facts.calls) {
          if (moduleLocals.includes(c.object) && users.has(c.property) && !users.get(c.property).includes(f.path)) {
            users.get(c.property).push(f.path);
          }
        }
      }
    }
  }
  return users;
}

async function checkImprovement({ filePath, originalCode, updatedCode, loadAllFiles }) {
  const linesBefore = originalCode.split("\n").length;
  const linesAfter = updatedCode.split("\n").length;
  const result = {
    identical: originalCode === updatedCode,
    linesBefore,
    linesAfter,
    syntaxOk: true,
    syntaxError: null,
    removedExports: [],
    changedSignatures: [],
    warnings: [],
  };
  if (!updatedCode.trim()) {
    result.syntaxOk = false;
    result.warnings.push("The AI returned an empty file.");
    return result;
  }
  if (!isAnalyzable(filePath)) return result;

  const before = parseFile(filePath, originalCode);
  const after = parseFile(filePath, updatedCode);

  if (after.error && !before.error) {
    result.syntaxOk = false;
    result.syntaxError = after.error;
    result.warnings.push(`The updated code does not parse: ${after.error}`);
  }

  const beforeSigs = exportedSignatures(before);
  const afterSigs = exportedSignatures(after);
  const removed = [...beforeSigs.keys()].filter((name) => !afterSigs.has(name));
  if (removed.length) {
    const users = findUsers(await loadAllFiles(), filePath, removed);
    result.removedExports = removed.map((name) => ({ name, usedBy: users.get(name) || [] }));
    result.removedExports
      .filter((r) => r.usedBy.length)
      .forEach((r) => result.warnings.push(`Export "${r.name}" was removed but is used by ${r.usedBy.join(", ")}.`));
  }

  for (const [name, sig] of beforeSigs) {
    const next = afterSigs.get(name);
    if (sig && next && (sig.params !== next.params || sig.async !== next.async)) {
      result.changedSignatures.push({ name, before: sig, after: next });
      if (sig.async !== next.async) result.warnings.push(`"${name}" changed between sync and async; callers may need await.`);
      else result.warnings.push(`"${name}" now takes ${next.params} parameter(s) instead of ${sig.params}.`);
    }
  }

  return result;
}

module.exports = { checkImprovement, cleanCode };
