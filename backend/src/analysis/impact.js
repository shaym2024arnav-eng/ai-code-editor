// Answers "what is connected to this file?" from the stored project graph.
// Deterministic (no AI), so it can be trusted and shown instantly.

function indexGraph(graph) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map();
  const inc = new Map();
  for (const e of graph.edges) {
    if (!out.has(e.source)) out.set(e.source, []);
    if (!inc.has(e.target)) inc.set(e.target, []);
    out.get(e.source).push(e);
    inc.get(e.target).push(e);
  }
  return { nodes, out: (id) => out.get(id) || [], inc: (id) => inc.get(id) || [] };
}

const pathOfNode = (node) => (node ? node.path || node.file || null : null);

function describe(node) {
  if (!node) return null;
  switch (node.type) {
    case "file": return { id: node.id, type: "file", path: node.path };
    case "function": return { id: node.id, type: "function", path: node.path, name: node.name, line: node.startLine };
    case "route": return { id: node.id, type: "route", method: node.method, path: node.path, file: node.file, line: node.line };
    case "model": return { id: node.id, type: "model", name: node.name, path: node.path };
    case "package": return { id: node.id, type: "package", name: node.name, builtin: node.builtin };
    default: return { id: node.id, type: node.type };
  }
}

function computeImpact(graph, filePath, { maxDepth = 5 } = {}) {
  const g = indexGraph(graph);
  const fid = `file:${filePath}`;
  if (!g.nodes.has(fid)) return null;

  const fileImports = g.out(fid).filter((e) => e.type === "imports");
  const importsFiles = fileImports.filter((e) => e.target.startsWith("file:")).map((e) => g.nodes.get(e.target).path);
  const importsPackages = fileImports
    .filter((e) => e.target.startsWith("pkg:"))
    .map((e) => g.nodes.get(e.target))
    .filter((n) => !n.builtin)
    .map((n) => n.name);

  const directImporters = g.inc(fid).filter((e) => e.type === "imports").map((e) => g.nodes.get(e.source).path);

  // Everything that depends on this file, directly or through other files.
  const transitive = new Map();
  let frontier = [filePath];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const p of frontier) {
      for (const e of g.inc(`file:${p}`)) {
        if (e.type !== "imports") continue;
        const src = g.nodes.get(e.source).path;
        if (src !== filePath && !transitive.has(src)) {
          transitive.set(src, depth);
          next.push(src);
        }
      }
    }
    frontier = next;
  }

  const functions = g.out(fid)
    .filter((e) => e.type === "contains")
    .map((e) => g.nodes.get(e.target))
    .map((fn) => {
      const callers = g.inc(fn.id)
        .filter((e) => ["calls", "renders", "handles", "middleware"].includes(e.type))
        .map((e) => ({ ...describe(g.nodes.get(e.source)), via: e.type }))
        .filter((c) => pathOfNode(c) !== filePath || c.type === "route");
      const callees = g.out(fn.id)
        .filter((e) => ["calls", "renders", "uses-model", "requests"].includes(e.type))
        .map((e) => ({ ...describe(g.nodes.get(e.target)), via: e.type }));
      return {
        name: fn.name,
        kind: fn.kind,
        startLine: fn.startLine,
        endLine: fn.endLine,
        lines: fn.lines,
        exported: fn.exported,
        externalCallers: callers,
        callees,
      };
    })
    .sort((a, b) => (a.startLine || 0) - (b.startLine || 0));

  const routesDefined = g.out(fid)
    .filter((e) => e.type === "defines" && e.target.startsWith("route:"))
    .map((e) => {
      const route = g.nodes.get(e.target);
      const clients = g.inc(route.id).filter((x) => x.type === "requests").map((x) => describe(g.nodes.get(x.source)));
      return { ...describe(route), clients };
    });

  const fnIds = new Set(functions.map((f) => `fn:${filePath}#${f.name}`));
  const sources = [fid, ...fnIds];
  const requestsMade = sources
    .flatMap((id) => g.out(id).filter((e) => e.type === "requests"))
    .map((e) => {
      const route = g.nodes.get(e.target);
      const handler = g.out(route.id).find((x) => x.type === "handles");
      return { ...describe(route), handler: handler ? describe(g.nodes.get(handler.target)) : null };
    });
  const unmatchedRequests = (graph.requests || []).filter((r) => r.file === filePath && !r.route);

  const modelsDefined = g.out(fid).filter((e) => e.type === "defines" && e.target.startsWith("model:")).map((e) => describe(g.nodes.get(e.target)));
  const modelsUsed = [...new Set(sources.flatMap((id) => g.out(id).filter((e) => e.type === "uses-model").map((e) => e.target)))]
    .map((id) => describe(g.nodes.get(id)));
  const modelUsers = modelsDefined.flatMap((m) =>
    g.inc(m.id).filter((e) => e.type === "uses-model").map((e) => describe(g.nodes.get(e.source)))
  );

  const dependents = transitive.size;
  const risk = dependents >= 8 || routesDefined.length >= 4 ? "high" : dependents >= 3 || routesDefined.length ? "medium" : "low";

  const insights = graph.insights || {};
  const notes = [];
  (insights.cycles || []).filter((c) => c.includes(filePath)).forEach((c) => notes.push({ type: "cycle", files: c }));
  (insights.brokenImports || []).filter((b) => b.path === filePath).forEach((b) => notes.push({ type: "broken-import", ...b }));
  (insights.largeFunctions || []).filter((f) => f.path === filePath).forEach((f) => notes.push({ type: "large-function", ...f }));
  (insights.unusedExports || []).filter((u) => u.path === filePath).forEach((u) => notes.push({ type: "unused-export", ...u }));

  return {
    path: filePath,
    risk,
    summary: { directImporters: directImporters.length, transitiveDependents: dependents, functions: functions.length, routes: routesDefined.length },
    importsFiles,
    importsPackages,
    directImporters,
    transitiveDependents: [...transitive.entries()].map(([path, depth]) => ({ path, depth })).sort((a, b) => a.depth - b.depth),
    functions,
    routesDefined,
    requestsMade,
    unmatchedRequests,
    modelsDefined,
    modelsUsed,
    modelUsers,
    notes,
  };
}

module.exports = { computeImpact, indexGraph };
