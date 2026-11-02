const express = require("express");
const cors = require("cors");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { requireClientId } = require("./middleware/clientId");
const { errorHandler, notFound } = require("./middleware/errors");
const { projectsRouter } = require("./routes/projects");
const { decisionsRouter } = require("./routes/decisions");
const { aiRouter } = require("./routes/ai");
const { GOALS } = require("./ai/goals");

const passThrough = (req, res, next) => next();

function makeLimiters(enabled) {
  if (!enabled) return { general: passThrough, ai: passThrough, ingest: passThrough };
  const byClient = (req) => `${req.get("x-client-id") || "anon"}|${ipKeyGenerator(req.ip || "")}`;
  const common = { standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: byClient };
  return {
    general: rateLimit({ ...common, windowMs: 15 * 60 * 1000, limit: 600 }),
    // AI calls cost money and quota, so they get a much lower limit.
    ai: rateLimit({ ...common, windowMs: 10 * 60 * 1000, limit: 25, message: { message: "Too many AI requests. Wait a few minutes." } }),
    ingest: rateLimit({ ...common, windowMs: 60 * 60 * 1000, limit: 20, message: { message: "Too many uploads. Try again later." } }),
  };
}

function createApp({ store, ai, config, rateLimits = true }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render, Railway etc. sit behind one proxy

  app.use(
    cors({
      origin: config.corsOrigins.length
        ? (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin))
        : true,
      exposedHeaders: ["Content-Disposition"],
    })
  );
  app.use(express.json({ limit: "1mb" }));

  const limiters = makeLimiters(rateLimits);

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, storage: store.kind, ai: ai ? { enabled: true, model: ai.model } : { enabled: false } });
  });

  app.get("/api/goals", (req, res) => {
    res.json({ goals: Object.entries(GOALS).map(([id, g]) => ({ id, label: g.label, focus: g.focus })) });
  });

  app.use("/api/projects", limiters.general, requireClientId);
  app.use("/api/projects", projectsRouter({ store, config, limiters }));
  app.use("/api/projects/:projectId/decisions", decisionsRouter({ store, ai, limiters }));
  app.use("/api/projects/:projectId", aiRouter({ store, ai, config, limiters }));

  app.use("/api", (req, res, next) => next(notFound("API route")));
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
