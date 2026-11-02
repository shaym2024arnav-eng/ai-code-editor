// Architecture memory: decisions the AI must respect in future suggestions.
const express = require("express");
const { badRequest, notFound } = require("../middleware/errors");
const { requireString, optionalString, parseScope } = require("../middleware/validate");
const { loadOwnedProject } = require("../services/projectService");
const { buildSuggestDecisionsPrompt } = require("../ai/prompts");
const { requireAi } = require("./aiGuard");

function decisionsRouter({ store, ai, limiters }) {
  const router = express.Router({ mergeParams: true });

  router.get("/", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    res.json({ decisions: await store.listDecisions(project.id) });
  });

  router.post("/", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const existing = await store.listDecisions(project.id);
    if (existing.length >= 100) throw badRequest("A project can have at most 100 decisions.");
    const decision = await store.createDecision(project.id, {
      title: requireString(req.body.title, "title", { max: 160 }),
      decision: requireString(req.body.decision, "decision", { max: 4000 }),
      rationale: optionalString(req.body.rationale, "rationale", { max: 4000 }) || "",
      scope: parseScope(req.body.scope),
      origin: req.body.origin === "ai" ? "ai" : "manual",
    });
    res.status(201).json({ decision });
  });

  router.patch("/:decisionId", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const patch = {};
    if (req.body.title !== undefined) patch.title = requireString(req.body.title, "title", { max: 160 });
    if (req.body.decision !== undefined) patch.decision = requireString(req.body.decision, "decision", { max: 4000 });
    if (req.body.rationale !== undefined) patch.rationale = optionalString(req.body.rationale, "rationale", { max: 4000 }) || "";
    if (req.body.scope !== undefined) patch.scope = parseScope(req.body.scope);
    if (req.body.status !== undefined) {
      if (!["active", "superseded"].includes(req.body.status)) throw badRequest('"status" must be "active" or "superseded".');
      patch.status = req.body.status;
    }
    if (Object.keys(patch).length === 0) throw badRequest("Nothing to update.");
    const decision = await store.updateDecision(project.id, req.params.decisionId, patch);
    if (!decision) throw notFound("Decision");
    res.json({ decision });
  });

  router.delete("/:decisionId", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const ok = await store.deleteDecision(project.id, req.params.decisionId);
    if (!ok) throw notFound("Decision");
    res.status(204).end();
  });

  // AI proposes decisions from the code map. Nothing is saved until the user adds them.
  router.post("/suggest", limiters.ai, async (req, res) => {
    requireAi(ai);
    const project = await loadOwnedProject(store, req, { includeGraph: true });
    const existing = (await store.listDecisions(project.id)).filter((d) => d.status === "active");
    const { system, prompt, schema } = buildSuggestDecisionsPrompt({ graph: project.graph, existing });
    const result = await ai.generateJson({ system, prompt, schema, temperature: 0.3 });
    const suggestions = (Array.isArray(result.decisions) ? result.decisions : [])
      .filter((d) => d && d.title && d.decision)
      .slice(0, 6)
      .map((d) => ({
        title: String(d.title).slice(0, 160),
        decision: String(d.decision).slice(0, 4000),
        rationale: String(d.rationale || "").slice(0, 4000),
        scope: Array.isArray(d.scope) ? d.scope.filter((s) => typeof s === "string").slice(0, 10) : [],
      }));
    res.json({ suggestions });
  });

  return router;
}

module.exports = { decisionsRouter };
