import { createContext, useCallback, useContext, useEffect, useState } from "react";

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const Spinner = ({ label = "Loading" }) => <span className="spinner" role="img" aria-label={label} />;

// Theme follows the system until the user picks one.
export function useTheme() {
  const read = () => {
    try { return localStorage.getItem("dt-theme"); } catch { return null; }
  };
  const system = () => (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const [theme, setTheme] = useState(() => {
    const initial = read() || system();
    document.documentElement.dataset.theme = initial;
    return initial;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; // before render, so colors read from CSS are current
    setTheme(next);
    try { localStorage.setItem("dt-theme", next); } catch { /* storage unavailable */ }
  };
  return { theme, toggle };
}

const KIND_LABEL = { file: "File", function: "Function", route: "Route", model: "Model", package: "Package" };

// A clickable reference to a node in the code map (file, function, route, model).
export function NodeLink({ node, onOpen, showPath = true }) {
  if (!node) return null;
  let text;
  if (node.type === "route") text = `${node.method} ${node.path}`;
  else if (node.type === "function") text = showPath ? `${node.name}() in ${node.path}` : `${node.name}()`;
  else if (node.type === "model") text = node.name;
  else if (node.type === "package") text = node.name;
  else text = node.path;
  const target = node.type === "route" ? node.file : node.path;
  const line = node.line || node.startLine;
  return (
    <button type="button" className="node-link" onClick={() => target && onOpen(target, line)} disabled={!target}
      title={`${KIND_LABEL[node.type] || ""}: ${text}`}>
      <span className={`nl-kind k-${node.type}`} aria-hidden="true" />
      <span className="nl-text">{text}</span>
    </button>
  );
}
