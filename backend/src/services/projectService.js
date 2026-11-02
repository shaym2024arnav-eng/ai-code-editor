// Shared project operations used by several routes.
const { buildGraph } = require("../analysis/buildGraph");
const { HttpError, notFound } = require("../middleware/errors");

async function createProjectFromFiles({ store, config, ownerId, name, source, files }) {
  const count = await store.countProjects(ownerId);
  if (count >= config.limits.maxProjectsPerClient) {
    throw new HttpError(409, `You can keep up to ${config.limits.maxProjectsPerClient} projects. Delete one first.`);
  }
  const { graph, stats } = buildGraph(files);
  return store.createProject({ ownerId, name, source, files, graph, stats });
}

async function reanalyze(store, projectId) {
  const files = await store.getAllFiles(projectId);
  const { graph, stats } = buildGraph(files);
  await store.updateGraph(projectId, graph, stats);
  return { graph, stats };
}

async function loadOwnedProject(store, req, { includeGraph = false } = {}) {
  const project = await store.getProject(req.clientId, req.params.projectId, { includeGraph });
  if (!project) throw notFound("Project");
  return project;
}

module.exports = { createProjectFromFiles, reanalyze, loadOwnedProject };
