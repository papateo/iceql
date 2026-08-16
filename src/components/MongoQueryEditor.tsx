import { useRef, useCallback, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Play, Loader2, Database, Square, Layers, Scissors, Copy, Clipboard } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { lightTheme, customTheme } from "./SqlEditor";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
  onCancel?: () => void;
  database: string;
  databases: string[];
  schema: Record<string, string[]>;
  isDark: boolean;
  onDatabaseChange: (db: string) => void;
}

function defaultSpec(collection: string): string {
  return JSON.stringify({ collection, filter: {}, limit: 200 }, null, 2);
}

// Best-effort read of the "collection" field out of the editor's JSON text, so the
// collection dropdown reflects whatever the user has typed (including hand-edits).
function parseCollection(text: string): string {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.collection === "string" ? parsed.collection : "";
  } catch {
    return "";
  }
}

const SPEC_KEYS = ["collection", "filter", "sort", "limit"];
const MONGO_OPERATORS = [
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin",
  "$and", "$or", "$nor", "$not",
  "$exists", "$type", "$regex", "$mod", "$all", "$elemMatch", "$size",
  "$text", "$expr", "$oid", "$date",
];

// Completions inside JSON string literals: field names of the selected collection and
// Mongo query operators everywhere, plus the top-level spec keys near the outer object.
function makeMongoCompletion(fields: string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/"[\w$]*/);
    if (!word) return null;
    if (word.from === word.to && !context.explicit) return null;

    const before = context.state.doc.sliceString(0, word.from);
    const opens = (before.match(/[{[]/g) ?? []).length;
    const closes = (before.match(/[}\]]/g) ?? []).length;
    const depth = opens - closes;

    const options: Completion[] = [];
    if (depth <= 1) {
      SPEC_KEYS.forEach((k) => options.push({ label: k, type: "keyword", boost: 12 }));
    }
    fields.forEach((f) => options.push({ label: f, type: "property", boost: depth > 1 ? 10 : 4 }));
    MONGO_OPERATORS.forEach((op) => options.push({ label: op, type: "function", boost: depth > 1 ? 8 : 2 }));

    return { from: word.from + 1, options, filter: true };
  };
}

const selectClass =
  "appearance-none bg-accent/60 border border-border rounded-lg text-xs text-text-secondary pl-7 pr-6 py-1.5 outline-none focus:border-highlight hover:bg-accent transition-colors cursor-pointer";

export default function MongoQueryEditor({
  value, onChange, onRun, running, onCancel, database, databases, schema, isDark, onDatabaseChange,
}: Props) {
  const editorRef = useRef<{ view?: EditorView } | null>(null);
  const collections = useMemo(() => Object.keys(schema), [schema]);
  const currentCollection = parseCollection(value);
  const fields = useMemo(() => schema[currentCollection] ?? [], [schema, currentCollection]);

  const handleCollectionChange = (name: string) => {
    try {
      const parsed = value.trim() ? JSON.parse(value) : {};
      onChange(JSON.stringify({ ...parsed, collection: name }, null, 2));
    } catch {
      onChange(defaultSpec(name));
    }
  };

  const handleRun = useCallback(() => {
    const text = value.trim() || defaultSpec(collections[0] ?? "");
    onRun(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, collections]);

  const runExtension = useMemo(
    () => Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { handleRun(); return true; } }])),
    [handleRun]
  );

  const extensions = useMemo(
    () => [json(), autocompletion({ override: [makeMongoCompletion(fields)] }), customTheme, runExtension],
    [fields, runExtension]
  );

  // Right-click menu for the editor's contenteditable surface — same reasoning as SqlEditor:
  // the browser's own context menu is disabled app-wide, and CodeMirror isn't an
  // <input>/<textarea> that the global handler in App.tsx already covers.
  const [editCtx, setEditCtx] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const getView = useCallback(() => (editorRef.current as unknown as { view?: EditorView })?.view, []);

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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-sidebar">
        <span className="text-text-muted text-xs">
          Mongo Query — Cmd+Enter to run · <code className="text-text-secondary">{"{ collection, filter, sort?, limit? }"}</code>
        </span>
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <Database size={13} className="absolute left-2 text-text-muted pointer-events-none" />
            <select value={database} onChange={(e) => onDatabaseChange(e.target.value)} title="Select database" className={selectClass}>
              {database === "" && <option value="">Select database…</option>}
              {databases.map((db) => (
                <option key={db} value={db}>{db}</option>
              ))}
            </select>
            <svg className="absolute right-2 w-3 h-3 text-text-muted pointer-events-none" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div className="relative flex items-center">
            <Layers size={13} className="absolute left-2 text-text-muted pointer-events-none" />
            <select value={currentCollection} onChange={(e) => handleCollectionChange(e.target.value)} title="Select collection" className={selectClass}>
              <option value="">Select collection…</option>
              {collections.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <svg className="absolute right-2 w-3 h-3 text-text-muted pointer-events-none" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

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
              onClick={handleRun}
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
          extensions={extensions}
          style={{ height: "100%" }}
          placeholder={defaultSpec(collections[0] ?? "your_collection")}
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
