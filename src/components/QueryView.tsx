import { useState, useEffect, useMemo } from "react";
import SqlEditor from "./SqlEditor";
import ResultsPanel from "./ResultsPanel";
import type { QueryResult } from "../types";
import { parseEditableTable, injectCtid, CTID_ALIAS } from "../utils/sql";

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
  const [lastRunQuery, setLastRunQuery] = useState("");
  // Per-row physical identifiers (PostgreSQL ctid) for the current result, when available.
  const [rowIds, setRowIds] = useState<string[] | null>(null);
  const [editorHeight, setEditorHeight] = useState(240);
  const [dragging, setDragging] = useState(false);

  // A result is editable only when it came from a simple single-table SELECT whose columns
  // all map to real columns of a known table (so UPDATEs target the right rows).
  const editableTable = useMemo(() => {
    if (!result || !lastRunQuery) return null;
    const token = parseEditableTable(lastRunQuery);
    if (!token) return null;
    const canonical = Object.keys(schema).find((t) => t.toLowerCase() === token);
    if (!canonical) return null;
    const cols = schema[canonical];
    if (cols && cols.length > 0) {
      const colSet = new Set(cols.map((c) => c.toLowerCase()));
      if (!result.columns.every((c) => colSet.has(c.toLowerCase()))) return null;
    }
    return canonical;
  }, [result, lastRunQuery, schema]);

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
      // For editable Postgres SELECTs, fetch ctid alongside so rows can be updated reliably.
      const useCtid = dbType === "postgresql" && parseEditableTable(q) !== null;
      const res = await onRunQuery(useCtid ? injectCtid(q) : q);
      if (useCtid) {
        const idx = res.columns.indexOf(CTID_ALIAS);
        if (idx !== -1) {
          setRowIds(res.rows.map((r) => String(r[idx])));
          setResult({
            ...res,
            columns: res.columns.filter((_, i) => i !== idx),
            rows: res.rows.map((r) => r.filter((_, i) => i !== idx)),
          });
        } else {
          setRowIds(null);
          setResult(res);
        }
      } else {
        setRowIds(null);
        setResult(res);
      }
      setLastRunQuery(q);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // Run row-edit UPDATEs, then re-run the original query to refresh the displayed rows
  // (re-fetching ctids, which change after an update). Returns total rows actually affected.
  const handleCommit = async (sqls: string[]): Promise<number> => {
    let affected = 0;
    for (const sql of sqls) {
      const res = await onRunQuery(sql);
      affected += res.row_count ?? 0;
    }
    if (lastRunQuery) await runQuery(lastRunQuery);
    return affected;
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
        <ResultsPanel
          result={result}
          error={error}
          loading={loading}
          editableTable={editableTable}
          dbType={dbType}
          database={database}
          rowIds={rowIds}
          onCommit={handleCommit}
        />
      </div>
    </div>
  );
}
