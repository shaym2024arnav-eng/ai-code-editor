const { GOALS } = require("./goals");
const { formatDecisions, formatImpact, truncate } = require("./context");

const IMPROVE_SYSTEM = `You are a senior software engineer reviewing and improving one file inside a larger project.
Rules:
- Optimize for the user's goal. Make focused, meaningful changes; do not rewrite code just to restyle it.
- Preserve behavior unless the goal is fixing bugs or security problems, and say clearly when behavior changes.
- Keep exported names and function signatures stable. Other files depend on them (see "Connections").
  If a change to an export is truly necessary, list every affected file in impactNotes.
- Respect the architecture decisions. Never violate one silently: if the goal conflicts with a decision,
  keep the decision and report the conflict in decisionChecks.
- Follow the file's existing style, language and module system (ESM vs CommonJS).
- Return the COMPLETE updated file in updatedCode, as plain code with no markdown fences.
- If the file is already good for this goal, return it unchanged, set changes to [] and say so in the summary.
- suggestedDecision: set shouldRecord to true only if your change establishes a reusable project rule worth
  remembering (for example "All API handlers validate input with a shared helper").`;

const IMPROVE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2-4 sentences on what was changed and why." },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          explanation: { type: "string" },
          category: { type: "string", enum: ["performance", "readability", "security", "maintainability", "bug-fix", "types", "other"] },
          lineHint: { type: "string", description: "Approximate original line numbers, e.g. '12-20'." },
        },
        required: ["title", "explanation", "category"],
      },
    },
    updatedCode: { type: "string" },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    impactNotes: { type: "array", items: { type: "string" } },
    decisionChecks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Decision reference such as D1." },
          status: { type: "string", enum: ["respected", "conflict", "not-applicable"] },
          note: { type: "string" },
        },
        required: ["ref", "status"],
      },
    },
    suggestedDecision: {
      type: "object",
      properties: {
        shouldRecord: { type: "boolean" },
        title: { type: "string" },
        decision: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["shouldRecord"],
    },
  },
  required: ["summary", "changes", "updatedCode", "riskLevel"],
};

function buildImprovePrompt({ filePath, code, goal, instructions, selection, context }) {
  const g = GOALS[goal];
  const { text: decisionsText, refs } = formatDecisions(context.decisions);

  let selectionText = "";
  if (selection) {
    const lines = code.split("\n").slice(selection.startLine - 1, selection.endLine).join("\n");
    selectionText = `\n## Focus\nOnly change lines ${selection.startLine}-${selection.endLine} (shown below). Leave the rest of the file exactly as it is, but still return the whole file.\n\`\`\`\n${lines}\n\`\`\`\n`;
  }

  const neighbours = context.neighbours.length
    ? context.neighbours.map((n) => `### ${n.path} (${n.relation})\n\`\`\`\n${n.content}\n\`\`\``).join("\n\n")
    : "None.";

  const prompt = `## Goal: ${g.label}
${g.focus}
${instructions ? `\n## Extra instructions from the user\n${instructions}\n` : ""}
## Architecture decisions to respect
${decisionsText}

## Connections (from the project's code map)
${formatImpact(context.impact)}
${selectionText}
## Target file: ${filePath}
\`\`\`
${code}
\`\`\`

## Related files (read-only context)
${neighbours}`;

  return { system: IMPROVE_SYSTEM, prompt, schema: IMPROVE_SCHEMA, refs };
}

// A compact, one-line-per-file overview of the project for questions and decision suggestions.
function projectOverview(graph, maxChars = 60000) {
  const byFile = new Map();
  for (const n of graph.nodes) {
    if (n.type === "file" && n.lines !== null) byFile.set(n.path, { fns: [], routes: [], models: [] });
  }
  for (const n of graph.nodes) {
    if (n.type === "function" && byFile.has(n.path)) byFile.get(n.path).fns.push(n.exported ? `${n.name}*` : n.name);
    if (n.type === "route" && byFile.has(n.file)) byFile.get(n.file).routes.push(`${n.method} ${n.path}`);
    if (n.type === "model" && byFile.has(n.path)) byFile.get(n.path).models.push(n.name);
  }
  const imports = new Map();
  for (const e of graph.edges) {
    if (e.type === "imports" && e.target.startsWith("file:")) {
      const s = e.source.slice(5);
      if (!imports.has(s)) imports.set(s, []);
      imports.get(s).push(e.target.slice(5));
    }
  }
  const lines = [...byFile.entries()].map(([p, info]) => {
    const parts = [p];
    if (info.fns.length) parts.push(`functions: ${info.fns.slice(0, 15).join(", ")}`);
    if (info.routes.length) parts.push(`routes: ${info.routes.join(", ")}`);
    if (info.models.length) parts.push(`models: ${info.models.join(", ")}`);
    if (imports.get(p)) parts.push(`imports: ${imports.get(p).slice(0, 10).join(", ")}`);
    return `- ${parts.join(" | ")}`;
  });
  const packages = graph.nodes.filter((n) => n.type === "package" && !n.builtin).map((n) => n.name);
  return truncate(`Files (* = exported):\n${lines.join("\n")}\n\nPackages: ${packages.join(", ") || "none"}`, maxChars);
}

const ASK_SYSTEM = `You are an expert engineer who knows this codebase through its code map.
Answer the question accurately and concisely, using the overview, the architecture decisions and the open file.
Refer to files by path and functions by name. If the information isn't available, say what you'd need to check.
Use short paragraphs and bullet lists in Markdown. Keep code snippets short.`;

function buildAskPrompt({ question, graph, decisions, file }) {
  const { text } = formatDecisions(decisions.filter((d) => d.status === "active"));
  return {
    system: ASK_SYSTEM,
    prompt: `## Project overview
${projectOverview(graph)}

## Architecture decisions
${text}
${file ? `\n## Open file: ${file.path}\n\`\`\`\n${truncate(file.content, 30000)}\n\`\`\`\n` : ""}
## Question
${question}`,
  };
}

const SUGGEST_SYSTEM = `You are a software architect documenting an existing codebase.
From the code map, identify the 3-6 most important architecture decisions and conventions this project
already follows (or clearly should follow), the kind a new team member must know before changing code.
Be specific to THIS project: name folders, libraries and patterns you can actually see. Do not invent facts.`;

const SUGGEST_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          decision: { type: "string" },
          rationale: { type: "string" },
          scope: { type: "array", items: { type: "string" }, description: "Folder prefixes or globs; empty for project-wide." },
        },
        required: ["title", "decision", "rationale"],
      },
    },
  },
  required: ["decisions"],
};

function buildSuggestDecisionsPrompt({ graph, existing }) {
  const { text } = formatDecisions(existing);
  return {
    system: SUGGEST_SYSTEM,
    schema: SUGGEST_SCHEMA,
    prompt: `## Project overview\n${projectOverview(graph)}\n\n## Decisions already recorded (do not repeat these)\n${text}`,
  };
}

module.exports = { buildImprovePrompt, buildAskPrompt, buildSuggestDecisionsPrompt, projectOverview, IMPROVE_SCHEMA };
