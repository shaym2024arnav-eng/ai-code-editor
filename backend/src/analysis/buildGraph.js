// Connects per-file facts into one project graph:
//   file --imports--> file | package
//   file --contains--> function
//   function --calls/renders--> function
//   file --defines--> route,  route --handles/middleware--> function
//   function|file --requests--> route   (frontend fetch/axios matched to backend routes)
//   file --defines--> model,  function --uses-model--> model
// plus deterministic insights (cycles, large functions, unused exports, ...).
const posix = require("path").posix;
const { builtinModules } = require("module");
const { parseFile } = require("./parseFile");
const { isAnalyzable, extensionOf } = require("../ingest/filters");

const BUILTINS = new Set(builtinModules);
const RESOLVE_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const LARGE_FUNCTION_LINES = 60;

const fileId = (p) => `file:${p}`;
const fnId = (p, name) => `fn:${p}#${name}`;

const ENTRY_RE = /(^|\/)(index|main|server|app|_app|_document|layout|page|setup|setupTests|middleware|instrumentation)\.[cm]?[jt]sx?$|\.(config|test|spec|stories|d)\.[cm]?[jt]sx?$|(^|\/)(pages|app|tests?|__tests__|__mocks__|scripts|bin|e2e|cypress)\//i;
const isEntryLike = (p) => ENTRY_RE.test(p);

function packageName(source) {
  if (source.startsWith("node:")) return { name: source, builtin: true };
  const first = source.split("/")[0];
  if (BUILTINS.has(source) || BUILTINS.has(first)) return { name: `node:${first}`, builtin: true };
  if (source.startsWith("@")) return { name: source.split("/").slice(0, 2).join("/"), builtin: false };
  return { name: first, builtin: false };
}

function makeResolver(fileSet) {
  const topDirs = [...new Set([...fileSet].filter((p) => p.includes("/")).map((p) => p.split("/")[0]))];

  return function resolveImport(fromPath, source) {
    let bases;
    if (source.startsWith("./") || source.startsWith("../") || source === "." || source === "..") {
      bases = [posix.normalize(posix.join(posix.dirname(fromPath), source))];
    } else if (source.startsWith("@/") || source.startsWith("~/")) {
      // Common Vite/Next alias for "src/". Try src/ at the root and inside each top folder.
      const rest = source.slice(2);
      bases = [`src/${rest}`, rest, ...topDirs.map((d) => `${d}/src/${rest}`)];
    } else if (source.startsWith("/")) {
      bases = [source.slice(1)];
    } else {
      return null; // bare package
    }

    for (const base of bases) {
      if (!base || base.startsWith("..")) continue;
      const candidates = [base, ...RESOLVE_EXTS.map((e) => base + e)];
      if (/\.[cm]?js$/.test(base)) {
        const stem = base.replace(/\.[cm]?js$/, "");
        candidates.push(`${stem}.ts`, `${stem}.tsx`); // TS ESM: "./x.js" means ./x.ts
      }
      candidates.push(...RESOLVE_EXTS.map((e) => `${base}/index${e}`));
      const hit = candidates.find((c) => fileSet.has(c));
      if (hit) return hit;
    }
    return undefined; // relative import to a file that isn't in the project
  };
}

function joinUrl(...parts) {
  const joined = `/${parts.filter(Boolean).join("/")}`.replace(/\/+/g, "/");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

const segments = (url) => url.split("/").filter(Boolean);
const isWild = (seg) => seg.startsWith(":") || seg === "*" || seg.includes(":param");

function urlMatchScore(clientUrl, baseUnknown, routePath) {
  const c = segments(clientUrl);
  const r = segments(routePath);
  const segMatch = (cs, rs) => isWild(rs) || isWild(cs) || cs === rs;
  const literals = (pairs) => pairs.filter(([cs, rs]) => !isWild(cs) && !isWild(rs)).length;

  if (c.length === r.length && c.every((cs, i) => segMatch(cs, r[i]))) {
    return 2 + literals(c.map((cs, i) => [cs, r[i]])) * 0.01;
  }
  // Base URL came from an env variable we can't see: allow a suffix match,
  // but only when the client path has at least one literal segment.
  if (baseUnknown && c.length > 0 && c.length < r.length) {
    const offset = r.length - c.length;
    const pairs = c.map((cs, i) => [cs, r[offset + i]]);
    if (pairs.every(([cs, rs]) => segMatch(cs, rs)) && literals(pairs) > 0) return 1 + literals(pairs) * 0.01;
  }
  return 0;
}

// Tarjan's strongly connected components; returns groups with more than one file.
function findCycles(nodes, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const result = [];

  const strongConnect = (v) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) || []) {
      if (!idx.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const group = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) result.push(group.sort());
    }
  };

  nodes.forEach((v) => !idx.has(v) && strongConnect(v));
  return result;
}

function buildGraph(files) {
  const fileSet = new Set(files.map((f) => f.path));
  const resolveImport = makeResolver(fileSet);
  // Same resolver over lower-cased paths, to explain imports that only work on
  // case-insensitive file systems (Windows/macOS) and break on Linux servers.
  const lowerToReal = new Map([...fileSet].map((p) => [p.toLowerCase(), p]));
  const resolveLower = makeResolver(new Set(lowerToReal.keys()));
  const brokenImports = [];
  const facts = new Map();
  const parseErrors = [];

  for (const f of files) {
    if (!isAnalyzable(f.path)) continue;
    const r = parseFile(f.path, f.content);
    facts.set(f.path, r);
    if (r.error) parseErrors.push({ path: f.path, message: r.error });
  }

  const nodes = new Map();
  const edges = new Map();
  const addNode = (node) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return nodes.get(node.id);
  };
  const addEdge = (source, target, type, extra = {}) => {
    if (!source || !target || source === target) return;
    const key = `${type}|${source}|${target}`;
    const existing = edges.get(key);
    if (existing) existing.count += 1;
    else edges.set(key, { id: `e${edges.size}`, source, target, type, count: 1, ...extra });
  };

  const ensureFileNode = (p) =>
    addNode({ id: fileId(p), type: "file", path: p, language: extensionOf(p).replace(".", "") || "text", lines: null });

  // 1. File and function nodes
  for (const [p, f] of facts) {
    addNode({
      id: fileId(p),
      type: "file",
      path: p,
      language: f.language,
      lines: f.lines,
      functions: f.functions.length,
      exports: f.exports.length,
      folder: p.includes("/") ? p.split("/")[0] : ".",
      parseError: f.error || undefined,
    });
    for (const fn of f.functions) {
      addNode({ id: fnId(p, fn.name), type: "function", path: p, ...fn });
      addEdge(fileId(p), fnId(p, fn.name), "contains");
    }
  }

  // 2. Imports and local bindings
  const bindings = new Map(); // path -> Map(local -> { target, imported })
  const importers = new Map(); // path -> Set(importing paths)
  const usedExports = new Map(); // path -> Set(export names)
  const wholeModuleUsed = new Set();
  const markUsed = (p, name) => {
    if (!usedExports.has(p)) usedExports.set(p, new Set());
    usedExports.get(p).add(name);
  };

  for (const [p, f] of facts) {
    const local = new Map();
    bindings.set(p, local);
    for (const imp of f.imports) {
      const resolved = resolveImport(p, imp.source);
      if (resolved) {
        ensureFileNode(resolved);
        addEdge(fileId(p), fileId(resolved), "imports", { kind: imp.kind, typeOnly: imp.typeOnly || undefined });
        if (!importers.has(resolved)) importers.set(resolved, new Set());
        importers.get(resolved).add(p);
        if (imp.kind === "dynamic" || imp.specifiers.some((s) => s.all)) wholeModuleUsed.add(resolved);
        for (const s of imp.specifiers) {
          if (s.imported === "*") { if (s.reexport) wholeModuleUsed.add(resolved); }
          else if (s.imported === "module") markUsed(resolved, "default");
          else markUsed(resolved, s.imported);
          if (!s.reexport) local.set(s.local, { target: resolved, imported: s.imported });
        }
      } else if (resolved === null) {
        const pkg = packageName(imp.source);
        addNode({ id: `pkg:${pkg.name}`, type: "package", name: pkg.name, builtin: pkg.builtin });
        addEdge(fileId(p), `pkg:${pkg.name}`, "imports", { kind: imp.kind });
        for (const s of imp.specifiers) if (!s.reexport) local.set(s.local, { target: null, pkg: pkg.name, imported: s.imported });
      }
      else {
        const lower = resolveLower(p.toLowerCase(), imp.source.toLowerCase());
        brokenImports.push({
          path: p,
          source: imp.source,
          line: imp.line,
          caseMismatch: lower ? lowerToReal.get(lower) : undefined,
        });
      }
    }
  }

  // Follow an export (through re-exports) to the file and local name that define it.
  function resolveExport(targetPath, exportName, depth = 0) {
    const tf = facts.get(targetPath);
    if (!tf || depth > 6 || exportName == null) return null;
    const exp = tf.exports.find((e) => e.name === exportName);
    if (exp) {
      if (exp.local.startsWith("@reexport:")) {
        const [, source, imported] = exp.local.match(/^@reexport:(.*):([^:]*)$/) || [];
        const next = source && resolveImport(targetPath, source);
        return next && imported !== "*" ? resolveExport(next, imported, depth + 1) : null;
      }
      return { path: targetPath, local: exp.local };
    }
    for (const imp of tf.imports) {
      if (imp.kind === "reexport" && imp.specifiers.some((s) => s.all)) {
        const next = resolveImport(targetPath, imp.source);
        const hit = next && resolveExport(next, exportName, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  const fnNode = (p, local) => (local && nodes.has(fnId(p, local)) ? fnId(p, local) : null);
  const callerIdFor = (p, caller) => (caller === "(module)" ? fileId(p) : fnNode(p, caller) || fileId(p));

  // Resolve a callee ({name} or {object, property}) seen in file p to a node id.
  function resolveCallee(p, callee, callerName) {
    const f = facts.get(p);
    const local = bindings.get(p);
    if (callee.inline) return fnNode(p, callee.name);
    if (callee.name) {
      const own = f.functions.find((fn) => fn.name === callee.name && fn.kind !== "method");
      if (own) return fnId(p, own.name);
      const b = local.get(callee.name);
      if (b && b.target) {
        const exportName = b.imported === "module" ? "default" : b.imported === "*" ? null : b.imported;
        const hit = resolveExport(b.target, exportName);
        return hit ? fnNode(hit.path, hit.local) : null;
      }
      return null;
    }
    if (callee.object === "@this") {
      const cls = callerName && callerName.includes(".") ? callerName.split(".")[0] : null;
      return cls ? fnNode(p, `${cls}.${callee.property}`) : null;
    }
    const b = local.get(callee.object);
    if (!b || !b.target) return null;
    const target = facts.get(b.target);
    if (b.imported === "*" || b.imported === "module") {
      markUsed(b.target, callee.property);
      const hit = resolveExport(b.target, callee.property);
      if (hit) return fnNode(hit.path, hit.local);
    }
    // User.findOne() where User comes from a model file
    if (target && target.models.length) {
      const model = target.models.find((m) => m.name === callee.object) || target.models[0];
      return `model:${model.name}`;
    }
    return null;
  }

  // 3. Models
  for (const [p, f] of facts) {
    for (const m of f.models) {
      addNode({ id: `model:${m.name}`, type: "model", name: m.name, path: p, line: m.line });
      addEdge(fileId(p), `model:${m.name}`, "defines");
    }
  }

  // 4. Calls
  for (const [p, f] of facts) {
    for (const c of f.calls) {
      const target = resolveCallee(p, c, c.caller);
      if (!target) continue;
      const source = callerIdFor(p, c.caller);
      const type = target.startsWith("model:") ? "uses-model" : c.jsx ? "renders" : "calls";
      addEdge(source, target, type);
    }
  }

  // 5. Routes (with prefixes from app.use("/api/x", router))
  const mountEdges = [];
  for (const [p, f] of facts) {
    for (const m of f.mounts) {
      const child = m.local ? bindings.get(p).get(m.local)?.target : resolveImport(p, m.source);
      if (child) mountEdges.push({ parent: p, child, prefix: m.prefix });
    }
  }
  const prefixCache = new Map();
  function prefixesFor(p, seen = new Set()) {
    if (prefixCache.has(p)) return prefixCache.get(p);
    const parents = mountEdges.filter((e) => e.child === p && !seen.has(e.parent));
    const out = parents.length
      ? [...new Set(parents.flatMap((e) => prefixesFor(e.parent, new Set([...seen, p])).map((pre) => joinUrl(pre, e.prefix))))]
      : [""];
    if (seen.size === 0) prefixCache.set(p, out);
    return out;
  }

  const routes = [];
  for (const [p, f] of facts) {
    for (const r of f.routes) {
      for (const prefix of prefixesFor(p)) {
        const full = joinUrl(prefix, r.path);
        const id = `route:${r.method} ${full}`;
        addNode({ id, type: "route", method: r.method, path: full, file: p, line: r.line });
        routes.push({ id, method: r.method, path: full });
        addEdge(fileId(p), id, "defines");
        r.handlers.forEach((h, i) => {
          const target = resolveCallee(p, h, null);
          if (target) addEdge(id, target, i === r.handlers.length - 1 ? "handles" : "middleware");
        });
      }
    }
  }

  // 6. Frontend requests -> backend routes
  function resolveParts(parts, p, depth = 0) {
    let url = "";
    let baseUnknown = false;
    let literal = false;
    for (const part of parts) {
      if (part.text !== undefined) { url += part.text; literal = true; continue; }
      if (part.param) { url += ":param"; continue; }
      if (part.env) { if (url === "") baseUnknown = true; else url += ":param"; continue; }
      if (part.ident) {
        const f = facts.get(p);
        let resolved = null;
        if (depth < 4 && f.consts[part.ident]) resolved = resolveParts(f.consts[part.ident], p, depth + 1);
        else {
          const b = bindings.get(p).get(part.ident);
          const tf = b && b.target && facts.get(b.target);
          if (depth < 4 && tf && tf.consts[b.imported]) resolved = resolveParts(tf.consts[b.imported], b.target, depth + 1);
        }
        if (resolved && resolved.literal) {
          url += resolved.url;
          literal = true;
          if (resolved.baseUnknown && url === resolved.url) baseUnknown = true;
        } else if (url === "") baseUnknown = true;
        else url += ":param";
      }
    }
    return { url, baseUnknown, literal };
  }

  const requests = [];
  for (const [p, f] of facts) {
    for (const req of f.requests) {
      const { url: raw, baseUnknown, literal } = resolveParts(req.parts, p);
      if (!literal) continue;
      let url = raw.split(/[?#]/)[0];
      const absolute = /^https?:\/\//i.test(url);
      const host = absolute ? url.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase() : null;
      const external = Boolean(host) && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host);
      url = url.replace(/^https?:\/\/[^/]+/i, "") || "/";
      if (!url.startsWith("/")) url = `/${url}`;
      url = url.replace(/\/+/g, "/");

      let best = null;
      let bestScore = 0;
      let tie = false;
      for (const route of routes) {
        if (route.method !== req.method && route.method !== "ALL") continue;
        const score = urlMatchScore(url, baseUnknown && !absolute, route.path);
        if (score > bestScore) { best = route; bestScore = score; tie = false; }
        else if (score > 0 && score === bestScore && route.id !== best.id) tie = true;
      }
      const matched = best && !tie ? best.id : null;
      const source = callerIdFor(p, req.caller);
      if (matched) addEdge(source, matched, "requests", { method: req.method });
      requests.push({
        file: p, caller: req.caller, method: req.method, url, line: req.line, route: matched,
        external: external && !matched ? host : undefined,
      });
    }
  }

  // 7. Insights
  const projectFiles = [...facts.keys()];
  const importAdj = new Map(projectFiles.map((p) => [p, []]));
  for (const e of edges.values()) {
    if (e.type === "imports" && !e.typeOnly && e.source.startsWith("file:") && e.target.startsWith("file:")) {
      const s = e.source.slice(5);
      const t = e.target.slice(5);
      if (importAdj.has(s) && facts.has(t)) importAdj.get(s).push(t);
    }
  }

  const fanIn = (p) => (importers.get(p) ? importers.get(p).size : 0);

  const insights = {
    cycles: findCycles(projectFiles, importAdj).slice(0, 20),
    largeFunctions: [...nodes.values()]
      .filter((n) => n.type === "function" && n.kind !== "class" && n.lines > LARGE_FUNCTION_LINES)
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 15)
      .map((n) => ({ path: n.path, name: n.name, lines: n.lines, startLine: n.startLine })),
    unusedExports: projectFiles
      .filter((p) => !isEntryLike(p) && !wholeModuleUsed.has(p) && fanIn(p) > 0)
      .flatMap((p) => {
        const used = usedExports.get(p) || new Set();
        return facts.get(p).exports
          .filter((e) => e.name !== "default" && !used.has(e.name))
          .map((e) => ({ path: p, name: e.name }));
      })
      .slice(0, 40),
    orphanFiles: projectFiles.filter((p) => fanIn(p) === 0 && !isEntryLike(p)).slice(0, 40),
    hubs: projectFiles
      .map((p) => ({ path: p, importedBy: fanIn(p) }))
      .filter((h) => h.importedBy > 1)
      .sort((a, b) => b.importedBy - a.importedBy)
      .slice(0, 8),
    unmatchedRequests: requests.filter((r) => !r.route && !r.external).slice(0, 40),
    externalRequests: requests.filter((r) => r.external).slice(0, 40),
    brokenImports: brokenImports.slice(0, 40),
  };

  const nodeList = [...nodes.values()];
  const edgeList = [...edges.values()];
  const count = (type) => nodeList.filter((n) => n.type === type).length;

  const languages = {};
  files.forEach((f) => {
    const ext = extensionOf(f.path).replace(".", "") || "other";
    languages[ext] = (languages[ext] || 0) + 1;
  });

  const stats = {
    files: files.length,
    analyzedFiles: facts.size,
    functions: count("function"),
    routes: count("route"),
    models: count("model"),
    packages: nodeList.filter((n) => n.type === "package" && !n.builtin).length,
    requests: requests.length,
    matchedRequests: requests.filter((r) => r.route).length,
    importEdges: edgeList.filter((e) => e.type === "imports").length,
    parseErrors: parseErrors.length,
    brokenImports: brokenImports.length,
    totalBytes: files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0),
    languages,
  };

  return {
    graph: {
      version: 1,
      generatedAt: new Date().toISOString(),
      nodes: nodeList,
      edges: edgeList,
      requests,
      insights,
      parseErrors,
    },
    stats,
  };
}

module.exports = { buildGraph, makeResolver, urlMatchScore, joinUrl, isEntryLike };
