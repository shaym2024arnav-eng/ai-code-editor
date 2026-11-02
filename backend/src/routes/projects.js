// Projects: create (zip, folder, GitHub), list, read files, save, code map, impact, export.
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { filesFromZip } = require("../ingest/zip");
const { filesFromGithub } = require("../ingest/github");
const { collectFiles } = require("../ingest/filters");
const { computeImpact } = require("../analysis/impact");
const { badRequest, notFound } = require("../middleware/errors");
const { requireString, optionalString, requirePath } = require("../middleware/validate");
const { createProjectFromFiles, reanalyze, loadOwnedProject } = require("../services/projectService");

const cleanName = (value, fallback) =>
  (optionalString(value, "name", { max: 120 }) || fallback || "Untitled project").replace(/\.zip$/i, "").slice(0, 120);

function projectsRouter({ store, config, limiters }) {
  const router = express.Router();
  const { limits } = config;

  const zipUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limits.maxZipBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = /\.zip$/i.test(file.originalname) || /zip/.test(file.mimetype);
      cb(ok ? null : badRequest("Please upload a .zip file."), ok);
    },
  });

  // The browser filters out node_modules etc. before uploading, so the per-file
  // limit here is a backstop; oversized files are skipped by collectFiles.
  const folderUpload = multer({
    storage: multer.memoryStorage(),
    preservePath: true,
    defParamCharset: "utf8",
    limits: { fileSize: 2 * 1024 * 1024, files: 2000, fieldSize: 1024 * 1024 },
  });

  const respondCreated = (res, project, skipped) => res.status(201).json({ project, skipped });

  router.post("/zip", limiters.ingest, zipUpload.single("archive"), async (req, res) => {
    if (!req.file) throw badRequest('Attach a zip file in the "archive" field.');
    const { files, skipped } = filesFromZip(req.file.buffer, limits);
    const project = await createProjectFromFiles({
      store, config, ownerId: req.clientId, files,
      name: cleanName(req.body.name, req.file.originalname),
      source: { type: "zip" },
    });
    respondCreated(res, project, skipped);
  });

  router.post("/folder", limiters.ingest, folderUpload.array("files"), async (req, res) => {
    if (!req.files || req.files.length === 0) throw badRequest("Choose a folder with at least one file.");
    // Relative paths come in a "paths" JSON field (same order as the files),
    // because some clients strip folders from upload filenames.
    let paths = null;
    if (req.body.paths) {
      try { paths = JSON.parse(req.body.paths); } catch { throw badRequest('"paths" must be a JSON array.'); }
      if (!Array.isArray(paths) || paths.length !== req.files.length || !paths.every((p) => typeof p === "string")) {
        throw badRequest('"paths" must list one path per uploaded file.');
      }
    }
    const pathOf = (f, i) => (paths ? paths[i] : f.originalname).replace(/\\/g, "/");
    const rootName = pathOf(req.files[0], 0).split("/")[0];
    const { files, skipped } = collectFiles(
      req.files.map((f, i) => ({ path: pathOf(f, i), size: f.size, read: () => f.buffer })),
      limits
    );
    const project = await createProjectFromFiles({
      store, config, ownerId: req.clientId, files,
      name: cleanName(req.body.name, rootName),
      source: { type: "folder" },
    });
    respondCreated(res, project, skipped);
  });

  router.post("/github", limiters.ingest, async (req, res) => {
    const url = requireString(req.body.url, "url", { max: 300 });
    const { files, skipped, source, defaultName } = await filesFromGithub(url, {
      limits, token: config.githubToken, fetchImpl: config.fetchImpl,
    });
    const project = await createProjectFromFiles({
      store, config, ownerId: req.clientId, files, source,
      name: cleanName(req.body.name, defaultName),
    });
    respondCreated(res, project, skipped);
  });

  router.get("/", async (req, res) => {
    res.json({ projects: await store.listProjects(req.clientId) });
  });

  router.get("/:projectId", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    res.json({ project, files: await store.listFiles(project.id) });
  });

  router.delete("/:projectId", async (req, res) => {
    const ok = await store.deleteProject(req.clientId, req.params.projectId);
    if (!ok) throw notFound("Project");
    res.status(204).end();
  });

  router.get("/:projectId/graph", async (req, res) => {
    const project = await loadOwnedProject(store, req, { includeGraph: true });
    res.json({ graph: project.graph, stats: project.stats });
  });

  router.get("/:projectId/file", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const file = await store.getFile(project.id, requirePath(req.query.path));
    if (!file) throw notFound("File");
    res.json({ file });
  });

  router.put("/:projectId/file", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const path = requirePath(req.body.path);
    const { content, baseHash } = req.body;
    if (typeof content !== "string") throw badRequest('"content" is required.');
    if (Buffer.byteLength(content, "utf8") > limits.maxFileBytes) throw badRequest("File is too large to save.");

    const existing = await store.getFile(project.id, path);
    if (!existing) throw notFound("File");
    // Optimistic locking: refuse to overwrite a version the client hasn't seen.
    if (baseHash && baseHash !== existing.hash) {
      return res.status(409).json({ message: "This file changed since you opened it. Reload it and try again.", file: existing });
    }
    const file = await store.saveFile(project.id, path, content);
    const { stats } = await reanalyze(store, project.id);
    res.json({ file, stats });
  });

  router.get("/:projectId/impact", async (req, res) => {
    const project = await loadOwnedProject(store, req, { includeGraph: true });
    const path = requirePath(req.query.path);
    const impact = project.graph ? computeImpact(project.graph, path) : null;
    if (!impact) throw notFound("File in the code map (only JS/TS files are analyzed)");
    res.json({ impact });
  });

  router.get("/:projectId/export", async (req, res) => {
    const project = await loadOwnedProject(store, req);
    const zip = new AdmZip();
    for (const f of await store.getAllFiles(project.id)) zip.addFile(f.path, Buffer.from(f.content, "utf8"));
    const safeName = project.name.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="${safeName}.zip"`);
    res.send(zip.toBuffer());
  });

  return router;
}

module.exports = { projectsRouter };
