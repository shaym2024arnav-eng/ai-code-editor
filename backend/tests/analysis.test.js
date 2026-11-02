const { buildGraph, urlMatchScore, joinUrl } = require("../src/analysis/buildGraph");
const { parseFile } = require("../src/analysis/parseFile");
const { computeImpact } = require("../src/analysis/impact");
const { sampleFiles } = require("./fixtures/sampleProject");

const { graph, stats } = buildGraph(sampleFiles());
const ids = new Set(graph.nodes.map((n) => n.id));
const hasEdge = (type, source, target) =>
  graph.edges.some((e) => e.type === type && e.source === source && e.target === target);

describe("parseFile", () => {
  test("extracts CommonJS exports, require destructuring and functions", () => {
    const f = parseFile("c.js", "const { a } = require('./a');\nexports.run = async (x) => a(x);\nmodule.exports.stop = function () {};");
    expect(f.imports[0]).toMatchObject({ source: "./a", kind: "require" });
    expect(f.imports[0].specifiers).toEqual([{ imported: "a", local: "a" }]);
    expect(f.exports.map((e) => e.name)).toEqual(["run", "stop"]);
    expect(f.functions.find((fn) => fn.name === "run")).toMatchObject({ async: true, params: 1, exported: true });
    expect(f.calls).toContainEqual(expect.objectContaining({ caller: "run", name: "a" }));
  });

  test("handles TypeScript without treating generics as JSX", () => {
    const f = parseFile("x.ts", "export function id<T>(v: T): T { return <T>v; }\nexport interface Props { a: string }");
    expect(f.error).toBeNull();
    expect(f.exports.map((e) => e.name)).toEqual(["id", "Props"]);
  });

  test("does not treat array callbacks as named functions", () => {
    const f = parseFile("y.js", "const names = items.map((i) => i.name);\nconst Comp = memo(() => null);");
    expect(f.functions.map((fn) => fn.name)).toEqual(["Comp"]);
  });

  test("reports syntax errors instead of throwing", () => {
    const f = parseFile("bad.js", "function (");
    expect(f.error).toBeTruthy();
  });
});

describe("buildGraph", () => {
  test("resolves imports including the @/ alias and barrel re-exports", () => {
    expect(hasEdge("imports", "file:frontend/src/App.jsx", "file:frontend/src/components/UserList.jsx")).toBe(true);
    expect(hasEdge("imports", "file:frontend/src/App.jsx", "file:frontend/src/api/index.js")).toBe(true);
    // fetchUsers is called in App and defined in api/users.js behind `export *`
    expect(hasEdge("calls", "fn:frontend/src/App.jsx#App", "fn:frontend/src/api/users.js#fetchUsers")).toBe(true);
    expect(hasEdge("imports", "file:frontend/src/api/users.js", "pkg:axios")).toBe(true);
  });

  test("builds full route paths from app.use mounts and links handlers", () => {
    expect(ids.has("route:GET /api/users")).toBe(true);
    expect(ids.has("route:POST /api/users")).toBe(true);
    expect(ids.has("route:DELETE /api/users/:id")).toBe(true);
    expect(ids.has("route:GET /health")).toBe(true);
    expect(hasEdge("handles", "route:GET /api/users", "fn:backend/controllers/userController.js#getUsers")).toBe(true);
    expect(hasEdge("middleware", "route:POST /api/users", "fn:backend/middleware/auth.js#protect")).toBe(true);
    expect(hasEdge("handles", "route:DELETE /api/users/:id", "fn:backend/routes/userRoutes.js#DELETE /:id")).toBe(true);
  });

  test("matches frontend requests to backend routes through an imported base URL", () => {
    expect(hasEdge("requests", "fn:frontend/src/api/users.js#fetchUsers", "route:GET /api/users")).toBe(true);
    expect(hasEdge("requests", "fn:frontend/src/api/users.js#addUser", "route:POST /api/users")).toBe(true);
    expect(hasEdge("requests", "fn:frontend/src/api/users.js#removeUser", "route:DELETE /api/users/:id")).toBe(true);
    expect(graph.insights.externalRequests).toEqual([expect.objectContaining({ external: "example.org" })]);
    expect(graph.insights.unmatchedRequests).toEqual([]);
  });

  test("links data models to the functions that use them", () => {
    expect(ids.has("model:User")).toBe(true);
    expect(hasEdge("uses-model", "fn:backend/controllers/userController.js#getUsers", "model:User")).toBe(true);
  });

  test("records JSX rendering as connections", () => {
    expect(hasEdge("renders", "fn:frontend/src/App.jsx#App", "fn:frontend/src/components/UserList.jsx#UserList")).toBe(true);
    expect(hasEdge("renders", "file:frontend/src/main.jsx", "fn:frontend/src/App.jsx#App")).toBe(true);
  });

  test("finds cycles, unused exports and case-mismatched imports", () => {
    expect(graph.insights.cycles).toContainEqual(["frontend/src/components/cycleA.js", "frontend/src/components/cycleB.js"]);
    expect(graph.insights.unusedExports).toContainEqual({ path: "backend/utils/format.js", name: "unusedHelper" });
    expect(graph.insights.brokenImports).toContainEqual(
      expect.objectContaining({ path: "backend/utils/broken.js", source: "../Utils/format", caseMismatch: "backend/utils/format.js" })
    );
  });

  test("produces stats", () => {
    expect(stats).toMatchObject({ files: 16, analyzedFiles: 15, routes: 4, models: 1, matchedRequests: 3 });
  });
});

describe("computeImpact", () => {
  test("lists dependents, callers and routes for a file", () => {
    const impact = computeImpact(graph, "backend/controllers/userController.js");
    expect(impact.directImporters).toEqual(["backend/routes/userRoutes.js"]);
    expect(impact.transitiveDependents.map((d) => d.path)).toEqual(["backend/routes/userRoutes.js", "backend/server.js"]);
    const getUsers = impact.functions.find((f) => f.name === "getUsers");
    expect(getUsers.externalCallers).toContainEqual(expect.objectContaining({ type: "route", path: "/api/users", method: "GET" }));
    expect(impact.modelsUsed.map((m) => m.name)).toEqual(["User"]);
  });

  test("shows which backend routes a frontend file calls", () => {
    const impact = computeImpact(graph, "frontend/src/api/users.js");
    expect(impact.requestsMade.map((r) => `${r.method} ${r.path}`).sort()).toEqual(["DELETE /api/users/:id", "GET /api/users", "POST /api/users"]);
    expect(impact.requestsMade.find((r) => r.method === "GET").handler.name).toBe("getUsers");
  });

  test("returns null for files outside the code map", () => {
    expect(computeImpact(graph, "README.md")).toBeNull();
  });
});

describe("url helpers", () => {
  test("joinUrl normalizes slashes", () => {
    expect(joinUrl("/api/", "/users/")).toBe("/api/users");
    expect(joinUrl("", "/")).toBe("/");
  });

  test("urlMatchScore prefers exact matches and supports unknown bases", () => {
    expect(urlMatchScore("/api/users/:param", false, "/api/users/:id")).toBeGreaterThan(2);
    expect(urlMatchScore("/users", true, "/api/users")).toBeGreaterThan(1);
    expect(urlMatchScore("/users", false, "/api/users")).toBe(0);
    expect(urlMatchScore("/:param", true, "/api/users")).toBe(0);
  });
});
