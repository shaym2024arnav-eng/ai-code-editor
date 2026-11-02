// In-memory implementation of the store. Used by the tests and for running
// locally without MongoDB (STORAGE=memory). Data disappears when the server stops.
const crypto = require("crypto");
const { hashContent } = require("./hash");

const clone = (v) => (v === undefined ? v : structuredClone(v));
const now = () => new Date().toISOString();

function createMemoryStore() {
  const projects = new Map(); // id -> project
  const files = new Map(); // projectId -> Map(path -> file)
  const decisions = new Map(); // projectId -> Map(id -> decision)
  const improvements = new Map(); // projectId -> Map(id -> improvement)

  const summary = (p) => ({
    id: p.id,
    name: p.name,
    source: p.source,
    stats: p.stats,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });

  const fileRecord = (path, content) => ({
    path,
    content,
    size: Buffer.byteLength(content, "utf8"),
    hash: hashContent(content),
  });

  return {
    kind: "memory",

    async createProject({ ownerId, name, source, files: fileList, graph, stats }) {
      const id = crypto.randomUUID();
      const t = now();
      projects.set(id, { id, ownerId, name, source, graph, stats, createdAt: t, updatedAt: t });
      files.set(id, new Map(fileList.map((f) => [f.path, fileRecord(f.path, f.content)])));
      decisions.set(id, new Map());
      improvements.set(id, new Map());
      return clone(summary(projects.get(id)));
    },

    async countProjects(ownerId) {
      return [...projects.values()].filter((p) => p.ownerId === ownerId).length;
    },

    async listProjects(ownerId) {
      return [...projects.values()]
        .filter((p) => p.ownerId === ownerId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((p) => clone(summary(p)));
    },

    async getProject(ownerId, id, { includeGraph = false } = {}) {
      const p = projects.get(id);
      if (!p || p.ownerId !== ownerId) return null;
      return clone(includeGraph ? { ...summary(p), graph: p.graph } : summary(p));
    },

    async deleteProject(ownerId, id) {
      const p = projects.get(id);
      if (!p || p.ownerId !== ownerId) return false;
      projects.delete(id);
      files.delete(id);
      decisions.delete(id);
      improvements.delete(id);
      return true;
    },

    async updateGraph(projectId, graph, stats) {
      const p = projects.get(projectId);
      if (!p) return;
      p.graph = graph;
      p.stats = stats;
      p.updatedAt = now();
    },

    async listFiles(projectId) {
      return [...(files.get(projectId)?.values() || [])]
        .map(({ path, size }) => ({ path, size }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },

    async getAllFiles(projectId) {
      return [...(files.get(projectId)?.values() || [])].map(({ path, content }) => ({ path, content }));
    },

    async getFile(projectId, path) {
      return clone(files.get(projectId)?.get(path) || null);
    },

    async saveFile(projectId, path, content) {
      const map = files.get(projectId);
      if (!map) return null;
      const record = fileRecord(path, content);
      map.set(path, record);
      return clone(record);
    },

    async listDecisions(projectId) {
      return [...(decisions.get(projectId)?.values() || [])]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone);
    },

    async createDecision(projectId, data) {
      const d = { id: crypto.randomUUID(), status: "active", scope: [], ...data, createdAt: now(), updatedAt: now() };
      decisions.get(projectId).set(d.id, d);
      return clone(d);
    },

    async updateDecision(projectId, id, patch) {
      const d = decisions.get(projectId)?.get(id);
      if (!d) return null;
      Object.assign(d, patch, { updatedAt: now() });
      return clone(d);
    },

    async deleteDecision(projectId, id) {
      return decisions.get(projectId)?.delete(id) || false;
    },

    async createImprovement(projectId, data) {
      const imp = { id: crypto.randomUUID(), status: "pending", ...data, createdAt: now(), updatedAt: now() };
      improvements.get(projectId).set(imp.id, imp);
      return clone(imp);
    },

    async getImprovement(projectId, id) {
      return clone(improvements.get(projectId)?.get(id) || null);
    },

    async updateImprovement(projectId, id, patch) {
      const imp = improvements.get(projectId)?.get(id);
      if (!imp) return null;
      Object.assign(imp, patch, { updatedAt: now() });
      return clone(imp);
    },

    async listImprovements(projectId, { limit = 50 } = {}) {
      return [...(improvements.get(projectId)?.values() || [])]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(({ originalCode, updatedCode, ...rest }) => clone(rest));
    },

    async close() {},
  };
}

module.exports = { createMemoryStore };
