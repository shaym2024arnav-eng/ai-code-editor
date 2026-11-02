import { useMemo, useState } from "react";
import { isAnalyzable } from "../upload.js";

function buildTree(paths) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { name: part, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    });
    node.files.push({ name: parts[parts.length - 1], path: p });
  }
  return root;
}

export default function FileTree({ files, activePath, onOpen, problemPaths }) {
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState(() => new Set());

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, query]);
  const tree = useMemo(() => buildTree(filtered.map((f) => f.path)), [filtered]);

  const toggle = (path) => setClosed((s) => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  const rows = [];
  const walk = (node, depth) => {
    [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((dir) => {
      const open = query || !closed.has(dir.path);
      rows.push(
        <button key={`d:${dir.path}`} className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => toggle(dir.path)} aria-expanded={Boolean(open)}>
          <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
          <span className="label">{dir.name}</span>
        </button>
      );
      if (open) walk(dir, depth + 1);
    });
    node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => {
      rows.push(
        <button key={`f:${file.path}`} className="tree-row" style={{ paddingLeft: 20 + depth * 12 }}
          aria-current={file.path === activePath} onClick={() => onOpen(file.path)} title={file.path}>
          <span className={`dot ${isAnalyzable(file.path) ? "code" : ""}`} aria-hidden="true" />
          <span className="label">{file.name}</span>
          {problemPaths.has(file.path) && <span className="badge" title="Has a problem in Health">●</span>}
        </button>
      );
    });
  };
  walk(tree, 0);

  return (
    <nav className="sidebar" aria-label="Project files">
      <div className="sidebar-search">
        <input className="input" type="search" placeholder="Find a file" value={query}
          onChange={(e) => setQuery(e.target.value)} aria-label="Find a file" />
      </div>
      <div className="tree">
        {rows.length ? rows : <p className="muted" style={{ padding: "8px 12px" }}>No files match.</p>}
      </div>
    </nav>
  );
}
