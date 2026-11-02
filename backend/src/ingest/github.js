// Imports a public GitHub repository by downloading its zipball (no git needed).
const { filesFromZip } = require("./zip");
const { badRequest, HttpError } = require("../middleware/errors");

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,200}$/;

// Accepts "owner/repo", "https://github.com/owner/repo(.git)" and
// "https://github.com/owner/repo/tree/<branch>". Returns { owner, repo, ref }.
function parseGithubUrl(input) {
  if (typeof input !== "string" || !input.trim()) throw badRequest("Enter a GitHub repository URL.");
  let text = input.trim();

  if (!/^https?:\/\//i.test(text) && /^[^/\s]+\/[^/\s]+/.test(text) && !text.startsWith("github.com")) {
    text = `https://github.com/${text}`;
  } else if (/^github\.com\//i.test(text)) {
    text = `https://${text}`;
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    throw badRequest("That doesn't look like a valid GitHub URL.");
  }
  if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    throw badRequest("Only github.com repository URLs are supported.");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) throw badRequest("The URL should look like https://github.com/owner/repo.");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  let ref = null;
  if (parts[2] === "tree" && parts.length > 3) ref = decodeURIComponent(parts.slice(3).join("/"));

  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw badRequest("Invalid repository owner or name.");
  if (ref !== null && (!REF_RE.test(ref) || ref.includes(".."))) throw badRequest("Invalid branch name.");
  return { owner, repo, ref };
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (declared && declared > maxBytes) {
    throw badRequest(`Repository archive is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw badRequest(`Repository archive is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function filesFromGithub(input, { limits, token, fetchImpl = fetch }) {
  const { owner, repo, ref } = parseGithubUrl(input);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/zipball${ref ? `/${encodeURIComponent(ref)}` : ""}`;

  const headers = {
    "User-Agent": "ai-code-editor",
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(apiUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(60000) });
  } catch {
    throw new HttpError(502, "Could not reach GitHub. Try again in a moment.");
  }

  if (response.status === 404) {
    throw new HttpError(404, "Repository or branch not found. Private repositories aren't supported.");
  }
  if (response.status === 401) {
    throw new HttpError(502, "GitHub rejected the request. If GITHUB_TOKEN is set on the server, check that it is valid.");
  }
  if (response.status === 403 || response.status === 429) {
    throw new HttpError(429, "GitHub rate limit reached. Try again later, or set GITHUB_TOKEN on the server.");
  }
  if (!response.ok) throw new HttpError(502, `GitHub returned an error (${response.status}).`);

  const buffer = await readLimited(response, limits.maxZipBytes);
  const result = filesFromZip(buffer, limits);
  return { ...result, source: { type: "github", url: `https://github.com/${owner}/${repo}`, ref: ref || undefined }, defaultName: repo };
}

module.exports = { parseGithubUrl, filesFromGithub };
