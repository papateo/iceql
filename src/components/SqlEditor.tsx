import { useRef, useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { Play, Loader2 } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
}

const customTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent !important",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".cm-gutters": {
    backgroundColor: "#071a2e",
    borderRight: "1px solid #1a4060",
    color: "#38607a",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(56, 189, 248, 0.07) !important",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(56, 189, 248, 0.07)",
  },
  ".cm-cursor": {
    borderLeftColor: "#38bdf8",
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(56, 189, 248, 0.15) !important",
  },
});

export default function SqlEditor({ value, onChange, onRun, running }: Props) {
  const editorRef = useRef<{ view?: EditorView } | null>(null);

  const getSelectedOrAll = useCallback(() => {
    const view = (editorRef.current as unknown as { view?: EditorView })?.view;
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        return view.state.sliceDoc(sel.from, sel.to);
      }
    }
    return value;
  }, [value]);

  const runExtension = Prec.highest(
    keymap.of([
      {
        key: "Mod-Enter",
        run: () => {
          onRun(getSelectedOrAll());
          return true;
        },
      },
    ])
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-sidebar">
        <span className="text-text-muted text-xs">SQL Editor — Cmd+Enter to run</span>
        <button
          onClick={() => onRun(getSelectedOrAll())}
          disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-highlight text-white hover:bg-highlight/90 transition-colors disabled:opacity-50"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          Run
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          ref={editorRef as never}
          value={value}
          onChange={onChange}
          theme={dracula}
          extensions={[sql(), customTheme, runExtension]}
          style={{ height: "100%" }}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            foldGutter: true,
            autocompletion: true,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
          }}
        />
      </div>
    </div>
  );
}
