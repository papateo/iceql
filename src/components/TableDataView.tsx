import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Loader2,
  Check,
  RotateCcw,
} from "lucide-react";
import type { ActiveConnection, QueryLog, QueryResult } from "../types";

interface Props {
  configId: string;
  database: string;
  table: string;
  activeConnections: Map<string, ActiveConnection>;
  addLog: (log: Omit<QueryLog, "id" | "timestamp">) => void;
}

interface EditCell {
  rowIdx: number;
  col: string;
  value: string;
}

const PAGE_SIZE = 100;

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-text-muted italic">NULL</span>;
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return (
    <span className="truncate block max-w-[320px]" title={str}>
      {str}
    </span>
  );
}

export default function TableDataView({
  configId,
  database,
  table,
  activeConnections,
  addLog,
}: Props) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // editing state: map of "rowIdx:col" -> new value
  const [edits, setEdits] = useState<Map<string, unknown>>(new Map());
  const [editingCell, setEditingCell] = useState<EditCell | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ac = activeConnections.get(configId);
  const hasEdits = edits.size > 0;

  const fetchData = useCallback(async () => {
    if (!ac) return;
    setLoading(true);
    setError(null);
    setEdits(new Map());
    setEditingCell(null);
    const sql = `SELECT * FROM \`${database}\`.\`${table}\` LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`;
    try {
      const res = await invoke<QueryResult>("get_table_data", {
        connectionId: ac.connectionId,
        database,
        table,
        page,
        pageSize: PAGE_SIZE,
      });
      setResult(res);
      setRows(
        res.rows.map((row) => {
          const obj: Record<string, unknown> = {};
          res.columns.forEach((col, i) => { obj[col] = row[i]; });
          return obj;
        })
      );
      addLog({
        sql,
        connectionName: ac.config.name,
        database,
        status: "success",
        rowsAffected: res.row_count,
        executionTimeMs: res.execution_time_ms,
      });
    } catch (e) {
      setError(String(e));
      addLog({ sql, connectionName: ac.config.name, database, status: "error", error: String(e) });
    } finally {
      setLoading(false);
    }
  }, [ac, database, table, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Focus input when editingCell changes
  useEffect(() => {
    if (editingCell) inputRef.current?.focus();
  }, [editingCell]);

  const startEdit = (rowIdx: number, col: string) => {
    const editKey = `${rowIdx}:${col}`;
    const current = edits.has(editKey)
      ? String(edits.get(editKey) ?? "")
      : (() => {
          const v = rows[rowIdx]?.[col];
          return v === null || v === undefined ? "" : String(v);
        })();
    setEditingCell({ rowIdx, col, value: current });
  };

  const commitCell = () => {
    if (!editingCell) return;
    const { rowIdx, col, value } = editingCell;
    const editKey = `${rowIdx}:${col}`;
    const original = rows[rowIdx]?.[col];
    const originalStr = original === null || original === undefined ? "" : String(original);
    if (value === originalStr) {
      // unchanged — drop from edits
      setEdits((prev) => {
        const next = new Map(prev);
        next.delete(editKey);
        return next;
      });
    } else {
      setEdits((prev) => new Map(prev).set(editKey, value));
    }
    setEditingCell(null);
  };

  const revertAll = () => {
    setEdits(new Map());
    setEditingCell(null);
  };

  const buildUpdateSQL = (): string[] => {
    if (!result) return [];
    // Group edits by row
    const byRow = new Map<number, Record<string, unknown>>();
    edits.forEach((value, key) => {
      const [rowIdxStr, ...colParts] = key.split(":");
      const rowIdx = Number(rowIdxStr);
      const col = colParts.join(":");
      if (!byRow.has(rowIdx)) byRow.set(rowIdx, {});
      byRow.get(rowIdx)![col] = value;
    });

    const sqls: string[] = [];
    byRow.forEach((changes, rowIdx) => {
      const original = rows[rowIdx];
      const setClauses = Object.entries(changes)
        .map(([col, val]) => `\`${col}\` = ${sqlLiteral(val)}`)
        .join(", ");
      const whereClauses = result.columns
        .map((col) => {
          const v = original[col];
          return v === null || v === undefined
            ? `\`${col}\` IS NULL`
            : `\`${col}\` = ${sqlLiteral(v)}`;
        })
        .join(" AND ");
      sqls.push(
        `UPDATE \`${database}\`.\`${table}\` SET ${setClauses} WHERE ${whereClauses} LIMIT 1`
      );
    });
    return sqls;
  };

  const commitAll = async () => {
    if (!ac || !hasEdits) return;
    const sqls = buildUpdateSQL();
    setLoading(true);
    setError(null);
    try {
      for (const sql of sqls) {
        const res = await invoke<QueryResult>("execute_query", {
          connectionId: ac.connectionId,
          query: sql,
        });
        addLog({
          sql,
          connectionName: ac.config.name,
          database,
          status: "success",
          rowsAffected: (res as QueryResult).row_count,
          executionTimeMs: (res as QueryResult).execution_time_ms,
        });
      }
      await fetchData();
    } catch (e) {
      setError(String(e));
      addLog({ sql: sqls.join(";\n"), connectionName: ac.config.name, database, status: "error", error: String(e) });
      setLoading(false);
    }
  };

  const totalPages = result ? Math.ceil(result.row_count / PAGE_SIZE) : 0;

  const getCellValue = (rowIdx: number, col: string): unknown => {
    const editKey = `${rowIdx}:${col}`;
    if (edits.has(editKey)) return edits.get(editKey);
    return rows[rowIdx]?.[col];
  };

  const isEdited = (rowIdx: number, col: string) =>
    edits.has(`${rowIdx}:${col}`);

  const columns = result?.columns ?? [];

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-sidebar">
        <span className="text-text-secondary text-xs font-mono">
          {database}.<span className="text-text-primary">{table}</span>
        </span>
        <div className="flex-1" />
        {result && !hasEdits && (
          <span className="text-text-muted text-xs">
            {result.row_count.toLocaleString()} rows · {result.execution_time_ms}ms
          </span>
        )}

        {/* Edit action buttons */}
        {hasEdits && (
          <div className="flex items-center gap-2">
            <span className="text-text-muted text-xs">{edits.size} change{edits.size > 1 ? "s" : ""}</span>
            <button
              onClick={revertAll}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-accent border border-border text-text-secondary hover:text-text-primary transition-colors"
              title="Revert all changes"
            >
              <RotateCcw size={12} />
              Revert
            </button>
            <button
              onClick={commitAll}
              disabled={loading}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-highlight text-bg hover:bg-highlight/90 transition-colors disabled:opacity-50"
              title="Commit changes to database"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Commit
            </button>
          </div>
        )}

        <button
          onClick={fetchData}
          disabled={loading}
          className="p-1.5 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"
          title="Refresh"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 bg-red-900/20 border-b border-red-800/50 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading && !result ? (
          <div className="flex items-center justify-center h-full text-text-muted gap-2">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-accent border-b border-border">
                <th className="px-2 py-2 text-left text-text-muted font-medium w-10 border-r border-border select-none">
                  #
                </th>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-3 py-2 text-left text-text-secondary font-medium whitespace-nowrap border-r border-border last:border-r-0 select-none"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((_, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-border/50 hover:bg-accent/30 transition-colors"
                >
                  <td className="px-2 py-1.5 text-text-muted w-10 border-r border-border/50 text-right select-none">
                    {page * PAGE_SIZE + rowIdx + 1}
                  </td>
                  {columns.map((col) => {
                    const isActive =
                      editingCell?.rowIdx === rowIdx && editingCell?.col === col;
                    const edited = isEdited(rowIdx, col);

                    return (
                      <td
                        key={col}
                        className={`relative border-r border-border/50 last:border-r-0 max-w-[400px] ${
                          edited ? "bg-highlight/10" : ""
                        }`}
                        onDoubleClick={() => startEdit(rowIdx, col)}
                      >
                        {isActive ? (
                          <input
                            ref={inputRef}
                            className="w-full h-full px-3 py-1.5 bg-surface border border-highlight outline-none text-text-primary text-xs font-mono"
                            value={editingCell.value}
                            onChange={(e) =>
                              setEditingCell((prev) =>
                                prev ? { ...prev, value: e.target.value } : null
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commitCell(); }
                              if (e.key === "Escape") setEditingCell(null);
                              if (e.key === "Tab") { e.preventDefault(); commitCell(); }
                            }}
                            onBlur={commitCell}
                          />
                        ) : (
                          <div className={`px-3 py-1.5 cursor-default ${edited ? "text-highlight" : "text-text-primary"}`}>
                            <CellValue value={getCellValue(rowIdx, col)} />
                            {edited && (
                              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-highlight" />
                            )}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!loading && rows.length === 0 && !error && (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            Table is empty
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-sidebar">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-primary disabled:opacity-40 transition-colors"
          >
            <ChevronLeft size={14} /> Prev
          </button>
          <span className="text-text-muted text-xs">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-primary disabled:opacity-40 transition-colors"
          >
            Next <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${str.replace(/'/g, "''")}'`;
}
