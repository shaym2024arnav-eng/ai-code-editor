// Small API client. Every request carries this browser's anonymous client ID,
// which the backend uses to keep each visitor's projects private.
const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let memoryId = null;
function clientId() {
  try {
    let id = localStorage.getItem("dt-client-id");
    if (!id) {
      id = uuid();
      localStorage.setItem("dt-client-id", id);
    }
    return id;
  } catch {
    memoryId = memoryId || uuid();
    return memoryId;
  }
}

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request(path, { method = "GET", body, form, raw } = {}) {
  const headers = { "X-Client-Id": clientId() };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check that the backend is running.");
  }
  if (raw && res.ok) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.message || `Request failed (${res.status}).`, data);
  return data;
}

const q = (path) => encodeURIComponent(path);

export const api = {
  health: () => request("/health"),
  goals: () => request("/goals"),

  listProjects: () => request("/projects"),
  getProject: (id) => request(`/projects/${id}`),
  deleteProject: (id) => request(`/projects/${id}`, { method: "DELETE" }),
  uploadZip: (file, name) => {
    const form = new FormData();
    form.append("archive", file);
    if (name) form.append("name", name);
    return request("/projects/zip", { method: "POST", form });
  },
  uploadFolder: (entries, name) => {
    const form = new FormData();
    entries.forEach(({ file, path }) => form.append("files", file, path));
    form.append("paths", JSON.stringify(entries.map((e) => e.path)));
    if (name) form.append("name", name);
    return request("/projects/folder", { method: "POST", form });
  },
  importGithub: (url, name) => request("/projects/github", { method: "POST", body: { url, name } }),

  graph: (id) => request(`/projects/${id}/graph`),
  getFile: (id, path) => request(`/projects/${id}/file?path=${q(path)}`),
  saveFile: (id, path, content, baseHash) => request(`/projects/${id}/file`, { method: "PUT", body: { path, content, baseHash } }),
  impact: (id, path) => request(`/projects/${id}/impact?path=${q(path)}`),
  exportZip: (id) => request(`/projects/${id}/export`, { raw: true }),

  improve: (id, body) => request(`/projects/${id}/improve`, { method: "POST", body }),
  improvements: (id) => request(`/projects/${id}/improvements`),
  accept: (id, impId, body) => request(`/projects/${id}/improvements/${impId}/accept`, { method: "POST", body }),
  reject: (id, impId) => request(`/projects/${id}/improvements/${impId}/reject`, { method: "POST" }),
  ask: (id, question, path) => request(`/projects/${id}/ask`, { method: "POST", body: { question, path } }),

  decisions: (id) => request(`/projects/${id}/decisions`),
  addDecision: (id, d) => request(`/projects/${id}/decisions`, { method: "POST", body: d }),
  updateDecision: (id, did, patch) => request(`/projects/${id}/decisions/${did}`, { method: "PATCH", body: patch }),
  deleteDecision: (id, did) => request(`/projects/${id}/decisions/${did}`, { method: "DELETE" }),
  suggestDecisions: (id) => request(`/projects/${id}/decisions/suggest`, { method: "POST" }),
};
