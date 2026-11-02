import { useState } from "react";
import { api } from "../api.js";
import { Spinner, useToast } from "../components/ui.jsx";

const parseScope = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);
const folderOf = (path) => (path && path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/` : "");

function DecisionForm({ initial, activePath, onSave, onCancel, saveLabel }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [decision, setDecision] = useState(initial?.decision || "");
  const [rationale, setRationale] = useState(initial?.rationale || "");
  const [scope, setScope] = useState((initial?.scope || []).join(", "));
  const [busy, setBusy] = useState(false);
  const folder = folderOf(activePath);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave({ title: title.trim(), decision: decision.trim(), rationale: rationale.trim(), scope: parseScope(scope) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
      <label className="field"><span>Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required
          placeholder="e.g. Controllers stay thin" />
      </label>
      <label className="field"><span>Decision</span>
        <textarea className="textarea" value={decision} onChange={(e) => setDecision(e.target.value)} required
          placeholder="e.g. Route handlers only parse input and call a service. No database calls in controllers." />
      </label>
      <label className="field"><span>Why (optional)</span>
        <textarea className="textarea" style={{ minHeight: 48 }} value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </label>
      <label className="field"><span>Applies to (folders or patterns, comma separated; empty means the whole project)</span>
        <input className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. backend/, **/*.jsx" />
      </label>
      {folder && !parseScope(scope).includes(folder) && (
        <button type="button" className="btn btn-ghost btn-small" style={{ justifySelf: "start" }}
          onClick={() => setScope(parseScope(scope).concat(folder).join(", "))}>
          Add {folder}
        </button>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !title.trim() || !decision.trim()}>{saveLabel}</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export default function MemoryPanel({ projectId, decisions, onChange, activePath, aiEnabled }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(null);
  const [suggestions, setSuggestions] = useState(null);
  const [suggesting, setSuggesting] = useState(false);

  const guard = async (fn, success) => {
    try {
      await fn();
      if (success) toast(success, "success");
      await onChange();
      return true;
    } catch (e) {
      toast(e.message, "error");
      return false;
    }
  };

  const add = (d, origin = "manual") => guard(() => api.addDecision(projectId, { ...d, origin }), "Decision saved. Future suggestions will follow it.");

  const suggest = async () => {
    setSuggesting(true);
    try {
      const res = await api.suggestDecisions(projectId);
      setSuggestions(res.suggestions);
      if (!res.suggestions.length) toast("No new decisions to suggest.", "info");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setSuggesting(false);
    }
  };

  const active = decisions.filter((d) => d.status === "active");
  const superseded = decisions.filter((d) => d.status !== "active");

  const renderDecision = (d) =>
    editing === d.id ? (
      <div key={d.id} className="decision">
        <DecisionForm initial={d} activePath={activePath} saveLabel="Save changes" onCancel={() => setEditing(null)}
          onSave={async (patch) => { if (await guard(() => api.updateDecision(projectId, d.id, patch), "Decision updated.")) setEditing(null); }} />
      </div>
    ) : (
      <article key={d.id} className={`decision ${d.status}`}>
        <header>
          <strong>{d.title}</strong>
          {d.origin === "ai" && <span className="tag">from a suggestion</span>}
        </header>
        <p>{d.decision}</p>
        {d.rationale && <p className="why">{d.rationale}</p>}
        <footer>
          <span className="muted" style={{ fontSize: 12, flex: 1 }}>{d.scope.length ? d.scope.join(", ") : "Whole project"}</span>
          <button className="btn btn-ghost btn-small" onClick={() => setEditing(d.id)}>Edit</button>
          <button className="btn btn-ghost btn-small"
            onClick={() => guard(() => api.updateDecision(projectId, d.id, { status: d.status === "active" ? "superseded" : "active" }))}>
            {d.status === "active" ? "Retire" : "Restore"}
          </button>
          <button className="btn btn-danger btn-small"
            onClick={() => window.confirm(`Delete "${d.title}"?`) && guard(() => api.deleteDecision(projectId, d.id), "Decision deleted.")}>
            Delete
          </button>
        </footer>
      </article>
    );

  return (
    <div className="panel">
      <div className="section">
        <h3>Architecture decisions</h3>
        <p className="panel-note">
          Rules the AI must follow in every suggestion for the files they apply to. Retired decisions are kept for history but ignored.
        </p>
        {!adding && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={() => setAdding(true)}>Add decision</button>
            <button className="btn" onClick={suggest} disabled={suggesting || !aiEnabled}
              title={aiEnabled ? undefined : "AI is off on this server"}>
              {suggesting ? <><Spinner /> Studying the code map…</> : "Suggest from code"}
            </button>
          </div>
        )}
        {adding && (
          <div className="decision">
            <DecisionForm activePath={activePath} saveLabel="Save decision" onCancel={() => setAdding(false)}
              onSave={async (d) => { if (await add(d)) setAdding(false); }} />
          </div>
        )}
      </div>

      {suggestions && suggestions.length > 0 && (
        <div className="section">
          <h3>Suggested from your code</h3>
          <p className="panel-note">Nothing is saved until you add it.</p>
          {suggestions.map((s, i) => (
            <article key={i} className="decision">
              <header><strong>{s.title}</strong></header>
              <p>{s.decision}</p>
              {s.rationale && <p className="why">{s.rationale}</p>}
              <footer>
                <span className="muted" style={{ fontSize: 12, flex: 1 }}>{s.scope.length ? s.scope.join(", ") : "Whole project"}</span>
                <button className="btn btn-small btn-primary"
                  onClick={async () => { if (await add(s, "ai")) setSuggestions((list) => list.filter((_, j) => j !== i)); }}>
                  Add
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => setSuggestions((list) => list.filter((_, j) => j !== i))}>Dismiss</button>
              </footer>
            </article>
          ))}
        </div>
      )}

      <div className="section">
        {active.length === 0 && !adding && <p className="panel-note">No decisions yet. Add one, or let the AI suggest some from your code.</p>}
        {active.map(renderDecision)}
      </div>
      {superseded.length > 0 && (
        <div className="section">
          <h3>Retired</h3>
          {superseded.map(renderDecision)}
        </div>
      )}
    </div>
  );
}
