import { useRef, useCallback, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from "@codemirror/autocomplete";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { Play, Loader2, Database, Square, Scissors, Copy, Clipboard } from "lucide-react";
import ContextMenu from "./ContextMenu";
import { lightTheme } from "./SqlEditor";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
  onCancel?: () => void;
  database: string;
  databases: string[];
  isDark: boolean;
  onDatabaseChange: (db: string) => void;
}

// A representative set, not exhaustive — enough for the autocomplete to be genuinely useful
// without maintaining a full command reference.
const REDIS_COMMANDS = [
  "GET", "SET", "SETEX", "SETNX", "DEL", "EXISTS", "EXPIRE", "PERSIST", "TTL", "PTTL",
  "TYPE", "KEYS", "SCAN", "RENAME", "COPY", "DBSIZE", "FLUSHDB", "PING", "INFO", "CONFIG",
  "HGET", "HSET", "HGETALL", "HDEL", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HINCRBY",
  "LPUSH", "RPUSH", "LRANGE", "LPOP", "RPOP", "LLEN", "LSET", "LINDEX", "LREM",
  "SADD", "SREM", "SMEMBERS", "SISMEMBER", "SCARD", "SUNION", "SINTER", "SDIFF",
  "ZADD", "ZRANGE", "ZREM", "ZSCORE", "ZCARD", "ZRANGEBYSCORE", "ZINCRBY", "ZRANK",
  "INCR", "DECR", "INCRBY", "DECRBY", "APPEND", "STRLEN", "GETSET", "MGET", "MSET",
];

function redisCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[A-Za-z]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;
  // Command names only make sense as the first token of a line.
  if (word.from !== context.state.doc.lineAt(word.from).from) return null;
  const options: Completion[] = REDIS_COMMANDS.map((c) => ({ label: c, type: "keyword" }));
  return { from: word.from, options, filter: true };
}

const redisTheme = EditorView.theme({
  "&": { backgroundColor: "transparent !important", height: "100%" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace", fontSize: "13px", lineHeight: "1.6" },
});

const selectClass =
  "appearance-none bg-accent/60 border border-border rounded-lg text-xs text-text-secondary pl-7 pr-6 py-1.5 outline-none focus:border-highlight hover:bg-accent transition-colors cursor-pointer";

export default function RedisQueryEditor({
  value, onChange, onRun, running, onCancel, database, databases, isDark, onDatabaseChange,
}: Props) {
  const editorRef = useRef<{ view?: EditorView } | null>(null);

  const handleRun = useCallback(() => {
    onRun(value);
  }, [value, onRun]);

  const runExtension = useMemo(
    () => Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => { handleRun(); return true; } }])),
    [handleRun]
  );

  const extensions = useMemo(
    () => [autocompletion({ override: [redisCompletionSource] }), redisTheme, runExtension],
    [runExtension]
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
        <span className="text-text-muted text-xs">Redis Commands — Cmd+Enter to run · one command per line</span>
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <Database size={13} className="absolute left-2 text-text-muted pointer-events-none" />
            <select value={database} onChange={(e) => onDatabaseChange(e.target.value)} title="Select database" className={selectClass}>
              {database === "" && <option value="">Select database…</option>}
              {databases.map((db) => (
                <option key={db} value={db}>db{db}</option>
              ))}
            </select>
            <svg className="absolute right-2 w-3 h-3 text-text-muted pointer-events-none" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          {running && onCancel ? (
            <button
              onClick={onCancel}
              title="Cancel the running command"
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
          placeholder={"GET mykey\nHGETALL myhash"}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
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
