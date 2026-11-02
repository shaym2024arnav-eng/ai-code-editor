import { NodeLink } from "../components/ui.jsx";

const file = (path) => ({ type: "file", path });

function Group({ title, hint, items, render }) {
  if (!items || !items.length) return null;
  return (
    <div className="section">
      <h3>{title} <span className="muted" style={{ fontWeight: 400 }}>({items.length})</span></h3>
      {hint && <p className="panel-note">{hint}</p>}
      <ul className="list">{items.map((item, i) => <li key={i}>{render(item)}</li>)}</ul>
    </div>
  );
}

export default function HealthPanel({ graph, onOpen }) {
  if (!graph) return <div className="panel"><p className="panel-note">Loading the code map…</p></div>;
  const ins = graph.insights || {};
  const total = ["brokenImports", "cycles", "unmatchedRequests", "largeFunctions", "unusedExports", "orphanFiles"]
    .reduce((n, k) => n + (ins[k] || []).length, 0) + (graph.parseErrors || []).length;

  return (
    <div className="panel">
      <div className="section">
        <h3>Project health</h3>
        <p className="panel-note">
          {total ? "Found by reading the code map, without AI. Click an item to open it." : "No problems found in the code map."}
        </p>
      </div>

      <Group title="Imports that will break" items={ins.brokenImports}
        hint="Paths that don't match a file. A case mismatch works on Windows and macOS but fails on Linux servers, so it breaks deploys."
        render={(b) => (
          <>
            <NodeLink node={{ ...file(b.path), line: b.line }} onOpen={onOpen} />
            <div className="panel-note" style={{ paddingLeft: 14 }}>
              "{b.source}"{b.caseMismatch ? ` should match ${b.caseMismatch}` : " has no matching file"}
            </div>
          </>
        )} />

      <Group title="Files that don't parse" items={graph.parseErrors}
        render={(p) => (<><NodeLink node={file(p.path)} onOpen={onOpen} /><div className="panel-note" style={{ paddingLeft: 14 }}>{p.message}</div></>)} />

      <Group title="Import cycles" items={ins.cycles}
        hint="Files that import each other. Cycles cause undefined values at startup and make code hard to split."
        render={(c) => <div style={{ display: "grid", gap: 2 }}>{c.map((p) => <NodeLink key={p} node={file(p)} onOpen={onOpen} />)}</div>} />

      <Group title="Requests with no matching route" items={ins.unmatchedRequests}
        hint="Frontend calls whose URL doesn't match any backend route found in this project."
        render={(r) => (<><NodeLink node={{ ...file(r.file), line: r.line }} onOpen={onOpen} /><div className="panel-note" style={{ paddingLeft: 14 }}>{r.method} {r.url}</div></>)} />

      <Group title="Long functions" items={ins.largeFunctions}
        hint="Over 60 lines. Good candidates for the readability goal."
        render={(f) => <NodeLink node={{ type: "function", name: `${f.name}`, path: f.path, line: f.startLine }} onOpen={onOpen} />} />

      <Group title="Possibly unused exports" items={ins.unusedExports}
        render={(u) => <NodeLink node={{ type: "function", name: u.name, path: u.path }} onOpen={onOpen} />} />

      <Group title="Files nothing imports" items={ins.orphanFiles}
        hint="Not imported anywhere and not an entry point. Often dead code, or a broken import."
        render={(p) => <NodeLink node={file(p)} onOpen={onOpen} />} />

      <Group title="Most depended-on files" items={ins.hubs}
        hint="Changes here have the widest reach."
        render={(h) => (<><NodeLink node={file(h.path)} onOpen={onOpen} /> <span className="muted">imported by {h.importedBy}</span></>)} />

      <Group title="External services called" items={ins.externalRequests}
        render={(r) => (<><NodeLink node={{ ...file(r.file), line: r.line }} onOpen={onOpen} /> <span className="muted">{r.external}</span></>)} />
    </div>
  );
}
