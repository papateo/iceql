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
  isDark: boolean;
  onLoadSchema: () => void;
  onDatabaseChange: (db: string) => void;
  onQueryChange: (q: string) => void;
  onRunQuery: (q: string) => Promise<QueryResult>;
  onBeginTransaction: (database: string) => Promise<string>;
  onExecuteInTransaction: (txId: string, query: string) => Promise<QueryResult>;
  onCommitTransaction: (txId: string) => Promise<QueryResult>;
  onRollbackTransaction: (txId: string) => Promise<QueryResult>;
}

export default function QueryView({
  query, database, databases, dbType, schema, isDark,
  onLoadSchema, onDatabaseChange, onQueryChange, onRunQuery,
  onBeginTransaction, onExecuteInTransaction, onCommitTransaction, onRollbackTransaction,
}: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastRunQuery, setLastRunQuery] = useState("");
  const [rowIds, setRowIds] = useState<string[] | null>(null);
  const [editorHeight, setEditorHeight] = useState(240);
  const [dragging, setDragging] = useState(false);

  // Transaction state
  const [inTransaction, setInTransaction] = useState(false);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

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

  useEffect(() => {
    if (database) onLoadSchema();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database]);

  const applyResult = (res: QueryResult, q: string, useCtid: boolean) => {
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
  };

  const runQuery = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const useCtid = dbType === "postgresql" && parseEditableTable(q) !== null;
      const finalQ = useCtid ? injectCtid(q) : q;

      let res: QueryResult;
      if (inTransaction && transactionId) {
        res = await onExecuteInTransaction(transactionId, finalQ);
      } else {
        res = await onRunQuery(finalQ);
      }
      applyResult(res, q, useCtid);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCommit = async (sqls: string[]): Promise<number> => {
    let affected = 0;
    for (const sql of sqls) {
      const res = await onRunQuery(sql);
      affected += res.row_count ?? 0;
    }
    if (lastRunQuery) await runQuery(lastRunQuery);
    return affected;
  };

  const handleToggleTransaction = async () => {
    if (inTransaction) return; // use commit/rollback buttons to end
    setTxError(null);
    try {
      const txId = await onBeginTransaction(database);
      setTransactionId(txId);
      setInTransaction(true);
    } catch (e) {
      setTxError(String(e));
    }
  };

  const handleCommitTransaction = async () => {
    if (!transactionId) return;
    setLoading(true);
    setTxError(null);
    try {
      const res = await onCommitTransaction(transactionId);
      setResult(res);
      setLastRunQuery("COMMIT");
    } catch (e) {
      setTxError(String(e));
    } finally {
      setInTransaction(false);
      setTransactionId(null);
      setLoading(false);
    }
  };

  const handleRollbackTransaction = async () => {
    if (!transactionId) return;
    setLoading(true);
    setTxError(null);
    try {
      const res = await onRollbackTransaction(transactionId);
      setResult(res);
      setLastRunQuery("ROLLBACK");
    } catch (e) {
      setTxError(String(e));
    } finally {
      setInTransaction(false);
      setTransactionId(null);
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
          isDark={isDark}
          onDatabaseChange={onDatabaseChange}
          inTransaction={inTransaction}
          onToggleTransaction={handleToggleTransaction}
          onCommitTransaction={handleCommitTransaction}
          onRollbackTransaction={handleRollbackTransaction}
        />
      </div>

      {txError && (
        <div className="px-3 py-1.5 text-xs text-red-400 bg-red-400/10 border-b border-border">
          Transaction error: {txError}
        </div>
      )}

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
