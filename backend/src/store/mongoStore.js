// MongoDB implementation of the store (same interface as memoryStore.js).
const mongoose = require("mongoose");
const { hashContent } = require("./hash");

const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const projectSchema = new Schema(
  {
    ownerId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    source: {
      type: { type: String, enum: ["zip", "folder", "github"], required: true },
      url: String,
      ref: String,
    },
    stats: { type: Schema.Types.Mixed, default: {} },
    graph: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, minimize: false }
);

const fileSchema = new Schema({
  project: { type: ObjectId, ref: "Project", required: true },
  path: { type: String, required: true },
  content: { type: String, default: "" },
  size: { type: Number, default: 0 },
  hash: { type: String, required: true },
});
fileSchema.index({ project: 1, path: 1 }, { unique: true });

const decisionSchema = new Schema(
  {
    project: { type: ObjectId, ref: "Project", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    decision: { type: String, required: true, maxlength: 4000 },
    rationale: { type: String, default: "", maxlength: 4000 },
    scope: { type: [String], default: [] },
    status: { type: String, enum: ["active", "superseded"], default: "active" },
    origin: { type: String, enum: ["manual", "ai"], default: "manual" },
  },
  { timestamps: true }
);

const improvementSchema = new Schema(
  {
    project: { type: ObjectId, ref: "Project", required: true, index: true },
    path: { type: String, required: true },
    goal: { type: String, required: true },
    instructions: String,
    selection: Schema.Types.Mixed,
    status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    originalHash: String,
    originalCode: String,
    updatedCode: String,
    result: Schema.Types.Mixed,
    checks: Schema.Types.Mixed,
    model: String,
  },
  { timestamps: true, minimize: false }
);

const Project = mongoose.models.Project || mongoose.model("Project", projectSchema);
const File = mongoose.models.File || mongoose.model("File", fileSchema);
const Decision = mongoose.models.Decision || mongoose.model("Decision", decisionSchema);
const Improvement = mongoose.models.Improvement || mongoose.model("Improvement", improvementSchema);

const iso = (d) => (d instanceof Date ? d.toISOString() : d);
const valid = (id) => mongoose.isValidObjectId(id);

// Turn a lean Mongo document into a plain API object: _id -> id, dates -> ISO strings.
function plain(doc) {
  if (!doc) return null;
  const { _id, __v, project, ...rest } = doc;
  const out = { id: String(_id), ...rest };
  if (out.createdAt) out.createdAt = iso(out.createdAt);
  if (out.updatedAt) out.updatedAt = iso(out.updatedAt);
  return out;
}

const projectSummary = (p) => {
  const { graph, ownerId, ...rest } = plain(p);
  return rest;
};

async function createMongoStore(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  await Promise.all([Project.init(), File.init(), Decision.init(), Improvement.init()]);

  return {
    kind: "mongo",

    async createProject({ ownerId, name, source, files, graph, stats }) {
      const project = await Project.create({ ownerId, name, source, graph, stats });
      try {
        await File.insertMany(
          files.map((f) => ({
            project: project._id,
            path: f.path,
            content: f.content,
            size: Buffer.byteLength(f.content, "utf8"),
            hash: hashContent(f.content),
          })),
          { ordered: false }
        );
      } catch (err) {
        await Project.deleteOne({ _id: project._id });
        await File.deleteMany({ project: project._id });
        throw err;
      }
      return projectSummary(project.toObject());
    },

    async countProjects(ownerId) {
      return Project.countDocuments({ ownerId });
    },

    async listProjects(ownerId) {
      const docs = await Project.find({ ownerId }).select("-graph").sort({ updatedAt: -1 }).lean();
      return docs.map(projectSummary);
    },

    async getProject(ownerId, id, { includeGraph = false } = {}) {
      if (!valid(id)) return null;
      const query = Project.findOne({ _id: id, ownerId });
      if (!includeGraph) query.select("-graph");
      const doc = await query.lean();
      if (!doc) return null;
      const { ownerId: _o, ...rest } = plain(doc);
      return rest;
    },

    async deleteProject(ownerId, id) {
      if (!valid(id)) return false;
      const res = await Project.deleteOne({ _id: id, ownerId });
      if (!res.deletedCount) return false;
      await Promise.all([
        File.deleteMany({ project: id }),
        Decision.deleteMany({ project: id }),
        Improvement.deleteMany({ project: id }),
      ]);
      return true;
    },

    async updateGraph(projectId, graph, stats) {
      await Project.updateOne({ _id: projectId }, { $set: { graph, stats } });
    },

    async listFiles(projectId) {
      const docs = await File.find({ project: projectId }).select("path size").sort({ path: 1 }).lean();
      return docs.map(({ path, size }) => ({ path, size }));
    },

    async getAllFiles(projectId) {
      const docs = await File.find({ project: projectId }).select("path content").lean();
      return docs.map(({ path, content }) => ({ path, content }));
    },

    async getFile(projectId, path) {
      const doc = await File.findOne({ project: projectId, path }).lean();
      return doc ? { path: doc.path, content: doc.content, size: doc.size, hash: doc.hash } : null;
    },

    async saveFile(projectId, path, content) {
      const record = { path, content, size: Buffer.byteLength(content, "utf8"), hash: hashContent(content) };
      await File.updateOne({ project: projectId, path }, { $set: record }, { upsert: true });
      await Project.updateOne({ _id: projectId }, { $currentDate: { updatedAt: true } });
      return record;
    },

    async listDecisions(projectId) {
      const docs = await Decision.find({ project: projectId }).sort({ createdAt: -1 }).lean();
      return docs.map(plain);
    },

    async createDecision(projectId, data) {
      const doc = await Decision.create({ ...data, project: projectId });
      return plain(doc.toObject());
    },

    async updateDecision(projectId, id, patch) {
      if (!valid(id)) return null;
      const doc = await Decision.findOneAndUpdate(
        { _id: id, project: projectId },
        { $set: patch },
        { returnDocument: "after", runValidators: true }
      ).lean();
      return plain(doc);
    },

    async deleteDecision(projectId, id) {
      if (!valid(id)) return false;
      const res = await Decision.deleteOne({ _id: id, project: projectId });
      return res.deletedCount > 0;
    },

    async createImprovement(projectId, data) {
      const doc = await Improvement.create({ ...data, project: projectId });
      return plain(doc.toObject());
    },

    async getImprovement(projectId, id) {
      if (!valid(id)) return null;
      return plain(await Improvement.findOne({ _id: id, project: projectId }).lean());
    },

    async updateImprovement(projectId, id, patch) {
      if (!valid(id)) return null;
      const doc = await Improvement.findOneAndUpdate(
        { _id: id, project: projectId },
        { $set: patch },
        { returnDocument: "after" }
      ).lean();
      return plain(doc);
    },

    async listImprovements(projectId, { limit = 50 } = {}) {
      const docs = await Improvement.find({ project: projectId })
        .select("-originalCode -updatedCode")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
      return docs.map(plain);
    },

    async close() {
      await mongoose.disconnect();
    },
  };
}

module.exports = { createMongoStore, models: { Project, File, Decision, Improvement } };
