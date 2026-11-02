import { useState } from "react";
import Markdown from "react-markdown";
import { api } from "../api.js";
import { Spinner } from "../components/ui.jsx";

const EXAMPLES = [
  "Which files would break if I rename the User model?",
  "How does a request get from the frontend to the database?",
  "Where should I add input validation?",
];

export default function AskPanel({ projectId, path, aiEnabled }) {
  const [question, setQuestion] = useState("");
  const [includeFile, setIncludeFile] = useState(true);
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async (q) => {
    const text = (q ?? question).trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await api.ask(projectId, text, includeFile && path ? path : undefined);
      setThread((t) => [{ q: text, a: res.answer, file: includeFile ? path : null }, ...t]);
      setQuestion("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <form className="section" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <h3>Ask about this project</h3>
        <textarea className="textarea" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={2000}
          placeholder="e.g. What calls this function?" aria-label="Question" disabled={!aiEnabled}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) ask(); }} />
        {path && (
          <label className="check">
            <input type="checkbox" checked={includeFile} onChange={(e) => setIncludeFile(e.target.checked)} />
            Include the open file ({path.split("/").pop()})
          </label>
        )}
        <button className="btn btn-primary" type="submit" disabled={!aiEnabled || busy || !question.trim()}>
          {busy ? <><Spinner /> Thinking</> : "Ask"}
        </button>
        {!aiEnabled && <p className="panel-note">AI is off on this server until GEMINI_API_KEY is set.</p>}
        {error && <p className="error-text">{error}</p>}
      </form>

      {thread.length === 0 && aiEnabled && (
        <div className="section">
          <p className="panel-note">Try one of these:</p>
          {EXAMPLES.map((ex) => (
            <button key={ex} type="button" className="btn btn-ghost btn-small" style={{ justifySelf: "start", textAlign: "left", whiteSpace: "normal" }}
              onClick={() => ask(ex)} disabled={busy}>
              {ex}
            </button>
          ))}
        </div>
      )}

      {thread.map((item, i) => (
        <div key={i} className="qa">
          <div className="q">{item.q}</div>
          <div className="answer"><Markdown>{item.a}</Markdown></div>
        </div>
      ))}
    </div>
  );
}
