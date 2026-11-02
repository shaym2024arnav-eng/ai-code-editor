import { useEffect, useState } from "react";
import { Spinner } from "../components/ui.jsx";

const FALLBACK_GOALS = [
  { id: "readability", label: "Readability" },
  { id: "performance", label: "Performance" },
  { id: "security", label: "Security" },
  { id: "maintainability", label: "Maintainability" },
  { id: "bugs", label: "Find & fix bugs" },
  { id: "types", label: "Types & docs" },
  { id: "custom", label: "Custom goal" },
];

const STATUS_TEXT = { respected: "Respected", conflict: "Conflict", "not-applicable": "Not relevant" };

function Review({ improvement, busy, onAccept, onReject }) {
  const { result, checks } = improvement;
  const [remember, setRemember] = useState(Boolean(result.suggestedDecision));
  const [draft, setDraft] = useState(result.suggestedDecision || { title: "", decision: "", rationale: "" });

  useEffect(() => {
    setRemember(Boolean(result.suggestedDecision));
    setDraft(result.suggestedDecision || { title: "", decision: "", rationale: "" });
  }, [improvement.id, result.suggestedDecision]);

  const blocking = !checks.syntaxOk;
  const accept = () => onAccept(remember && draft.title.trim() && draft.decision.trim() ? draft : null);

  return (
    <>
      <div className="section">
        <header style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <h3 style={{ flex: 1 }}>Suggestion</h3>
          <span className={`tag risk-${result.riskLevel}`}>{result.riskLevel} risk</span>
        </header>
        <p style={{ margin: 0 }}>{result.summary || "No summary was returned."}</p>
        {checks.identical && <p className="panel-note">No changes were needed for this goal.</p>}
      </div>

      {(checks.warnings.length > 0 || checks.syntaxOk) && (
        <div className="section">
          <h3>Automatic checks</h3>
          {checks.warnings.length ? (
            <div className="callout warn">
              Review these before accepting:
              <ul>{checks.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          ) : (
            <div className="callout ok">
              The new code parses, keeps every export other files use, and keeps exported function signatures.
            </div>
          )}
        </div>
      )}

      {result.changes.length > 0 && (
        <div className="section">
          <h3>What changed</h3>
          <ul className="list">
            {result.changes.map((c, i) => (
              <li key={i} className="change">
                <strong>{c.title}</strong>
                <p>{c.explanation}</p>
                <span className="muted" style={{ fontSize: 12 }}>{c.category}{c.lineHint ? `, around line ${c.lineHint}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.impactNotes.length > 0 && (
        <div className="section">
          <h3>Other files to check</h3>
          <ul className="list">{result.impactNotes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}

      {result.decisionChecks.length > 0 && (
        <div className="section">
          <h3>Your decisions</h3>
          <ul className="list">
            {result.decisionChecks.map((d) => (
              <li key={d.decisionId}>
                <span className={`tag ${d.status === "conflict" ? "risk-high" : d.status === "respected" ? "risk-low" : ""}`}>{STATUS_TEXT[d.status]}</span>{" "}
                <strong>{d.title}</strong>{d.note ? <span className="muted">. {d.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {improvement.status === "pending" && (
        <div className="section">
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember a decision with this change
          </label>
          {remember && (
            <div style={{ display: "grid", gap: 8 }}>
              <input className="input" placeholder="Short title, e.g. Handlers validate input" value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Decision title" />
              <textarea className="textarea" placeholder="The rule future suggestions must follow" value={draft.decision}
                onChange={(e) => setDraft({ ...draft, decision: e.target.value })} aria-label="Decision" />
              <textarea className="textarea" style={{ minHeight: 48 }} placeholder="Why (optional)" value={draft.rationale}
                onChange={(e) => setDraft({ ...draft, rationale: e.target.value })} aria-label="Why" />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={accept} disabled={busy || blocking}
              title={blocking ? "The suggested code doesn't parse. Fix it in the diff or reject it." : undefined}>
              {busy ? <Spinner /> : null} Accept changes
            </button>
            <button className="btn" onClick={onReject} disabled={busy}>Reject</button>
          </div>
          {blocking && <p className="error-text" style={{ margin: 0 }}>Accept is off because the code doesn't parse. Edit the right side of the diff, or reject.</p>}
        </div>
      )}
    </>
  );
}

export default function ImprovePanel({ path, analyzable, selection, goals, pending, busy, history, onImprove, onAccept, onReject }) {
  const [goal, setGoal] = useState("readability");
  const [instructions, setInstructions] = useState("");
  const [useSelection, setUseSelection] = useState(false);
  const list = goals && goals.length ? goals : FALLBACK_GOALS;

  useEffect(() => { if (!selection) setUseSelection(false); }, [selection]);

  if (!path) return <div className="panel"><p className="panel-note">Open a file to get suggestions for it.</p></div>;

  if (pending) {
    return (
      <div className="panel">
        <Review improvement={pending} busy={busy} onAccept={onAccept} onReject={onReject} />
      </div>
    );
  }

  const canRun = !busy && (goal !== "custom" || instructions.trim());
  const submit = (e) => {
    e.preventDefault();
    if (!canRun) return;
    onImprove({ goal, instructions: instructions.trim() || undefined, selection: useSelection ? selection : undefined });
  };

  return (
    <form className="panel" onSubmit={submit}>
      <div className="section">
        <h3>What should improve?</h3>
        <div className="goal-grid" role="group" aria-label="Goal">
          {list.map((g) => (
            <button type="button" key={g.id} className="goal-chip" aria-pressed={goal === g.id} onClick={() => setGoal(g.id)}
              title={g.focus}>
              {g.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>{goal === "custom" ? "Describe the goal" : "Anything specific? (optional)"}</span>
          <textarea className="textarea" value={instructions} onChange={(e) => setInstructions(e.target.value)} maxLength={2000}
            placeholder={goal === "custom" ? "e.g. Replace callbacks with async/await" : "e.g. Keep the public API the same"} />
        </label>
        {selection && (
          <label className="check">
            <input type="checkbox" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} />
            Only lines {selection.startLine}–{selection.endLine}
          </label>
        )}
        <button className="btn btn-primary" type="submit" disabled={!canRun}>
          {busy ? <><Spinner /> Reading the file and its connections…</> : "Suggest changes"}
        </button>
        <p className="panel-note">
          The model sees this file, the files it connects to in the code map, and the decisions that apply here.
          {!analyzable && " This isn't a JS/TS file, so connections and automatic checks are limited."}
        </p>
      </div>

      {history.length > 0 && (
        <div className="section">
          <h3>Earlier suggestions for this file</h3>
          <ul className="list">
            {history.map((h) => (
              <li key={h.id} style={{ display: "flex", gap: 8 }}>
                <span className={`tag ${h.status === "accepted" ? "risk-low" : h.status === "rejected" ? "" : "risk-medium"}`}>{h.status}</span>
                <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {h.goal}: {h.result?.summary || ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
