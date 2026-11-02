import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { pickFolderEntries } from "../upload.js";
import { Spinner, useToast } from "./ui.jsx";

const SOURCES = [
  { id: "folder", label: "Folder" },
  { id: "zip", label: "Zip file" },
  { id: "github", label: "GitHub" },
];

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// A drafted example of the connections the code map draws.
function LegendPlate() {
  const node = (x, y, color, kind, name) => (
    <g transform={`translate(${x} ${y})`}>
      <rect width="150" height="44" rx="4" fill="var(--panel)" stroke="var(--rule-strong)" />
      <rect width="3" height="44" rx="1.5" fill={color} />
      <text x="12" y="17" fill="var(--faint)" fontSize="10.5">{kind}</text>
      <text x="12" y="33" fill="var(--text)" fontSize="12.5" fontWeight="600">{name}</text>
    </g>
  );
  const edge = (d, label, lx, ly, dashed) => (
    <g>
      <path d={d} fill="none" stroke="var(--muted)" strokeWidth="1.3" strokeDasharray={dashed ? "4 4" : undefined} markerEnd="url(#arrow)" />
      <text x={lx} y={ly} fill="var(--muted)" fontSize="10.5">{label}</text>
    </g>
  );
  return (
    <figure className="legend-plate" style={{ margin: 0 }}>
      <svg viewBox="0 0 400 330" role="img" aria-label="Example: a React component calls fetchUsers, which requests GET /api/users, handled by getUsers, which reads the User model.">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--muted)" />
          </marker>
        </defs>
        {node(16, 16, "var(--muted)", "src/App.jsx", "App")}
        {node(234, 16, "var(--fn)", "src/api/users.js", "fetchUsers()")}
        {node(234, 140, "var(--route)", "routes/users.js", "GET /api/users")}
        {node(16, 140, "var(--fn)", "controllers/users.js", "getUsers()")}
        {node(16, 264, "var(--model)", "models/User.js", "User")}
        {edge("M166 38 H230", "calls", 182, 32)}
        {edge("M309 60 V136", "requests", 316, 102, true)}
        {edge("M234 162 H170", "handled by", 172, 156)}
        {edge("M91 184 V260", "reads", 98, 226)}
      </svg>
      <figcaption className="muted" style={{ fontSize: "var(--step--1)", marginTop: 10 }}>
        The code map follows calls across the frontend, the API and the database, so every suggestion knows what it could break.
      </figcaption>
    </figure>
  );
}

function Importer({ onCreated }) {
  const toast = useToast();
  const [source, setSource] = useState("folder");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [drag, setDrag] = useState(false);
  const folderInput = useRef(null);
  const zipInput = useRef(null);

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      const res = await fn();
      const skipped = res.skipped?.count ? ` Skipped ${res.skipped.count} files that aren't source code.` : "";
      toast(`Mapped ${res.project.stats.analyzedFiles} JS/TS files.${skipped}`, "success");
      onCreated(res.project.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onFolder = (fileList) => {
    const { entries, tooMany, max } = pickFolderEntries(fileList);
    if (!entries.length) return setError("That folder has no source files to upload.");
    if (tooMany) return setError(`That folder has ${entries.length} source files; the limit is ${max}. Pick a sub-folder such as src.`);
    run(() => api.uploadFolder(entries));
  };

  const onZip = (file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return setError("Choose a .zip file.");
    run(() => api.uploadZip(file));
  };

  const tabKey = (e) => {
    const i = SOURCES.findIndex((s) => s.id === source);
    if (e.key === "ArrowRight") setSource(SOURCES[(i + 1) % SOURCES.length].id);
    if (e.key === "ArrowLeft") setSource(SOURCES[(i + SOURCES.length - 1) % SOURCES.length].id);
  };

  return (
    <div className="importer">
      <div className="importer-tabs" role="tablist" aria-label="Where your code comes from" onKeyDown={tabKey}>
        {SOURCES.map((s) => (
          <button key={s.id} role="tab" aria-selected={source === s.id} tabIndex={source === s.id ? 0 : -1}
            onClick={() => { setSource(s.id); setError(""); }}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="importer-body" role="tabpanel">
        {source === "folder" && (
          <>
            <button type="button" className="dropzone" onClick={() => folderInput.current.click()} disabled={busy}>
              <strong>Choose a project folder</strong>
              <span>node_modules, build output and .env files stay on your computer.</span>
            </button>
            <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden
              onChange={(e) => { onFolder(e.target.files); e.target.value = ""; }} />
          </>
        )}
        {source === "zip" && (
          <>
            <button type="button" className={`dropzone ${drag ? "active" : ""}`} disabled={busy}
              onClick={() => zipInput.current.click()}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); onZip(e.dataTransfer.files[0]); }}>
              <strong>Drop a .zip here, or click to choose one</strong>
              <span>Up to 25 MB. GitHub's "Download ZIP" works as is.</span>
            </button>
            <input ref={zipInput} type="file" accept=".zip,application/zip" hidden
              onChange={(e) => { onZip(e.target.files[0]); e.target.value = ""; }} />
          </>
        )}
        {source === "github" && (
          <form onSubmit={(e) => { e.preventDefault(); if (url.trim()) run(() => api.importGithub(url.trim())); }}
            style={{ display: "grid", gap: 10 }}>
            <label className="field">
              <span>Public repository URL</span>
              <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
                placeholder="https://github.com/owner/repo" autoComplete="off" spellCheck="false" />
            </label>
            <button className="btn btn-primary" type="submit" disabled={busy || !url.trim()}>Import repository</button>
          </form>
        )}
        {busy && <p className="muted" style={{ margin: 0 }}><Spinner /> Reading files and drawing the code map…</p>}
        {error && <p className="error-text" role="alert" style={{ margin: 0 }}>{error}</p>}
      </div>
    </div>
  );
}

export default function Home({ onOpen, theme, onToggleTheme }) {
  const toast = useToast();
  const [projects, setProjects] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);

  const load = () => api.listProjects().then((r) => setProjects(r.projects)).catch((e) => { setProjects([]); toast(e.message, "error"); });

  useEffect(() => {
    load();
    api.health().then((h) => setAiStatus(h.ai)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = async (p) => {
    if (!window.confirm(`Delete "${p.name}"? Its files, suggestions and decisions are removed for good.`)) return;
    try {
      await api.deleteProject(p.id);
      toast(`Deleted ${p.name}.`, "success");
      load();
    } catch (e) {
      toast(e.message, "error");
    }
  };

  return (
    <div className="home">
      <header className="home-top">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          <span>Drafting Table <small>AI code editor</small></span>
        </div>
        <button className="btn btn-ghost" onClick={onToggleTheme}>{theme === "dark" ? "Light theme" : "Dark theme"}</button>
      </header>
      <main className="home-main">
        <section>
          <h1>Improve code with the whole project in view.</h1>
          <p className="home-lede">
            Load a project to map how its files, functions, API routes and data models connect. Ask for changes by goal,
            review each one with its impact, and record the decisions you want every future suggestion to follow.
          </p>
          <Importer onCreated={onOpen} />
          {aiStatus && !aiStatus.enabled && (
            <p className="muted" style={{ fontSize: "var(--step--1)" }}>
              AI suggestions are off on this server until GEMINI_API_KEY is set. The code map works without it.
            </p>
          )}
          <div className="projects">
            <h2>Your projects</h2>
            {projects === null && <p className="muted"><Spinner /> Loading</p>}
            {projects && projects.length === 0 && <p className="muted">Nothing here yet. Your first project will appear here.</p>}
            {projects && projects.map((p) => (
              <div className="project-row" key={p.id}>
                <button className="open" onClick={() => onOpen(p.id)}>
                  <span className="name">{p.name}</span>
                  <span className="meta">
                    {p.stats.analyzedFiles} JS/TS files, {p.stats.routes} routes, {p.stats.models} models. Updated {timeAgo(p.updatedAt)}
                  </span>
                </button>
                <button className="btn btn-danger btn-small" onClick={() => remove(p)} aria-label={`Delete ${p.name}`}>Delete</button>
              </div>
            ))}
          </div>
        </section>
        <LegendPlate />
      </main>
    </div>
  );
}
