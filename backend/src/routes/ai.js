// AI features: goal-based improvements (review, accept, reject) and questions about the code.
const express = require("express");
const { HttpError, badRequest, notFound } = require("../middleware/errors");
const { requireString, optionalString, requirePath, parseSelection, parseScope } = require("../middleware/validate");
const { loadOwnedProject, reanalyze } = require("../services/projectService");
const { isGoal } = require("../ai/goals");
const { buildImproveContext } = require("../ai/context");
const { buildImprovePrompt, buildAskPrompt } = require("../ai/prompts");
const { checkImprovement, cleanCode } = require("../ai/checks");
const { requireAi } = require("./aiGuard");

const asArray = (v) => (Array.isArray(v) ? v : []);
const text = (v, max = 4000) => (typeof v === "string" ? v.slice(0, max) : "");

// Keep only the fields we expect from the model, with sane types.
function sanitizeResult(raw, refs, decisions) {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  return {
    summary: text(raw.summary, 2000),
    riskLevel: ["low", "medium", "high"].includes(raw.riskLevel) ? raw.riskLevel : "medium",
    changes: asArray(raw.changes).slice(0, 30).map((c) => ({
      title: text(c && c.title, 200),
      explanation: text(c && c.explanation, 2000),
      category: text(c && c.category, 40) || "other",
      lineHint: text(c && c.lineHint, 40) || undefined,
    })).filter((c) => c.title),
    impactNotes: asArray(raw.impactNotes).filter((n) => typeof n === "string").slice(0, 20).map((n) => n.slice(0, 500)),
    decisionChecks: asArray(raw.decisionChecks)
      .filter((d) => d && refs.has(d.ref))
      .map((d) => {
        const decision = byId.get(refs.get(d.ref));
        return {
          decisionId: refs.get(d.ref),
          title: decision ? decision.title : "",
          status: ["respected", "conflict", "not-applicable"].includes(d.status) ? d.status : "not-applicable",
          note: text(d.note, 500),
        };
      }),
    suggestedDecision:
      raw.suggestedDecision && raw.suggestedDecision.shouldRecord && raw.suggestedDecision.title && raw.suggestedDecision.decision
        ? {
            title: text(raw.suggestedDecision.title, 160),
            decision: text(raw.suggestedDecision.decision),
            rationale: text(raw.suggestedDecision.rationale),
          }
        : null,
  };
}

function aiRouter({ store, ai, config, limiters }) {
  const router = express.Router({ mergeParams: true });
  const { limits } = config;

  router.post("/improve", limiters.ai, async (req, res) => {
    requireAi(ai);
    const project = await loadOwnedProject(store, req, { includeGraph: true });
    const path = requirePath(req.body.path);
    const goal = requireString(req.body.goal, "goal", { max: 40 });
    if (!isGoal(goal)) throw badRequest(`Unknown goal "${goal}".`);
    const instructions = optionalString(req.body.instructions, "instructions", { max: limits.maxInstructionsChars });
    if (goal === "custom" && !instructions) throw badRequest("Describe your custom goal in the instructions.");

    const file = await store.getFile(project.id, path);
    if (!file) throw notFound("File");
    if (file.size > limits.maxImproveFileBytes) {
      throw new HttpError(413, "This file is too large to improve in one go. Select a section and improve that instead.");
    }
    const selection = parseSelection(req.body.selection, file.content.split("\n").length);

    const decisions = await store.listDecisions(project.id);
    const context = await buildImproveContext({ store, projectId: project.id, graph: project.graph, filePath: path, decisions });
    const { system, prompt, schema, refs } = buildImprovePrompt({
      filePath: path, code: file.content, goal, instructions, selection, context,
    });

    const raw = await ai.generateJson({ system, prompt, schema });
    const updatedCode = cleanCode(raw.updatedCode);
    if (!updatedCode) throw new HttpError(502, "The AI did not return updated code. Try again.");

    const result = sanitizeResult(raw, refs, context.decisions);
    const checks = await checkImprovement({
      filePath: path,
      originalCode: file.content,
      updatedCode,
      loadAllFiles: () => store.getAllFiles(project.id),
    });

    const improvement = await store.createImprovement(project.id, {
      path, goal, instructions, selection,
      originalHash: file.hash,
      originalCode: file.content,
      updatedCode,
      result,
      checks,
      model: ai.model,
    });
    res.status(201).json({ improvement, usedDecisions: context.decisions.map((d) => ({ id: d.id, title: d.title })) });
  });

  router.get("/improvements", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    res.json({ improvements: await store.listImprovements(project.id) });
  });

  router.get("/improvements/:improvementId", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const improvement = await store.getImprovement(project.id, req.params.improvementId);
    if (!improvement) throw notFound("Improvement");
    res.json({ improvement });
  });

  router.post("/improvements/:improvementId/accept", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const improvement = await store.getImprovement(project.id, req.params.improvementId);
    if (!improvement) throw notFound("Improvement");
    if (improvement.status !== "pending") throw new HttpError(409, `This suggestion was already ${improvement.status}.`);

    const current = await store.getFile(project.id, improvement.path);
    if (!current) throw notFound("File");
    if (current.hash !== improvement.originalHash) {
      throw new HttpError(409, "The file changed after this suggestion was made. Ask for a new suggestion.");
    }

    // The user may have edited the suggestion in the diff view before accepting.
    const code = typeof req.body.updatedCode === "string" ? req.body.updatedCode : improvement.updatedCode;
    if (Buffer.byteLength(code, "utf8") > limits.maxFileBytes) throw badRequest("The updated file is too large.");

    // Validate the optional decision before changing anything.
    let decisionData = null;
    if (req.body.decision) {
      const d = req.body.decision;
      decisionData = {
        title: requireString(d.title, "decision.title", { max: 160 }),
        decision: requireString(d.decision, "decision.decision", { max: 4000 }),
        rationale: optionalString(d.rationale, "decision.rationale", { max: 4000 }) || "",
        scope: parseScope(d.scope),
        origin: "ai",
      };
    }

    const file = await store.saveFile(project.id, improvement.path, code);
    const { stats } = await reanalyze(store, project.id);
    const updated = await store.updateImprovement(project.id, improvement.id, {
      status: "accepted",
      updatedCode: code,
    });
    const decision = decisionData ? await store.createDecision(project.id, decisionData) : null;

    const { originalCode, updatedCode, ...summary } = updated;
    res.json({ improvement: summary, file, stats, decision });
  });

  router.post("/improvements/:improvementId/reject", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const improvement = await store.getImprovement(project.id, req.params.improvementId);
    if (!improvement) throw notFound("Improvement");
    if (improvement.status !== "pending") throw new HttpError(409, `This suggestion was already ${improvement.status}.`);
    const updated = await store.updateImprovement(project.id, improvement.id, { status: "rejected" });
    const { originalCode, updatedCode, ...summary } = updated;
    res.json({ improvement: summary });
  });

  router.post("/ask", limiters.ai, async (req, res) => {
    requireAi(ai);
    const project = await loadOwnedProject(store, req, { includeGraph: true });
    const question = requireString(req.body.question, "question", { max: limits.maxQuestionChars });
    let file = null;
    if (req.body.path) {
      file = await store.getFile(project.id, requirePath(req.body.path));
      if (!file) throw notFound("File");
    }
    const decisions = await store.listDecisions(project.id);
    const { system, prompt } = buildAskPrompt({ question, graph: project.graph, decisions, file });
    const answer = await ai.generateText({ system, prompt });
    res.json({ answer });
  });

  return router;
}

module.exports = { aiRouter, sanitizeResult };
