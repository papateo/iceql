import { useMemo } from "react";
import { Play, Loader2, Database, Square, Layers } from "lucide-react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (query: string) => void;
  running: boolean;
  onCancel?: () => void;
  database: string;
  databases: string[];
  schema: Record<string, string[]>;
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

const selectClass =
  "appearance-none bg-accent/60 border border-border rounded-lg text-xs text-text-secondary pl-7 pr-6 py-1.5 outline-none focus:border-highlight hover:bg-accent transition-colors cursor-pointer";

export default function MongoQueryEditor({
  value, onChange, onRun, running, onCancel, database, databases, schema, onDatabaseChange,
}: Props) {
  const collections = useMemo(() => Object.keys(schema), [schema]);
  const currentCollection = parseCollection(value);

  const handleCollectionChange = (name: string) => {
    try {
      const parsed = value.trim() ? JSON.parse(value) : {};
      onChange(JSON.stringify({ ...parsed, collection: name }, null, 2));
    } catch {
      onChange(defaultSpec(name));
    }
  };

  const handleRun = () => {
    const text = value.trim() || defaultSpec(collections[0] ?? "");
    onRun(text);
  };

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
      <div className="flex-1 overflow-hidden">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              handleRun();
            }
          }}
          spellCheck={false}
          placeholder={defaultSpec(collections[0] ?? "your_collection")}
          className="w-full h-full resize-none bg-transparent outline-none p-3 font-mono text-xs leading-relaxed text-text-primary placeholder:text-text-muted/60"
        />
      </div>
    </div>
  );
}
