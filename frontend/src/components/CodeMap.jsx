import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType, Handle, Position } from "@xyflow/react";
import * as dagre from "@dagrejs/dagre";

const NODE_W = 200;
const NODE_H = 52;
const MAX_FILES_VIEW = 250;

const basename = (p) => p.split("/").pop();
const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

function DraftNode({ data }) {
  return (
    <div className={`dt-node ${data.kind} ${data.focus ? "focus" : ""} ${data.warn ? "warn" : ""}`} title={data.title}>
      <Handle type="target" position={data.vertical ? Position.Top : Position.Left} />
      <div className="kind">{data.kindLabel}</div>
      <div className="name">{data.name}</div>
      {data.sub && <div className="sub">{data.sub}</div>}
      <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} />
    </div>
  );
}
const nodeTypes = { draft: DraftNode };

function layout(nodes, edges, direction) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 22, ranksep: direction === "LR" ? 90 : 60, marginx: 20, marginy: 70 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } };
  });
}

function toFlowNode(node, { focus, warn, vertical }) {
  const base = { id: node.id, type: "draft", position: { x: 0, y: 0 } };
  const data = { kind: node.type, focus, warn, vertical, title: node.id };
  if (node.type === "file") Object.assign(data, { kindLabel: "File", name: basename(node.path), sub: dirname(node.path) });
  if (node.type === "function") Object.assign(data, { kindLabel: node.kind === "handler" ? "Route handler" : node.kind === "class" ? "Class" : "Function", name: node.kind === "handler" ? "inline handler" : `${node.name}()`, sub: node.path });
  if (node.type === "route") Object.assign(data, { kindLabel: "Route", name: `${node.method} ${node.path}`, sub: node.file });
  if (node.type === "model") Object.assign(data, { kindLabel: "Data model", name: node.name, sub: node.path });
  if (node.type === "package") Object.assign(data, { kindLabel: "Package", name: node.name });
  return { ...base, data };
}

const EDGE_STYLE = {
  imports: { stroke: "var(--rule-strong)" },
  calls: { stroke: "var(--fn)" },
  renders: { stroke: "var(--fn)", strokeDasharray: "2 3" },
  requests: { stroke: "var(--route)", strokeDasharray: "5 4" },
  handles: { stroke: "var(--route)" },
  middleware: { stroke: "var(--route)", strokeDasharray: "2 3" },
  "uses-model": { stroke: "var(--model)" },
  defines: { stroke: "var(--faint)" },
  contains: { stroke: "var(--rule)" },
};
const EDGE_LABEL = { requests: "requests", handles: "handled by", middleware: "middleware", "uses-model": "uses", renders: "renders", calls: "calls", defines: "defines", imports: "imports" };

// SVG markers can't read CSS variables, so resolve them to real colors.
const cssVar = (value) => {
  const m = /^var\((--[\w-]+)\)$/.exec(value || "");
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || value : value;
};

function toFlowEdge(e, showLabel) {
  const raw = EDGE_STYLE[e.type] || {};
  const style = { strokeWidth: 1.4, ...raw, stroke: cssVar(raw.stroke) };
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "smoothstep",
    style,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: style.stroke },
    label: showLabel ? EDGE_LABEL[e.type] : undefined,
    labelStyle: { fill: "var(--muted)", fontSize: 10.5 },
    labelBgStyle: { fill: "var(--base)" },
    labelBgPadding: [3, 2],
  };
}

function buildView(graph, mode, activePath, showPackages) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const warnFiles = new Set([
    ...(graph.insights?.brokenImports || []).map((b) => b.path),
    ...(graph.parseErrors || []).map((p) => p.path),
    ...(graph.insights?.cycles || []).flat(),
  ]);

  if (mode === "files") {
    let fileNodes = graph.nodes.filter((n) => n.type === "file" && n.lines !== null);
    const truncated = fileNodes.length > MAX_FILES_VIEW;
    if (truncated) fileNodes = fileNodes.slice(0, MAX_FILES_VIEW);
    const ids = new Set(fileNodes.map((n) => n.id));
    const pkgEdges = showPackages ? graph.edges.filter((e) => e.type === "imports" && ids.has(e.source) && e.target.startsWith("pkg:") && !byId.get(e.target).builtin) : [];
    const pkgIds = new Set(pkgEdges.map((e) => e.target));
    const nodes = [...fileNodes, ...[...pkgIds].map((id) => byId.get(id))];
    const edges = [...graph.edges.filter((e) => e.type === "imports" && ids.has(e.source) && ids.has(e.target)), ...pkgEdges];
    return {
      nodes: nodes.map((n) => toFlowNode(n, { focus: n.path === activePath, warn: warnFiles.has(n.path), vertical: true })),
      edges: edges.map((e) => toFlowEdge(e, false)),
      direction: "TB",
      note: truncated ? `Showing the first ${MAX_FILES_VIEW} files.` : null,
    };
  }

  if (mode === "focus") {
    const fid = `file:${activePath}`;
    if (!activePath || !byId.has(fid)) return { nodes: [], edges: [], direction: "LR", empty: "Open a JavaScript or TypeScript file to focus the map on it." };
    const keep = new Set([fid]);
    const keepEdges = [];
    const own = new Set(graph.edges.filter((e) => e.type === "contains" && e.source === fid).map((e) => e.target));
    own.forEach((id) => keep.add(id));
    const mine = new Set([fid, ...own]);
    for (const e of graph.edges) {
      if (e.type === "contains") continue;
      const touches = mine.has(e.source) || mine.has(e.target);
      if (!touches) continue;
      if (e.type === "imports" && e.target.startsWith("pkg:") && !showPackages) continue;
      if (e.type === "imports" && byId.get(e.target)?.builtin) continue;
      keep.add(e.source);
      keep.add(e.target);
      keepEdges.push(e);
    }
    // Show which file each outside function lives in, through its route handlers.
    const nodes = [...keep].map((id) => byId.get(id)).filter(Boolean);
    const edges = [
      ...keepEdges,
      ...[...own].map((id) => ({ id: `c-${id}`, source: fid, target: id, type: "contains" })),
    ];
    return {
      nodes: nodes.map((n) => toFlowNode(n, { focus: n.id === fid, warn: n.type === "file" && warnFiles.has(n.path), vertical: false })),
      edges: edges.map((e) => toFlowEdge(e, e.type !== "contains")),
      direction: "LR",
    };
  }

  // API flow: client function -> route -> handler (and middleware) -> data model
  const routeIds = new Set(graph.nodes.filter((n) => n.type === "route").map((n) => n.id));
  if (!routeIds.size) return { nodes: [], edges: [], direction: "LR", empty: "No Express routes were found in this project." };
  const keep = new Set(routeIds);
  const edges = [];
  const handlers = new Set();
  for (const e of graph.edges) {
    if (e.type === "requests" && routeIds.has(e.target)) { keep.add(e.source); edges.push(e); }
    if ((e.type === "handles" || e.type === "middleware") && routeIds.has(e.source)) { keep.add(e.target); edges.push(e); handlers.add(e.target); }
  }
  for (const e of graph.edges) {
    if (e.type === "uses-model" && handlers.has(e.source)) { keep.add(e.target); edges.push(e); }
  }
  const nodes = [...keep].map((id) => byId.get(id)).filter(Boolean);
  return {
    nodes: nodes.map((n) => toFlowNode(n, { focus: (n.path || n.file) === activePath, vertical: false })),
    edges: edges.map((e) => toFlowEdge(e, false)),
    direction: "LR",
  };
}

const MODES = [
  { id: "focus", label: "This file" },
  { id: "api", label: "API flow" },
  { id: "files", label: "All files" },
];

export default function CodeMap({ graph, activePath, onOpen, theme }) {
  const [mode, setMode] = useState(activePath ? "focus" : "api");
  const [showPackages, setShowPackages] = useState(false);

  const view = useMemo(() => {
    if (!graph) return null;
    const v = buildView(graph, mode, activePath, showPackages);
    return { ...v, nodes: v.nodes.length ? layout(v.nodes, v.edges, v.direction) : [] };
    // theme is a dependency so edge colors are re-resolved after a theme switch
  }, [graph, mode, activePath, showPackages, theme]);

  const byId = useMemo(() => new Map((graph?.nodes || []).map((n) => [n.id, n])), [graph]);

  if (!graph) return <div className="empty-state">Drawing the code map…</div>;

  const onNodeClick = (_, flowNode) => {
    const n = byId.get(flowNode.id);
    if (!n) return;
    const path = n.type === "route" ? n.file : n.path;
    if (path) onOpen(path, n.startLine || n.line);
  };

  return (
    <div className="map-wrap">
      <div className="map-toolbar">
        <div className="segmented" role="group" aria-label="Map view">
          {MODES.map((m) => (
            <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        {mode !== "api" && (
          <label className="check" style={{ background: "var(--panel)", padding: "4px 8px", borderRadius: 4, border: "1px solid var(--rule)" }}>
            <input type="checkbox" checked={showPackages} onChange={(e) => setShowPackages(e.target.checked)} /> Packages
          </label>
        )}
        <div className="map-legend" aria-hidden="true">
          <span><i className="nl-kind k-file" /> File</span>
          <span><i className="nl-kind k-function" /> Function</span>
          <span><i className="nl-kind k-route" /> Route</span>
          <span><i className="nl-kind k-model" /> Model</span>
        </div>
        {view.note && <span className="muted" style={{ fontSize: 12 }}>{view.note}</span>}
      </div>
      {view.empty ? (
        <div className="empty-state"><p>{view.empty}</p></div>
      ) : (
        <ReactFlow
          key={`${mode}:${activePath}:${showPackages}`}
          nodes={view.nodes}
          edges={view.edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
          minZoom={0.1}
          colorMode={theme === "light" ? "light" : "dark"}
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  );
}
