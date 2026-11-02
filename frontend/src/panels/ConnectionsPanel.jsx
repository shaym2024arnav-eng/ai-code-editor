import { NodeLink, Spinner } from "../components/ui.jsx";

const fileNode = (path) => ({ type: "file", path });

function Section({ title, children, empty }) {
  const items = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  if (!items || (Array.isArray(items) && items.length === 0)) {
    return empty ? (
      <div className="section"><h3>{title}</h3><p className="panel-note">{empty}</p></div>
    ) : null;
  }
  return <div className="section"><h3>{title}</h3>{items}</div>;
}

const RISK_TEXT = {
  low: "Low risk to change: few or no other files depend on it.",
  medium: "Medium risk: other files or API routes depend on it.",
  high: "High risk: many files or routes depend on it. Change exports carefully.",
};

export default function ConnectionsPanel({ path, analyzable, impact, loading, error, onOpen }) {
  if (!path) return <div className="panel"><p className="panel-note">Open a file to see what it connects to.</p></div>;
  if (!analyzable) return <div className="panel"><p className="panel-note">Connections are mapped for JavaScript and TypeScript files.</p></div>;
  if (loading && !impact) return <div className="panel"><p className="muted"><Spinner /> Tracing connections</p></div>;
  if (error) return <div className="panel"><p className="error-text">{error}</p></div>;
  if (!impact) return null;

  const NOTE_TEXT = {
    cycle: (n) => `Part of an import cycle: ${n.files.join(" → ")}.`,
    "broken-import": (n) => n.caseMismatch
      ? `Imports "${n.source}" on line ${n.line}, but the file is ${n.caseMismatch}. This works on Windows and macOS but fails on Linux servers.`
      : `Imports "${n.source}" on line ${n.line}, which doesn't exist in the project.`,
    "large-function": (n) => `${n.name}() is ${n.lines} lines long. Consider splitting it.`,
    "unused-export": (n) => `Exports ${n.name}, which no file in the project seems to import.`,
  };

  return (
    <div className="panel">
      <div className="section">
        <header style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <h3 style={{ flex: 1 }}>Change impact</h3>
          <span className={`tag risk-${impact.risk}`}>{impact.risk} risk</span>
        </header>
        <p className="panel-note">
          {RISK_TEXT[impact.risk]} {impact.summary.transitiveDependents} file{impact.summary.transitiveDependents === 1 ? "" : "s"} depend on this one, directly or indirectly.
        </p>
      </div>

      {impact.notes.length > 0 && (
        <div className="section">
          <h3>Worth fixing</h3>
          <ul className="list">{impact.notes.map((n, i) => <li key={i} className="callout warn">{NOTE_TEXT[n.type](n)}</li>)}</ul>
        </div>
      )}

      <Section title="Used by" empty="Nothing in the project imports this file.">
        {impact.directImporters.map((p) => <div key={p}><NodeLink node={fileNode(p)} onOpen={onOpen} /></div>)}
        {impact.transitiveDependents.length > impact.directImporters.length && (
          <p key="more" className="panel-note">
            And {impact.transitiveDependents.length - impact.directImporters.length} more through those files.
          </p>
        )}
      </Section>

      <Section title="Depends on" empty="No project files or packages.">
        {impact.importsFiles.map((p) => <div key={p}><NodeLink node={fileNode(p)} onOpen={onOpen} /></div>)}
        {impact.importsPackages.length > 0 && (
          <p key="pkgs" className="panel-note">Packages: {impact.importsPackages.join(", ")}</p>
        )}
      </Section>

      <Section title="API routes defined here">
        {impact.routesDefined.map((r) => (
          <div key={r.id} className="fn-row">
            <header><NodeLink node={r} onOpen={onOpen} /></header>
            {r.clients.length
              ? r.clients.map((c) => <div key={c.id} style={{ paddingLeft: 12 }}><span className="muted">called from </span><NodeLink node={c} onOpen={onOpen} /></div>)
              : <span className="panel-note" style={{ paddingLeft: 12 }}>No frontend call found in this project.</span>}
          </div>
        ))}
      </Section>

      <Section title="Backend routes this file calls">
        {impact.requestsMade.map((r) => (
          <div key={r.id} className="fn-row">
            <header><NodeLink node={r} onOpen={onOpen} /></header>
            {r.handler && <div style={{ paddingLeft: 12 }}><span className="muted">handled by </span><NodeLink node={r.handler} onOpen={onOpen} /></div>}
          </div>
        ))}
        {impact.unmatchedRequests.map((r) => (
          <p key={`${r.method}${r.url}${r.line}`} className="panel-note">
            {r.method} {r.url} on line {r.line}{r.external ? ` goes to ${r.external}` : " doesn't match any route in the project"}.
          </p>
        ))}
      </Section>

      <Section title="Data models">
        {impact.modelsDefined.map((m) => (
          <div key={m.id}>
            <NodeLink node={m} onOpen={onOpen} /> <span className="muted">is defined here and used by {impact.modelUsers.length} function{impact.modelUsers.length === 1 ? "" : "s"}</span>
            {impact.modelUsers.map((u) => <div key={u.id} style={{ paddingLeft: 12 }}><NodeLink node={u} onOpen={onOpen} /></div>)}
          </div>
        ))}
        {impact.modelsUsed.map((m) => <div key={m.id}><span className="muted">Uses </span><NodeLink node={m} onOpen={onOpen} /></div>)}
      </Section>

      <Section title={`Functions (${impact.functions.length})`} empty="No functions found.">
        {impact.functions.map((f) => (
          <div key={f.name} className="fn-row">
            <header>
              <button type="button" className="node-link" onClick={() => onOpen(path, f.startLine)}>
                <span className="nl-kind k-function" aria-hidden="true" />
                <span className="nl-text mono">{f.kind === "handler" ? f.name : `${f.name}()`}</span>
              </button>
              <span className="muted" style={{ fontSize: 12 }}>{f.lines} lines{f.exported ? ", exported" : ""}</span>
            </header>
            {f.externalCallers.length > 0 && (
              <div style={{ paddingLeft: 12, display: "grid", gap: 2 }}>
                <span className="muted" style={{ fontSize: 12 }}>Used by</span>
                {f.externalCallers.map((c) => <NodeLink key={c.id} node={c} onOpen={onOpen} />)}
              </div>
            )}
            {f.callees.length > 0 && (
              <div style={{ paddingLeft: 12, display: "grid", gap: 2 }}>
                <span className="muted" style={{ fontSize: 12 }}>Calls</span>
                {f.callees.map((c) => <NodeLink key={c.id} node={c} onOpen={onOpen} />)}
              </div>
            )}
          </div>
        ))}
      </Section>
    </div>
  );
}
