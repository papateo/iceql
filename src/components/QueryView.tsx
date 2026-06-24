import { useState, useEffect } from "react";
import SqlEditor from "./SqlEditor";
import ResultsPanel from "./ResultsPanel";
import type { QueryResult } from "../types";

interface Props {
  tabId: string;
  query: string;
  database: string;
  databases: string[];
  dbType: string;
  schema: Record<string, string[]>;
  onLoadSchema: () => void;
  onDatabaseChange: (db: string) => void;
  onQueryChange: (q: string) => void;
  onRunQuery: (q: string) => Promise<QueryResult>;
}

export default function QueryView({ query, database, databases, dbType, schema, onLoadSchema, onDatabaseChange, onQueryChange, onRunQuery }: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editorHeight, setEditorHeight] = useState(240);
  const [dragging, setDragging] = useState(false);

  // Load table/column metadata for the selected database so the editor can autocomplete.
  useEffect(() => {
    if (database) onLoadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database]);

  const runQuery = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await onRunQuery(q);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleDividerMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    const startY = e.clientY;
    const startH = editorHeight;

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY;
      setEditorHeight(Math.max(80, Math.min(600, startH + delta)));
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div className="flex flex-col h-full">
      <div style={{ height: editorHeight, flexShrink: 0 }}>
        <SqlEditor
          value={query}
          onChange={onQueryChange}
          onRun={runQuery}
          running={loading}
          database={database}
          databases={databases}
          dbType={dbType}
          schema={schema}
          onDatabaseChange={onDatabaseChange}
        />
      </div>

      {/* Drag handle */}
      <div
        className={`h-1 cursor-row-resize border-y border-border hover:bg-highlight/30 transition-colors ${
          dragging ? "bg-highlight/30" : "bg-sidebar"
        }`}
        onMouseDown={handleDividerMouseDown}
      />

      <div className="flex-1 overflow-hidden">
        <ResultsPanel result={result} error={error} loading={loading} />
      </div>
    </div>
  );
}
