import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView } from "@codemirror/view";

const theme = EditorView.theme({
  "&": { backgroundColor: "transparent !important", fontSize: "12px" },
  ".cm-gutters": { display: "none" },
  ".cm-content": { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  ".cm-activeLine": { backgroundColor: "transparent !important" },
});

// Read-only, syntax-highlighted SQL viewer used for previewing generated statements.
export default function SqlPreview({ value }: { value: string }) {
  return (
    <CodeMirror
      value={value}
      theme={dracula}
      editable={false}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
      }}
      extensions={[sql(), theme, EditorView.lineWrapping]}
    />
  );
}
