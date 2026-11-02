// Builds the context the model sees: the target file, its neighbours in the
// code map, who depends on it, and the architecture decisions that apply.
const { computeImpact } = require("../analysis/impact");

const NEIGHBOUR_CHARS = 6000;
const NEIGHBOURS_BUDGET = 36000;

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// A decision applies to a file if it has no scope (project-wide) or one of its
// scopes matches: an exact path, a folder prefix ("src/api/") or a glob ("**/*.jsx").
function decisionApplies(decision, filePath) {
  if (decision.status && decision.status !== "active") return false;
  const scope = decision.scope || [];
  if (scope.length === 0) return true;
  return scope.some((s) => {
    if (s.includes("*")) return globToRegex(s).test(filePath);
    if (s === filePath) return true;
    const folder = s.endsWith("/") ? s : `${s}/`;
    return filePath.startsWith(folder);
  });
}

const truncate = (text, max) => (text.length <= max ? text : `${text.slice(0, max)}\n/* ... truncated ... */`);

async function buildImproveContext({ store, projectId, graph, filePath, decisions }) {
  const impact = graph ? computeImpact(graph, filePath) : null;
  const applicable = decisions.filter((d) => decisionApplies(d, filePath));

  // Direct imports first (the model needs their APIs), then direct importers.
  const neighbourPaths = impact ? [...new Set([...impact.importsFiles, ...impact.directImporters])] : [];
  const neighbours = [];
  let used = 0;
  for (const p of neighbourPaths) {
    if (used >= NEIGHBOURS_BUDGET) break;
    const file = await store.getFile(projectId, p);
    if (!file) continue;
    const content = truncate(file.content, Math.min(NEIGHBOUR_CHARS, NEIGHBOURS_BUDGET - used));
    used += content.length;
    neighbours.push({ path: p, relation: impact.importsFiles.includes(p) ? "imported by the target" : "imports the target", content });
  }

  return { impact, decisions: applicable, neighbours };
}

function formatDecisions(decisions) {
  if (!decisions.length) return { text: "None recorded.", refs: new Map() };
  const refs = new Map();
  const lines = decisions.map((d, i) => {
    const ref = `D${i + 1}`;
    refs.set(ref, d.id);
    const scope = d.scope && d.scope.length ? ` (applies to: ${d.scope.join(", ")})` : " (project-wide)";
    return `[${ref}] ${d.title}${scope}\n  Decision: ${d.decision}${d.rationale ? `\n  Why: ${d.rationale}` : ""}`;
  });
  return { text: lines.join("\n"), refs };
}

function formatImpact(impact) {
  if (!impact) return "No code map available for this file.";
  const lines = [];
  lines.push(`Risk if changed: ${impact.risk}. Files depending on it (directly or indirectly): ${impact.summary.transitiveDependents}.`);
  if (impact.directImporters.length) lines.push(`Imported by: ${impact.directImporters.join(", ")}`);
  if (impact.importsPackages.length) lines.push(`Packages used: ${impact.importsPackages.join(", ")}`);
  impact.functions.filter((f) => f.externalCallers.length).forEach((f) => {
    const callers = f.externalCallers.map((c) => (c.type === "route" ? `${c.method} ${c.path}` : `${c.path}:${c.name || ""}`)).join(", ");
    lines.push(`${f.name}() is used by: ${callers}`);
  });
  impact.routesDefined.forEach((r) => {
    const clients = r.clients.length ? ` - called from ${r.clients.map((c) => c.path + (c.name ? `:${c.name}` : "")).join(", ")}` : "";
    lines.push(`Defines route ${r.method} ${r.path}${clients}`);
  });
  impact.requestsMade.forEach((r) => lines.push(`Calls backend route ${r.method} ${r.path}`));
  if (impact.modelsUsed.length) lines.push(`Data models used: ${impact.modelsUsed.map((m) => m.name).join(", ")}`);
  return lines.join("\n");
}

module.exports = { buildImproveContext, decisionApplies, formatDecisions, formatImpact, truncate };
