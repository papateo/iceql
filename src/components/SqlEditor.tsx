import { useRef, useCallback, useMemo, useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql, MySQL, PostgreSQL, SQLite, StandardSQL, type SQLDialect, schemaCompletionSource, keywordCompletionSource } from "@codemirror/lang-sql";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { createTheme } from "@uiw/codemirror-themes";
import { tags as t } from "@lezer/highlight";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, Prec } from "@codemirror/state";
import { autocompletion, type CompletionContext, type Completion } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Play, Loader2, Database, GitBranch, Check, X, Scissors, Copy, Clipboard, Square } from "lucide-react";
import ContextMenu from "./ContextMenu";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
  onCancel?: () => void;
  database: string;
  databases: string[];
  dbType: string;
  schema: Record<string, string[]>;
  isDark: boolean;
  onDatabaseChange: (db: string) => void;
  inTransaction: boolean;
  onToggleTransaction: () => void;
  onCommitTransaction: () => void;
  onRollbackTransaction: () => void;
}

export const lightTheme = createTheme({
  theme: "light",
  settings: {
    background: "#f0f4f8",
    foreground: "#0c1c2e",
    caret: "#0284c7",
    selection: "rgba(2, 132, 199, 0.18)",
    selectionMatch: "rgba(2, 132, 199, 0.10)",
    lineHighlight: "rgba(2, 132, 199, 0.06)",
    gutterBackground: "#e2eaf2",
    gutterForeground: "#90aac0",
    gutterBorder: "#b0c8e0",
  },
  styles: [
    { tag: t.keyword, color: "#0369a1", fontWeight: "bold" },
    { tag: t.string, color: "#15803d" },
    { tag: t.number, color: "#b45309" },
    { tag: t.comment, color: "#6b8fa8", fontStyle: "italic" },
    { tag: t.operator, color: "#0c1c2e" },
    { tag: t.punctuation, color: "#374151" },
    { tag: t.name, color: "#1e3a5f" },
    { tag: t.typeName, color: "#7c3aed" },
    { tag: t.function(t.name), color: "#0369a1" },
  ],
});

function dialectFor(dbType: string): SQLDialect {
  if (dbType === "postgresql") return PostgreSQL;
  if (dbType === "sqlite") return SQLite;
  if (dbType === "mysql") return MySQL;
  return StandardSQL;
}

function makeColumnCompletion(schema: Record<string, string[]>) {
  return (context: CompletionContext) => {
    const word = context.matchBefore(/\w*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    // Collect all table names referenced in FROM/JOIN clauses of the current statement
    const doc = context.state.doc.toString();
    const fromTableRegex = /\bfrom\s+([\w`,."[\]]+)|\bjoin\s+([\w`,."[\]]+)/gi;
    const referencedTables = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fromTableRegex.exec(doc)) !== null) {
      const raw = (m[1] || m[2]).replace(/[`"[\]]/g, "").split(".").pop() ?? "";
      if (raw) referencedTables.add(raw.toLowerCase());
    }

    // Check we're not right after a dot (table.column → handled by sql() extension)
    const before = doc.slice(0, word.from);
    if (before.endsWith(".")) return null;

    // Build column completions from tables in scope
    const completions: Completion[] = [];
    const seen = new Set<string>();
    for (const [table, cols] of Object.entries(schema)) {
      if (referencedTables.size === 0 || referencedTables.has(table.toLowerCase())) {
        for (const col of cols) {
          if (!seen.has(col)) {
            seen.add(col);
            completions.push({ label: col, type: "property", boost: 10 });
          }
        }
      }
    }
    if (completions.length === 0) return null;

    // Also add table names
    for (const table of Object.keys(schema)) {
      completions.push({ label: table, type: "class", boost: 5 });
    }

    return { from: word.from, options: completions };
  };
}

export const customTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent !important",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: "13px",
    lineHeight: "1.6",
  },
});

export default function SqlEditor({ value, onChange, onRun, running, onCancel, database, databases, dbType, schema, isDark, onDatabaseChange, inTransaction, onToggleTransaction, onCommitTransaction, onRollbackTransaction }: Props) {
  const editorRef = useRef<{ view?: EditorView } | null>(null);

  const sqlCompartment = useMemo(() => new Compartment(), []);
  const schemaKey = Object.entries(schema)
    .map(([tbl, cols]) => `${tbl}:${cols.length}`)
    .join(",");

  const makeSqlExt = useCallback(() => {
    const dialect = dialectFor(dbType);
    return [
      sql({ dialect, schema, upperCaseKeywords: false }),
      autocompletion({
        override: [
          makeColumnCompletion(schema),
          schemaCompletionSource({ dialect, schema }),
          keywordCompletionSource(dialect, false),
        ],
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbType, schemaKey]);

  useEffect(() => {
    const view = (editorRef.current as unknown as { view?: EditorView })?.view;
    if (view) {
      view.dispatch({ effects: sqlCompartment.reconfigure(makeSqlExt()) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [makeSqlExt]);

  const getView = useCallback(
    () => (editorRef.current as unknown as { view?: EditorView })?.view,
    []
  );

  const getSelectedOrAll = useCallback(() => {
    const view = getView();
    if (view) {
      const sel = view.state.selection.main;
      if (!sel.empty) {
        return view.state.sliceDoc(sel.from, sel.to);
      }
    }
    return value;
  }, [value, getView]);

  // Right-click menu for the editor's contenteditable surface — the browser's own
  // context menu is disabled app-wide, and it isn't an <input>/<textarea> that the
  // global handler in App.tsx already covers, so cut/copy/paste need their own here.
  const [editCtx, setEditCtx] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);

  const handleEditorContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const view = getView();
    const hasSelection = !!view && !view.state.selection.main.empty;
    setEditCtx({ x: e.clientX, y: e.clientY, hasSelection });
  }, [getView]);

  const cutSelection = useCallback(() => {
    const view = getView();
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
    view.focus();
  }, [getView]);

  const copySelection = useCallback(() => {
    const view = getView();
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
  }, [getView]);

  const pasteClipboard = useCallback(async () => {
    const view = getView();
    if (!view) return;
    const text = await readText();
    if (!text) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
    view.focus();
  }, [getView]);

  const selectAll = useCallback(() => {
    const view = getView();
    if (!view) return;
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    view.focus();
  }, [getView]);

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
        <span className="text-text-muted text-xs flex items-center gap-2">
          SQL Editor — Cmd+Enter to run
          {inTransaction && (
            <span className="flex items-center gap-1 text-amber-400 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
              Transaction active
            </span>
          )}
        </span>
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
          {inTransaction ? (
            <>
              <button
                onClick={onRollbackTransaction}
                disabled={running}
                title="Rollback transaction"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors disabled:opacity-50"
              >
                <X size={13} />
                Rollback
              </button>
              <button
                onClick={onCommitTransaction}
                disabled={running}
                title="Commit transaction"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 transition-colors disabled:opacity-50"
              >
                <Check size={13} />
                Commit
              </button>
            </>
          ) : (
            <button
              onClick={onToggleTransaction}
              disabled={running}
              title="Begin transaction"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent/60 border border-border text-text-secondary hover:bg-accent hover:text-text-primary transition-colors disabled:opacity-50"
            >
              <GitBranch size={13} />
              Txn
            </button>
          )}
          {running && onCancel ? (
            <button
              onClick={onCancel}
              title="Cancel the running query"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors"
            >
              <Square size={12} className="fill-current" />
              Cancel
            </button>
          ) : (
            <button
              onClick={() => onRun(getSelectedOrAll())}
              disabled={running}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-highlight text-white hover:bg-highlight/90 transition-colors disabled:opacity-50"
            >
              {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
              Run
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden" onContextMenu={handleEditorContextMenu}>
        <CodeMirror
          ref={editorRef as never}
          value={value}
          onChange={onChange}
          theme={isDark ? dracula : lightTheme}
          extensions={[sqlCompartment.of(makeSqlExt()), customTheme, runExtension]}
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

      {editCtx && (
        <ContextMenu
          x={editCtx.x}
          y={editCtx.y}
          onClose={() => setEditCtx(null)}
          items={[
            { label: "Cut", icon: <Scissors size={12} />, disabled: !editCtx.hasSelection, onClick: cutSelection },
            { label: "Copy", icon: <Copy size={12} />, disabled: !editCtx.hasSelection, onClick: copySelection },
            { label: "Paste", icon: <Clipboard size={12} />, onClick: pasteClipboard },
            { separator: true },
            { label: "Select All", onClick: selectAll },
          ]}
        />
      )}
    </div>
  );
}
