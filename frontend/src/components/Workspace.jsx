import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { isAnalyzable } from "../upload.js";
import { Spinner, useToast } from "./ui.jsx";
import FileTree from "./FileTree.jsx";
import CodeMap from "./CodeMap.jsx";
import { CodeEditor, ReviewEditor } from "./CodeEditor.jsx";
import ImprovePanel from "../panels/ImprovePanel.jsx";
import ConnectionsPanel from "../panels/ConnectionsPanel.jsx";
import MemoryPanel from "../panels/MemoryPanel.jsx";
import AskPanel from "../panels/AskPanel.jsx";
import HealthPanel from "../panels/HealthPanel.jsx";

const INSPECTOR_TABS = [
  { id: "improve", label: "Improve" },
  { id: "connections", label: "Connections" },
  { id: "memory", label: "Decisions" },
  { id: "ask", label: "Ask" },
  { id: "health", label: "Health" },
];

// Pick a sensible first file to open: the frontend App, a server entry, or a README.
function firstFile(files) {
  const prefs = [/(^|\/)src\/App\.[jt]sx?$/, /(^|\/)(server|app|index)\.[jt]s$/, /(^|\/)README\.md$/i];
  for (const re of prefs) {
    const hit = files.find((f) => re.test(f.path));
    if (hit) return hit.path;
  }
  return files[0]?.path || null;
}

export default function Workspace({ projectId, onHome, theme, onToggleTheme }) {
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [files, setFiles] = useState([]);
  const [graph, setGraph] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [improvements, setImprovements] = useState([]);
  const [goals, setGoals] = useState([]);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [file, setFile] = useState(null); // { path, content, hash }
  const [draft, setDraft] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [reveal, setReveal] = useState(null);
  const [selection, setSelection] = useState(null);
  const [saving, setSaving] = useState(false);

  const [centerTab, setCenterTab] = useState("code");
  const [inspectorTab, setInspectorTab] = useState("improve");
  const [mobilePane, setMobilePane] = useState("center");

  const [pending, setPending] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const modifiedRef = useRef(null);

  const [impact, setImpact] = useState(null);
  const [impactState, setImpactState] = useState({ loading: false, error: "" });

  const path = file?.path || null;
  const dirty = file ? draft !== file.content : false;

  const refreshGraph = useCallback(() => api.graph(projectId).then((r) => { setGraph(r.graph); setProject((p) => (p ? { ...p, stats: r.stats } : p)); }), [projectId]);
  const refreshDecisions = useCallback(() => api.decisions(projectId).then((r) => setDecisions(r.decisions)), [projectId]);
  const refreshImprovements = useCallback(() => api.improvements(projectId).then((r) => setImprovements(r.improvements)), [projectId]);

  const openFile = useCallback(async (nextPath, line) => {
    if (!nextPath) return;
    setMobilePane("center");
    setCenterTab("code");
    if (file && nextPath === file.path) {
      if (line) setReveal({ line, at: Date.now() });
      return;
    }
    if (dirty && !window.confirm(`Discard unsaved changes to ${file.path}?`)) return;
    if (pending && !window.confirm("Leave the suggestion you're reviewing? It stays saved under earlier suggestions.")) return;
    setPending(null);
    setFileLoading(true);
    try {
      const { file: f } = await api.getFile(projectId, nextPath);
      setFile(f);
      setDraft(f.content);
      setSelection(null);
      setReveal(line ? { line, at: Date.now() } : null);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setFileLoading(false);
    }
  }, [projectId, file, dirty, pending, toast]);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [detail, g, d, imps, gl, health] = await Promise.all([
          api.getProject(projectId), api.graph(projectId), api.decisions(projectId), api.improvements(projectId),
          api.goals().catch(() => ({ goals: [] })), api.health().catch(() => ({ ai: { enabled: true } })),
        ]);
        if (cancelled) return;
        setProject(detail.project);
        setFiles(detail.files);
        setGraph(g.graph);
        setDecisions(d.decisions);
        setImprovements(imps.improvements);
        setGoals(gl.goals);
        setAiEnabled(Boolean(health.ai?.enabled));
        const start = firstFile(detail.files);
        if (start) {
          const { file: f } = await api.getFile(projectId, start);
          if (!cancelled) { setFile(f); setDraft(f.content); }
        }
      } catch (e) {
        if (!cancelled) setLoadError(e.status === 404 ? "This project doesn't exist, or it belongs to another browser." : e.message);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // Connections for the open file, refreshed whenever the code map changes.
  useEffect(() => {
    if (!path || !isAnalyzable(path) || !graph) { setImpact(null); return; }
    let cancelled = false;
    setImpactState({ loading: true, error: "" });
    api.impact(projectId, path)
      .then((r) => { if (!cancelled) { setImpact(r.impact); setImpactState({ loading: false, error: "" }); } })
      .catch((e) => { if (!cancelled) { setImpact(null); setImpactState({ loading: false, error: e.status === 404 ? "" : e.message }); } });
    return () => { cancelled = true; };
  }, [projectId, path, graph]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!file || !dirty || saving) return;
    setSaving(true);
    try {
      const res = await api.saveFile(projectId, file.path, draft, file.hash);
      setFile(res.file);
      toast(`Saved ${file.path.split("/").pop()}. Code map updated.`, "success");
      refreshGraph();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  }, [file, dirty, saving, projectId, draft, toast, refreshGraph]);

  const improve = async (params) => {
    if (dirty) { toast("Save your changes first. Suggestions are based on the saved file.", "error"); return; }
    setAiBusy(true);
    try {
      const res = await api.improve(projectId, { path, ...params });
      setPending(res.improvement);
      setCenterTab("code");
      setMobilePane("inspector");
      refreshImprovements();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setAiBusy(false);
    }
  };

  const accept = async (decision) => {
    if (!pending) return;
    setAiBusy(true);
    try {
      const updatedCode = modifiedRef.current ? modifiedRef.current() : pending.updatedCode;
      const res = await api.accept(projectId, pending.id, { updatedCode, decision: decision || undefined });
      setFile(res.file);
      setDraft(res.file.content);
      setPending(null);
      modifiedRef.current = null;
      toast(res.decision ? "Changes applied and decision saved." : "Changes applied.", "success");
      refreshGraph();
      refreshImprovements();
      if (res.decision) refreshDecisions();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setAiBusy(false);
    }
  };

  const reject = async () => {
    if (!pending) return;
    setAiBusy(true);
    try {
      await api.reject(projectId, pending.id);
      setPending(null);
      modifiedRef.current = null;
      refreshImprovements();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setAiBusy(false);
    }
  };

  const exportZip = async () => {
    try {
      const res = await api.exportZip(projectId);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project.name.replace(/[^\w.-]+/g, "-")}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const problemPaths = useMemo(() => new Set([
    ...(graph?.insights?.brokenImports || []).map((b) => b.path),
    ...(graph?.parseErrors || []).map((p) => p.path),
  ]), [graph]);

  const historyForFile = improvements.filter((i) => i.path === path && i.id !== pending?.id).slice(0, 6);

  if (loadError) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div>
          <h2>Can't open this project</h2>
          <p>{loadError}</p>
          <button className="btn btn-primary" onClick={onHome}>Back to projects</button>
        </div>
      </div>
    );
  }
  if (!project) return <div className="empty-state" style={{ height: "100%" }}><p><Spinner /> Opening project</p></div>;

  const s = project.stats;

  return (
    <div className="ws">
      <header className="ws-header">
        <button className="btn btn-ghost btn-small" onClick={onHome}>All projects</button>
        <span className="title">{project.name}</span>
        <span className="stats">{s.analyzedFiles} JS/TS files, {s.functions} functions, {s.routes} routes, {s.models} models</span>
        <span className="spacer" />
        <button className="btn btn-small" onClick={exportZip}>Download zip</button>
        <button className="btn btn-ghost btn-small" onClick={onToggleTheme}>{theme === "dark" ? "Light" : "Dark"}</button>
      </header>

      <div className="mobile-tabs" role="tablist" aria-label="Panes">
        {[["files", "Files"], ["center", "Code"], ["inspector", "Inspector"]].map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mobilePane === id} onClick={() => setMobilePane(id)}>{label}</button>
        ))}
      </div>

      <div className="ws-body">
        <div className="pane-files" data-pane data-active={mobilePane === "files"}>
          <FileTree files={files} activePath={path} onOpen={(p) => openFile(p)} problemPaths={problemPaths} />
        </div>

        <main className="center" data-pane data-active={mobilePane === "center"}>
          <div className="center-tabs" role="tablist" aria-label="View">
            <button role="tab" aria-selected={centerTab === "code"} onClick={() => setCenterTab("code")}>
              {pending ? "Review" : "Code"}
            </button>
            <button role="tab" aria-selected={centerTab === "map"} onClick={() => setCenterTab("map")}>Code map</button>
            {path && centerTab === "code" && (
              <div className="path">
                {dirty && <span className="dirty-dot" title="Unsaved changes" />}
                <span title={path}>{path}</span>
                {!pending && (
                  <button className="btn btn-small" onClick={save} disabled={!dirty || saving} title="Save (Ctrl+S)">
                    {saving ? <Spinner /> : "Save"}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="editor-wrap" style={{ display: "grid", gridTemplateRows: pending && centerTab === "code" ? "auto 1fr" : "1fr" }}>
            {centerTab === "map" ? (
              <CodeMap graph={graph} activePath={path} onOpen={openFile} theme={theme} />
            ) : pending ? (
              <>
                <div className="diff-bar">
                  <p>Reviewing a suggestion: added lines are green, removed lines are red. You can edit the suggested code before you accept it.</p>
                  <button className="btn btn-small" onClick={() => setInspectorTab("improve")}>See details</button>
                </div>
                <ReviewEditor key={pending.id} reviewId={pending.id} path={pending.path} original={pending.originalCode} modified={pending.updatedCode}
                  theme={theme} modifiedRef={modifiedRef} />
              </>
            ) : fileLoading ? (
              <div className="empty-state"><p><Spinner /> Opening file</p></div>
            ) : file ? (
              <CodeEditor path={file.path} value={draft} onChange={setDraft} onSave={save} onSelection={setSelection}
                theme={theme} reveal={reveal} />
            ) : (
              <div className="empty-state"><div><h2>Pick a file</h2><p>Choose a file on the left, or open the code map.</p></div></div>
            )}
          </div>
        </main>

        <aside className="inspector" data-pane data-active={mobilePane === "inspector"} aria-label="Inspector">
          <div className="inspector-tabs" role="tablist">
            {INSPECTOR_TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={inspectorTab === t.id} onClick={() => setInspectorTab(t.id)}>
                {t.label}{t.id === "memory" && decisions.filter((d) => d.status === "active").length ? ` (${decisions.filter((d) => d.status === "active").length})` : ""}
              </button>
            ))}
          </div>
          {inspectorTab === "improve" && (
            !aiEnabled ? (
              <div className="panel"><p className="panel-note">AI suggestions are off until GEMINI_API_KEY is set on the server. The code map, connections and health checks still work.</p></div>
            ) : (
              <ImprovePanel path={path} analyzable={path ? isAnalyzable(path) : false} selection={selection} goals={goals}
                pending={pending} busy={aiBusy} history={historyForFile} onImprove={improve} onAccept={accept} onReject={reject} />
            )
          )}
          {inspectorTab === "connections" && (
            <ConnectionsPanel path={path} analyzable={path ? isAnalyzable(path) : false} impact={impact}
              loading={impactState.loading} error={impactState.error} onOpen={openFile} />
          )}
          {inspectorTab === "memory" && (
            <MemoryPanel projectId={projectId} decisions={decisions} onChange={refreshDecisions} activePath={path} aiEnabled={aiEnabled} />
          )}
          {inspectorTab === "ask" && <AskPanel projectId={projectId} path={path} aiEnabled={aiEnabled} />}
          {inspectorTab === "health" && <HealthPanel graph={graph} onOpen={openFile} />}
        </aside>
      </div>
    </div>
  );
}
