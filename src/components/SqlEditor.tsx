import { useRef, useCallback, useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, MySQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect } from "@codemirror/lang-sql";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { Play, Loader2, Database } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
  database: string;
  databases: string[];
  dbType: string;
  schema: Record<string, string[]>;
  onDatabaseChange: (db: string) => void;
}

function dialectFor(dbType: string): SQLDialect {
  if (dbType === "postgresql") return PostgreSQL;
  if (dbType === "sqlite") return SQLite;
  if (dbType === "mysql") return MySQL;
  return StandardSQL;
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

export default function SqlEditor({ value, onChange, onRun, running, database, databases, dbType, schema, onDatabaseChange }: Props) {
  const editorRef = useRef<{ view?: EditorView } | null>(null);

  // Rebuild the SQL language extension only when the dialect or schema *content* changes
  // (the schema object is rebuilt on every render, so compare by a stable content key).
  const schemaKey = Object.entries(schema)
    .map(([t, cols]) => `${t}:${cols.length}`)
    .join(",");
  const sqlExtension = useMemo(
    () => sql({ dialect: dialectFor(dbType), schema, upperCaseKeywords: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dbType, schemaKey]
  );

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
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <Database size={13} className="absolute left-2 text-text-muted pointer-events-none" />
            <select
              value={database}
              onChange={(e) => onDatabaseChange(e.target.value)}
              title="Select database"
              className="appearance-none bg-accent/60 border border-border rounded-lg text-xs text-text-secondary pl-7 pr-6 py-1.5 outline-none focus:border-highlight hover:bg-accent transition-colors cursor-pointer"
            >
              {database === "" && <option value="">Select database…</option>}
              {databases.map((db) => (
                <option key={db} value={db}>{db}</option>
              ))}
            </select>
            <svg className="absolute right-2 w-3 h-3 text-text-muted pointer-events-none" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <button
            onClick={() => onRun(getSelectedOrAll())}
            disabled={running}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-highlight text-white hover:bg-highlight/90 transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Run
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          ref={editorRef as never}
          value={value}
          onChange={onChange}
          theme={dracula}
          extensions={[sqlExtension, customTheme, runExtension]}
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
