import { lazy, Suspense, useEffect, useState } from "react";
import Home from "./components/Home.jsx";
import { Spinner, ToastProvider, useTheme } from "./components/ui.jsx";

// The workspace pulls in Monaco and the graph library, so load it only when needed.
const Workspace = lazy(() => import("./components/Workspace.jsx"));

// Minimal hash routing: "#/p/<projectId>" opens a project, anything else is home.
const readRoute = () => {
  const m = window.location.hash.match(/^#\/p\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
};

export default function App() {
  const [projectId, setProjectId] = useState(readRoute);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    const onHash = () => setProjectId(readRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openProject = (id) => { window.location.hash = `#/p/${encodeURIComponent(id)}`; };
  const goHome = () => { window.location.hash = ""; };

  return (
    <ToastProvider>
      {projectId ? (
        <Suspense fallback={<div className="empty-state" style={{ height: "100%" }}><p><Spinner /> Opening project</p></div>}>
          <Workspace key={projectId} projectId={projectId} onHome={goHome} theme={theme} onToggleTheme={toggle} />
        </Suspense>
      ) : (
        <Home onOpen={openProject} theme={theme} onToggleTheme={toggle} />
      )}
    </ToastProvider>
  );
}
