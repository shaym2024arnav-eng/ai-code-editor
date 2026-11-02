const { parseJson, toHttpError } = require("../src/ai/gemini");
const { cleanCode } = require("../src/ai/checks");
const { decisionApplies } = require("../src/ai/context");
const { models } = require("../src/store/mongoStore");

describe("Gemini helpers", () => {
  test("parseJson accepts plain and fenced JSON", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(() => parseJson("not json")).toThrow(/malformed/);
    expect(() => parseJson("")).toThrow(/empty/);
  });

  test.each([
    [{ status: 429, message: "x" }, 429],
    [{ status: 400, message: "API key not valid" }, 502],
    [{ status: 403, message: "forbidden" }, 502],
    [{ status: 404, message: "model not found" }, 502],
    [{ name: "AbortError", message: "aborted" }, 504],
  ])("maps SDK error %j to HTTP %i", (err, status) => {
    expect(toHttpError(err).status).toBe(status);
  });
});

describe("cleanCode", () => {
  test("strips a single surrounding fence only", () => {
    expect(cleanCode("```js\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(cleanCode("const s = '```';")).toBe("const s = '```';");
    expect(cleanCode(undefined)).toBe("");
  });
});

describe("decisionApplies", () => {
  const d = (scope, status = "active") => ({ scope, status });
  test.each([
    [[], "any/file.js", true],
    [["backend/"], "backend/a.js", true],
    [["backend"], "backend/a.js", true],
    [["backend"], "backend-old/a.js", false],
    [["src/App.jsx"], "src/App.jsx", true],
    [["**/*.jsx"], "frontend/src/App.jsx", true],
    [["src/*.js"], "src/deep/a.js", false],
  ])("scope %j applies to %s: %s", (scope, file, expected) => {
    expect(decisionApplies(d(scope), file)).toBe(expected);
  });

  test("superseded decisions never apply", () => {
    expect(decisionApplies(d([], "superseded"), "a.js")).toBe(false);
  });
});

describe("Mongo schemas", () => {
  const validationErrors = (doc) => doc.validate().then(() => ({}), (err) => err.errors);

  test("decision requires title and decision text and a known status", async () => {
    const bad = new models.Decision({ project: "64b7f0f0f0f0f0f0f0f0f0f0", title: "", decision: "", status: "maybe" });
    expect(Object.keys(await validationErrors(bad)).sort()).toEqual(["decision", "status", "title"]);
  });

  test("project source type is restricted", async () => {
    const bad = new models.Project({ ownerId: "x", name: "n", source: { type: "ftp" } });
    expect((await validationErrors(bad))["source.type"]).toBeDefined();
  });
});
