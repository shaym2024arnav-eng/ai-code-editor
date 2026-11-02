const request = require("supertest");
const AdmZip = require("adm-zip");
const baseConfig = require("../src/config");
const { createApp } = require("../src/app");
const { createMemoryStore } = require("../src/store/memoryStore");
const { sampleFiles } = require("./fixtures/sampleProject");

const ME = "3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER = "11111111-2222-4333-8444-555555555555";

function sampleZip() {
  const zip = new AdmZip();
  for (const f of sampleFiles()) zip.addFile(`sample/${f.path}`, Buffer.from(f.content));
  return zip.toBuffer();
}

// A fake Gemini client: returns whatever the current test queues up.
function fakeAi() {
  const ai = { model: "fake-model", calls: [], next: null };
  ai.generateJson = jest.fn(async (args) => {
    ai.calls.push(args);
    return typeof ai.next === "function" ? ai.next(args) : ai.next;
  });
  ai.generateText = jest.fn(async (args) => {
    ai.calls.push(args);
    return "The User model is used by userController.js.";
  });
  return ai;
}

let app;
let ai;
let projectId;

const as = (clientId) => ({
  get: (url) => request(app).get(url).set("X-Client-Id", clientId),
  post: (url) => request(app).post(url).set("X-Client-Id", clientId),
  put: (url) => request(app).put(url).set("X-Client-Id", clientId),
  patch: (url) => request(app).patch(url).set("X-Client-Id", clientId),
  delete: (url) => request(app).delete(url).set("X-Client-Id", clientId),
});
const me = as(ME);

beforeEach(async () => {
  ai = fakeAi();
  app = createApp({ store: createMemoryStore(), ai, config: { ...baseConfig, corsOrigins: [] }, rateLimits: false });
  const res = await me.post("/api/projects/zip").attach("archive", sampleZip(), "sample.zip").field("name", "Sample");
  expect(res.status).toBe(201);
  projectId = res.body.project.id;
});

describe("projects", () => {
  test("health works without a client id", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body).toMatchObject({ ok: true, storage: "memory", ai: { enabled: true, model: "fake-model" } });
  });

  test("requires a valid client id", async () => {
    expect((await request(app).get("/api/projects")).status).toBe(401);
    expect((await request(app).get("/api/projects").set("X-Client-Id", "nope")).status).toBe(401);
  });

  test("zip upload creates a project with a code map", async () => {
    const res = await me.get(`/api/projects/${projectId}`);
    expect(res.body.project).toMatchObject({ name: "Sample", source: { type: "zip" } });
    expect(res.body.project.stats.routes).toBe(4);
    expect(res.body.files.map((f) => f.path)).toContain("backend/server.js");
    const graph = await me.get(`/api/projects/${projectId}/graph`);
    expect(graph.body.graph.nodes.some((n) => n.id === "route:GET /api/users")).toBe(true);
  });

  test("folder upload keeps relative paths", async () => {
    const res = await me
      .post("/api/projects/folder")
      .attach("files", Buffer.from("export const a = 1;"), { filename: "demo/src/a.js" })
      .attach("files", Buffer.from("import { a } from './a';"), { filename: "demo/src/b.js" })
      .attach("files", Buffer.from("x"), { filename: "demo/node_modules/x/index.js" })
      .field("paths", JSON.stringify(["demo/src/a.js", "demo/src/b.js", "demo/node_modules/x/index.js"]));
    expect(res.status).toBe(201);
    expect(res.body.project.name).toBe("demo");
    const detail = await me.get(`/api/projects/${res.body.project.id}`);
    expect(detail.body.files.map((f) => f.path)).toEqual(["src/a.js", "src/b.js"]);
  });

  test("other clients cannot see or change my project", async () => {
    const other = as(OTHER);
    expect((await other.get("/api/projects")).body.projects).toEqual([]);
    expect((await other.get(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await other.get(`/api/projects/${projectId}/file?path=backend/server.js`)).status).toBe(404);
    expect((await other.delete(`/api/projects/${projectId}`)).status).toBe(404);
    expect((await other.post(`/api/projects/${projectId}/decisions`).send({ title: "x", decision: "y" })).status).toBe(404);
  });

  test("reads and saves files, re-analyzing the code map", async () => {
    const read = await me.get(`/api/projects/${projectId}/file?path=backend/middleware/auth.js`);
    expect(read.body.file.content).toContain("protect");
    const save = await me.put(`/api/projects/${projectId}/file`).send({
      path: "backend/middleware/auth.js",
      content: "const protect = (req, res, next) => next();\nconst admin = (req, res, next) => next();\nmodule.exports = protect;\n",
      baseHash: read.body.file.hash,
    });
    expect(save.status).toBe(200);
    expect(save.body.stats.functions).toBeGreaterThan(0);
    const stale = await me.put(`/api/projects/${projectId}/file`).send({
      path: "backend/middleware/auth.js", content: "x", baseHash: read.body.file.hash,
    });
    expect(stale.status).toBe(409);
  });

  test("rejects unsafe or missing paths", async () => {
    expect((await me.get(`/api/projects/${projectId}/file?path=../etc/passwd`)).status).toBe(400);
    expect((await me.get(`/api/projects/${projectId}/file?path=nope.js`)).status).toBe(404);
    expect((await me.put(`/api/projects/${projectId}/file`).send({ path: "new.js", content: "x" })).status).toBe(404);
  });

  test("impact analysis for a file", async () => {
    const res = await me.get(`/api/projects/${projectId}/impact?path=backend/controllers/userController.js`);
    expect(res.status).toBe(200);
    expect(res.body.impact.directImporters).toEqual(["backend/routes/userRoutes.js"]);
  });

  test("exports the project as a zip", async () => {
    const res = await me.get(`/api/projects/${projectId}/export`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.headers["content-disposition"]).toContain("Sample.zip");
    const zip = new AdmZip(res.body);
    expect(zip.getEntries().map((e) => e.entryName)).toContain("backend/server.js");
  });

  test("deletes a project", async () => {
    expect((await me.delete(`/api/projects/${projectId}`)).status).toBe(204);
    expect((await me.get(`/api/projects/${projectId}`)).status).toBe(404);
  });

  test("GitHub import uses the injected fetch", async () => {
    const zip = new AdmZip();
    zip.addFile("o-r-1/index.js", Buffer.from("module.exports = 1;"));
    const buffer = zip.toBuffer();
    const fetchImpl = async () => ({
      status: 200, ok: true, headers: new Map(), body: (async function* g() { yield buffer; })(),
    });
    const ghApp = createApp({ store: createMemoryStore(), ai: null, config: { ...baseConfig, fetchImpl }, rateLimits: false });
    const res = await request(ghApp).post("/api/projects/github").set("X-Client-Id", ME).send({ url: "o/r" });
    expect(res.status).toBe(201);
    expect(res.body.project).toMatchObject({ name: "r", source: { type: "github", url: "https://github.com/o/r" } });
  });
});

describe("decisions (architecture memory)", () => {
  test("create, list, update and delete", async () => {
    const created = await me.post(`/api/projects/${projectId}/decisions`).send({
      title: "Controllers stay thin",
      decision: "Business logic lives in services, controllers only handle HTTP.",
      scope: ["backend/"],
    });
    expect(created.status).toBe(201);
    const id = created.body.decision.id;
    expect((await me.get(`/api/projects/${projectId}/decisions`)).body.decisions).toHaveLength(1);
    const patched = await me.patch(`/api/projects/${projectId}/decisions/${id}`).send({ status: "superseded" });
    expect(patched.body.decision.status).toBe("superseded");
    expect((await me.patch(`/api/projects/${projectId}/decisions/${id}`).send({ status: "weird" })).status).toBe(400);
    expect((await me.delete(`/api/projects/${projectId}/decisions/${id}`)).status).toBe(204);
  });

  test("validates input", async () => {
    expect((await me.post(`/api/projects/${projectId}/decisions`).send({ title: "" })).status).toBe(400);
    expect((await me.post(`/api/projects/${projectId}/decisions`).send({ title: "a", decision: "b", scope: "x" })).status).toBe(400);
  });

  test("AI suggestions are returned but not saved", async () => {
    ai.next = { decisions: [{ title: "Use Express routers", decision: "Each resource has a router in backend/routes.", rationale: "Seen in code.", scope: ["backend/routes/"] }] };
    const res = await me.post(`/api/projects/${projectId}/decisions/suggest`);
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(1);
    expect(ai.calls[0].prompt).toContain("backend/routes/userRoutes.js");
    expect((await me.get(`/api/projects/${projectId}/decisions`)).body.decisions).toHaveLength(0);
  });
});

describe("AI improvements", () => {
  const PATH = "backend/controllers/userController.js";

  async function addDecision(body) {
    return (await me.post(`/api/projects/${projectId}/decisions`).send(body)).body.decision;
  }

  test("sends goal, connections and applicable decisions to the model", async () => {
    const backendRule = await addDecision({ title: "Use async/await", decision: "No .then chains in backend code.", scope: ["backend/"] });
    await addDecision({ title: "Frontend only", decision: "Use React Query.", scope: ["frontend/**"] });
    const original = (await me.get(`/api/projects/${projectId}/file?path=${PATH}`)).body.file.content;
    ai.next = {
      summary: "Added error handling.",
      changes: [{ title: "Handle errors", explanation: "Wrap in try/catch.", category: "bug-fix", lineHint: "4-7" }],
      updatedCode: `\`\`\`js\n${original}// improved\n\`\`\``,
      riskLevel: "low",
      decisionChecks: [{ ref: "D1", status: "respected", note: "Uses await." }, { ref: "D9", status: "conflict" }],
      suggestedDecision: { shouldRecord: true, title: "Handlers catch errors", decision: "Every handler uses try/catch.", rationale: "Consistency." },
    };

    const res = await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "bugs" });
    expect(res.status).toBe(201);
    const { prompt, system } = ai.calls[0];
    expect(system).toContain("Respect the architecture decisions");
    expect(prompt).toContain("Find & fix bugs");
    expect(prompt).toContain("Use async/await");
    expect(prompt).not.toContain("React Query"); // scoped to frontend only
    expect(prompt).toContain("GET /api/users"); // connection from the code map
    expect(prompt).toContain("backend/utils/format.js"); // related file content

    const imp = res.body.improvement;
    expect(imp.status).toBe("pending");
    expect(imp.updatedCode).toBe(`${original}// improved`); // code fences stripped
    expect(imp.result.decisionChecks).toEqual([
      { decisionId: backendRule.id, title: "Use async/await", status: "respected", note: "Uses await." },
    ]);
    expect(imp.result.suggestedDecision.title).toBe("Handlers catch errors");
    expect(imp.checks).toMatchObject({ syntaxOk: true, removedExports: [], identical: false });
  });

  test("flags broken syntax and removed exports that other files use", async () => {
    ai.next = {
      summary: "Renamed.",
      changes: [{ title: "Rename", explanation: "x", category: "readability" }],
      updatedCode: "exports.getUsers = async (req, res) => {\n  res.json([]);\n};\nexports.oops = (",
      riskLevel: "high",
    };
    const res = await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "readability" });
    const { checks } = res.body.improvement;
    expect(checks.syntaxOk).toBe(false);
    expect(checks.removedExports).toContainEqual({ name: "createUser", usedBy: ["backend/routes/userRoutes.js"] });
    expect(checks.warnings.join(" ")).toMatch(/createUser/);
  });

  test("accepting applies the (edited) code and can record a decision", async () => {
    ai.next = (args) => ({ summary: "ok", changes: [], updatedCode: "exports.getUsers = async () => {};\nexports.createUser = async () => {};\n", riskLevel: "low" });
    const imp = (await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "readability" })).body.improvement;

    const edited = "exports.getUsers = async () => [];\nexports.createUser = async () => {};\n";
    const res = await me.post(`/api/projects/${projectId}/improvements/${imp.id}/accept`).send({
      updatedCode: edited,
      decision: { title: "Thin controllers", decision: "Controllers delegate to services.", scope: ["backend/controllers/"] },
    });
    expect(res.status).toBe(200);
    expect(res.body.improvement.status).toBe("accepted");
    expect(res.body.decision).toMatchObject({ title: "Thin controllers", origin: "ai" });
    expect((await me.get(`/api/projects/${projectId}/file?path=${PATH}`)).body.file.content).toBe(edited);
    // Can't accept twice
    expect((await me.post(`/api/projects/${projectId}/improvements/${imp.id}/accept`).send({})).status).toBe(409);
    const list = await me.get(`/api/projects/${projectId}/improvements`);
    expect(list.body.improvements[0]).not.toHaveProperty("originalCode");
  });

  test("refuses to accept a suggestion for a file that changed since", async () => {
    ai.next = { summary: "ok", changes: [], updatedCode: "// new\n", riskLevel: "low" };
    const imp = (await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "readability" })).body.improvement;
    await me.put(`/api/projects/${projectId}/file`).send({ path: PATH, content: "// someone else edited\n" });
    const res = await me.post(`/api/projects/${projectId}/improvements/${imp.id}/accept`).send({});
    expect(res.status).toBe(409);
  });

  test("an invalid decision on accept changes nothing", async () => {
    ai.next = { summary: "ok", changes: [], updatedCode: "// new\n", riskLevel: "low" };
    const imp = (await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "readability" })).body.improvement;
    const res = await me.post(`/api/projects/${projectId}/improvements/${imp.id}/accept`).send({ decision: { title: "" } });
    expect(res.status).toBe(400);
    expect((await me.get(`/api/projects/${projectId}/file?path=${PATH}`)).body.file.content).not.toBe("// new\n");
  });

  test("reject marks the suggestion and leaves the file", async () => {
    ai.next = { summary: "ok", changes: [], updatedCode: "// new\n", riskLevel: "low" };
    const imp = (await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "performance" })).body.improvement;
    const res = await me.post(`/api/projects/${projectId}/improvements/${imp.id}/reject`);
    expect(res.body.improvement.status).toBe("rejected");
  });

  test("validates goal, instructions and selection", async () => {
    const post = (body) => me.post(`/api/projects/${projectId}/improve`).send(body);
    expect((await post({ path: PATH, goal: "magic" })).status).toBe(400);
    expect((await post({ path: PATH, goal: "custom" })).status).toBe(400);
    expect((await post({ path: PATH, goal: "readability", selection: { startLine: 5, endLine: 2 } })).status).toBe(400);
    expect((await post({ path: "missing.js", goal: "readability" })).status).toBe(404);
    expect(ai.generateJson).not.toHaveBeenCalled();
  });

  test("a selection is passed to the model", async () => {
    ai.next = { summary: "ok", changes: [], updatedCode: "x", riskLevel: "low" };
    await me.post(`/api/projects/${projectId}/improve`).send({ path: PATH, goal: "custom", instructions: "Add JSDoc", selection: { startLine: 4, endLine: 7 } });
    expect(ai.calls[0].prompt).toContain("Only change lines 4-7");
    expect(ai.calls[0].prompt).toContain("Add JSDoc");
  });

  test("ask answers questions with project context", async () => {
    const res = await me.post(`/api/projects/${projectId}/ask`).send({ question: "Where is User used?", path: PATH });
    expect(res.body.answer).toContain("userController");
    expect(ai.calls[0].prompt).toContain("models: User");
    expect(ai.calls[0].prompt).toContain(`Open file: ${PATH}`);
  });

  test("AI endpoints return 503 when no API key is configured", async () => {
    const noAi = createApp({ store: createMemoryStore(), ai: null, config: baseConfig, rateLimits: false });
    const up = await request(noAi).post("/api/projects/zip").set("X-Client-Id", ME).attach("archive", sampleZip(), "s.zip");
    const res = await request(noAi).post(`/api/projects/${up.body.project.id}/improve`).set("X-Client-Id", ME).send({ path: PATH, goal: "bugs" });
    expect(res.status).toBe(503);
  });
});
