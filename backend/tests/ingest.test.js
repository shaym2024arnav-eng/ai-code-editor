const AdmZip = require("adm-zip");
const { normalizePath, skipReason, collectFiles } = require("../src/ingest/filters");
const { filesFromZip } = require("../src/ingest/zip");
const { parseGithubUrl, filesFromGithub } = require("../src/ingest/github");

const limits = { maxFiles: 50, maxFileBytes: 1000, maxTotalBytes: 5000, maxZipBytes: 100000, maxZipEntries: 500 };

const entry = (path, content) => {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { path, size: buf.length, read: () => buf };
};

describe("normalizePath", () => {
  test.each([
    ["./src/a.js", "src/a.js"],
    ["src\\win\\b.js", "src/win/b.js"],
    ["/abs/c.js", "abs/c.js"],
    ["../escape.js", null],
    ["a/../../b.js", null],
    ["C:/x.js", null],
    ["", null],
  ])("%s -> %s", (input, expected) => expect(normalizePath(input)).toBe(expected));
});

describe("skipReason", () => {
  test.each([
    ["node_modules/x/index.js", "ignored-folder"],
    ["app/.git/config", "ignored-folder"],
    ["package-lock.json", "ignored-file"],
    [".env", "secret"],
    ["backend/.env.production", "secret"],
    ["dist2/app.min.js", "generated"],
    ["logo.png", "unsupported-type"],
    [".env.example", null],
    ["src/App.tsx", null],
    ["Dockerfile", null],
  ])("%s -> %s", (p, expected) => expect(skipReason(p)).toBe(expected));
});

describe("collectFiles", () => {
  test("keeps source files, strips a shared root folder and reports skips", () => {
    const { files, skipped } = collectFiles(
      [
        entry("my-app/src/a.js", "a"),
        entry("my-app/node_modules/lib/index.js", "x"),
        entry("my-app/.env", "SECRET=1"),
        entry("my-app/big.js", "x".repeat(2000)),
        entry("my-app/bin.js", Buffer.from([0x61, 0x00, 0x62])),
      ],
      limits
    );
    expect(files).toEqual([{ path: "src/a.js", content: "a" }]);
    expect(skipped.reasons).toEqual({ "ignored-folder": 1, secret: 1, "too-large": 1, binary: 1 });
  });

  test("rejects projects over the file or size limits", () => {
    const many = Array.from({ length: 51 }, (_, i) => entry(`f${i}.js`, "x"));
    expect(() => collectFiles(many, limits)).toThrow(/more than 50/);
    const heavy = Array.from({ length: 6 }, (_, i) => entry(`h${i}.js`, "x".repeat(900)));
    expect(() => collectFiles(heavy, limits)).toThrow(/larger than/);
  });

  test("rejects an upload with no supported files", () => {
    expect(() => collectFiles([entry("a.png", "x")], limits)).toThrow(/No supported source files/);
  });
});

describe("filesFromZip", () => {
  test("reads a zip archive", () => {
    const zip = new AdmZip();
    zip.addFile("proj/index.js", Buffer.from("console.log(1)"));
    zip.addFile("proj/node_modules/x.js", Buffer.from("x"));
    const { files } = filesFromZip(zip.toBuffer(), limits);
    expect(files).toEqual([{ path: "index.js", content: "console.log(1)" }]);
  });

  test("caps decompressed size even if the zip header lies", () => {
    const zip = new AdmZip();
    zip.addFile("bomb.js", Buffer.from("a".repeat(50000)));
    zip.addFile("ok.js", Buffer.from("ok"));
    const buf = zip.toBuffer();
    const { files, skipped } = filesFromZip(buf, limits);
    expect(files.map((f) => f.path)).toEqual(["ok.js"]);
    expect(skipped.reasons["too-large"]).toBe(1);
  });

  test("rejects non-zip data", () => {
    expect(() => filesFromZip(Buffer.from("not a zip"), limits)).toThrow(/not a valid zip/);
  });
});

describe("GitHub import", () => {
  test.each([
    ["owner/repo", { owner: "owner", repo: "repo", ref: null }],
    ["https://github.com/owner/repo.git", { owner: "owner", repo: "repo", ref: null }],
    ["github.com/owner/repo/tree/dev", { owner: "owner", repo: "repo", ref: "dev" }],
    ["https://github.com/o/r/tree/feature/x", { owner: "o", repo: "r", ref: "feature/x" }],
  ])("parses %s", (input, expected) => expect(parseGithubUrl(input)).toEqual(expected));

  test.each(["https://gitlab.com/o/r", "https://github.com/only-owner", "not a url at all", "https://github.com/o/r/tree/a%2F..%2Fb"])(
    "rejects %s",
    (input) => expect(() => parseGithubUrl(input)).toThrow()
  );

  const zipResponse = (buffer, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Map([["content-length", String(buffer.length)]]),
    body: (async function* gen() { yield buffer; })(),
  });

  test("downloads the zipball from the GitHub API", async () => {
    const zip = new AdmZip();
    zip.addFile("owner-repo-abc123/src/app.js", Buffer.from("export const x = 1;"));
    const fetchImpl = jest.fn(async () => zipResponse(zip.toBuffer()));
    const result = await filesFromGithub("owner/repo", { limits, token: "t", fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/repos/owner/repo/zipball");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
    expect(result.files).toEqual([{ path: "src/app.js", content: "export const x = 1;" }]);
    expect(result.source).toEqual({ type: "github", url: "https://github.com/owner/repo", ref: undefined });
  });

  test("explains a missing or private repository", async () => {
    const fetchImpl = async () => zipResponse(Buffer.alloc(0), 404);
    await expect(filesFromGithub("owner/private", { limits, fetchImpl })).rejects.toMatchObject({ status: 404 });
  });

  test("stops downloading archives over the size limit", async () => {
    const fetchImpl = async () => zipResponse(Buffer.alloc(limits.maxZipBytes + 1));
    await expect(filesFromGithub("owner/huge", { limits, fetchImpl })).rejects.toThrow(/larger than/);
  });
});
