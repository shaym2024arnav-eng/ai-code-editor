import { useEffect, useRef } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { languageForPath } from "../upload.js";
import "../monacoSetup.js";

// Monaco themes matched to the app palette.
function defineThemes(monaco) {
  monaco.editor.defineTheme("drafting-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7C88A6", fontStyle: "italic" },
      { token: "keyword", foreground: "F2C14E" },
      { token: "string", foreground: "8FD9B6" },
      { token: "number", foreground: "C9A7FF" },
      { token: "type", foreground: "7AA7FF" },
    ],
    colors: {
      "editor.background": "#172033",
      "editor.foreground": "#E7EAF3",
      "editorLineNumber.foreground": "#56627F",
      "editorLineNumber.activeForeground": "#C3CAE0",
      "editor.lineHighlightBackground": "#1F2A42",
      "editor.selectionBackground": "#3A4B72",
      "editorCursor.foreground": "#F2C14E",
      "editorIndentGuide.background1": "#26324D",
      "diffEditor.insertedTextBackground": "#5CC8A833",
      "diffEditor.removedTextBackground": "#FF8A8033",
    },
  });
  monaco.editor.defineTheme("drafting-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "7D88A3", fontStyle: "italic" },
      { token: "keyword", foreground: "8A5A00" },
      { token: "string", foreground: "17866A" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.lineHighlightBackground": "#F4F6FB",
      "editorCursor.foreground": "#2F63D6",
    },
  });

  // The editor only sees one file at a time, so "cannot find module" errors would be noise.
  const ts = monaco.typescript || monaco.languages.typescript;
  if (ts) {
    const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false };
    ts.javascriptDefaults.setDiagnosticsOptions(diagnostics);
    ts.typescriptDefaults.setDiagnosticsOptions(diagnostics);
    const opts = { jsx: ts.JsxEmit ? ts.JsxEmit.React : 2, allowJs: true, allowNonTsExtensions: true, target: 99 };
    ts.javascriptDefaults.setCompilerOptions(opts);
    ts.typescriptDefaults.setCompilerOptions(opts);
  }
}

const OPTIONS = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderLineHighlight: "line",
  padding: { top: 10 },
  tabSize: 2,
  automaticLayout: true,
};

export function CodeEditor({ path, value, onChange, onSave, onSelection, theme, reveal }) {
  const editorRef = useRef(null);
  const saveRef = useRef(onSave);
  const selectionRef = useRef(onSelection);
  saveRef.current = onSave;
  selectionRef.current = onSelection;

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || !reveal.line) return;
    editor.revealLineInCenter(reveal.line);
    editor.setPosition({ lineNumber: reveal.line, column: 1 });
    editor.focus();
  }, [reveal]);

  return (
    <Editor
      path={path}
      value={value}
      language={languageForPath(path)}
      theme={theme === "light" ? "drafting-light" : "drafting-dark"}
      beforeMount={defineThemes}
      onChange={(v) => onChange(v ?? "")}
      options={OPTIONS}
      loading={<div className="empty-state">Loading editor</div>}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current());
        editor.onDidChangeCursorSelection((e) => {
          const s = e.selection;
          const empty = s.startLineNumber === s.endLineNumber && s.startColumn === s.endColumn;
          selectionRef.current(empty ? null : { startLine: s.startLineNumber, endLine: s.endLineNumber });
        });
        if (reveal && reveal.line) editor.revealLineInCenter(reveal.line);
      }}
    />
  );
}

// Review of an AI suggestion. The suggested side stays editable so the user can
// adjust it before accepting; modifiedRef.current() reads it back.
export function ReviewEditor({ reviewId, path, original, modified, theme, modifiedRef }) {
  const modelsRef = useRef(null);

  // Dispose this review's models only after the diff widget has been torn down,
  // otherwise Monaco throws "TextModel got disposed before DiffEditorWidget model got reset".
  useEffect(() => () => {
    const models = modelsRef.current;
    if (models) setTimeout(() => { models.original?.dispose(); models.modified?.dispose(); }, 0);
  }, []);

  return (
    <DiffEditor
      original={original}
      modified={modified}
      originalModelPath={`review-original://${reviewId}/${path}`}
      modifiedModelPath={`review-modified://${reviewId}/${path}`}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      language={languageForPath(path)}
      theme={theme === "light" ? "drafting-light" : "drafting-dark"}
      beforeMount={defineThemes}
      options={{ ...OPTIONS, renderSideBySide: true, originalEditable: false, readOnly: false, renderOverviewRuler: false }}
      loading={<div className="empty-state">Loading review</div>}
      onMount={(editor) => {
        modelsRef.current = editor.getModel();
        modifiedRef.current = () => editor.getModifiedEditor().getValue();
      }}
    />
  );
}
