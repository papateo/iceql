import { useMemo, useState, useEffect, useRef } from "react";
import { CheckCircle2, AlertCircle, Clock, Hash, Check, RotateCcw, Loader2, Pencil, Eye, X } from "lucide-react";
import type { QueryResult } from "../types";
import { buildUpdateStatements, formatSql } from "../utils/sql";
import SqlPreview from "./SqlPreview";

interface Props {
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
  // Editing support: when `editableTable` is set, rows can be edited in place.
  editableTable: string | null;
  dbType: string;
  database: string;
  rowIds: string[] | null;
  onCommit: (sqls: string[]) => Promise<number>;
}

interface EditCell {
  rowIdx: number;
  col: string;
  value: string;
}

function displayValue(val: unknown) {
  if (val === null || val === undefined)
    return <span className="text-text-muted italic text-xs">NULL</span>;
  const str = typeof val === "object" ? JSON.stringify(val) : String(val);
  return (
    <span className="truncate max-w-[400px] block" title={str}>
      {str}
    </span>
  );
}

export default function ResultsPanel({ result, error, loading, editableTable, dbType, database, rowIds, onCommit }: Props) {
  const [edits, setEdits] = useState<Map<string, unknown>>(new Map());
  const [editingCell, setEditingCell] = useState<EditCell | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitNotice, setCommitNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const columns = result?.columns ?? [];

  const data = useMemo(() => {
    if (!result?.rows || !result?.columns) return [];
    return result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }, [result]);

  // Reset pending edits whenever a fresh result arrives.
  useEffect(() => {
    setEdits(new Map());
    setEditingCell(null);
    setCommitError(null);
    setShowPreview(false);
  }, [result]);

  // Focus + select only when the *target cell* changes (not on every keystroke), otherwise
  // typing would re-select the text on each change and block normal editing.
  const editingKey = editingCell ? `${editingCell.rowIdx}:${editingCell.col}` : null;
  useEffect(() => {
    if (editingKey) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editingKey]);

  const hasEdits = edits.size > 0;

  const startEdit = (rowIdx: number, col: string) => {
    if (!editableTable) return;
    setCommitNotice(null);
    const editKey = `${rowIdx}:${col}`;
    const current = edits.has(editKey) ? edits.get(editKey) : data[rowIdx][col];
    setEditingCell({ rowIdx, col, value: current === null || current === undefined ? "" : String(current) });
  };

  const commitCellEdit = () => {
    if (!editingCell) return;
    const { rowIdx, col, value } = editingCell;
    const editKey = `${rowIdx}:${col}`;
    const original = data[rowIdx][col];
    const originalStr = original === null || original === undefined ? "" : String(original);
    setEdits((prev) => {
      const next = new Map(prev);
      if (value === originalStr) next.delete(editKey);
      else next.set(editKey, value);
      return next;
    });
    setEditingCell(null);
  };

  const cellValue = (rowIdx: number, col: string): unknown => {
    const editKey = `${rowIdx}:${col}`;
    return edits.has(editKey) ? edits.get(editKey) : data[rowIdx][col];
  };

  const handleCommit = async () => {
    if (!editableTable || !hasEdits) return;
    const sqls = buildUpdateStatements(dbType, database, editableTable, columns, data, edits, rowIds ?? undefined);
    setCommitting(true);
    setCommitError(null);
    setCommitNotice(null);
    try {
      const affected = await onCommit(sqls);
      setEdits(new Map());
      if (affected === 0) {
        setCommitNotice({
          ok: false,
          msg: "0 rows matched — nothing changed. The row couldn't be uniquely identified (some column values don't match exactly).",
        });
      } else {
        setCommitNotice({ ok: true, msg: `Updated ${affected} row${affected === 1 ? "" : "s"}` });
      }
    } catch (e) {
      setCommitError(String(e));
    } finally {
      setCommitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted gap-2">
        <div className="w-4 h-4 border-2 border-highlight border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Running query…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="error-box">
          <AlertCircle size={16} className="error-box-icon" />
          <pre className="error-box-text">{error}</pre>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Run a query to see results
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-b border-border bg-sidebar text-xs">
        <div className="flex items-center gap-1 text-green-400">
          <CheckCircle2 size={12} />
          <span>Success</span>
        </div>
        <div className="flex items-center gap-1 text-text-secondary">
          <Hash size={12} />
          <span>{result.row_count} rows</span>
        </div>
        <div className="flex items-center gap-1 text-text-secondary">
          <Clock size={12} />
          <span>{result.execution_time_ms}ms</span>
        </div>
        {editableTable && !hasEdits && !commitNotice && (
          <div className="flex items-center gap-1 text-text-muted">
            <Pencil size={11} />
            <span>Double-click a cell to edit</span>
          </div>
        )}
        {!hasEdits && commitNotice && (
          <div className={`flex items-center gap-1 ${commitNotice.ok ? "text-green-400" : "text-yellow-400"}`}>
            {commitNotice.ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
            <span>{commitNotice.msg}</span>
          </div>
        )}

        <div className="flex-1" />

        {commitError && (
          <span className="text-red-400 truncate max-w-[320px]" title={commitError}>{commitError}</span>
        )}

        {hasEdits && (
          <div className="flex items-center gap-1.5">
            <span className="text-highlight">{edits.size} edited</span>
            <button
              onClick={() => setShowPreview(true)}
              disabled={committing}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-text-secondary hover:bg-accent hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              <Eye size={11} />
              Preview
            </button>
            <button
              onClick={handleCommit}
              disabled={committing}
              className="flex items-center gap-1 px-2 py-0.5 rounded bg-green-600 text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
            >
              {committing ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              Save
            </button>
            <button
              onClick={() => { setEdits(new Map()); setEditingCell(null); }}
              disabled={committing}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-text-secondary hover:bg-accent hover:text-text-primary disabled:opacity-50 transition-colors"
            >
              <RotateCcw size={11} />
              Discard
            </button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-accent border-b border-border">
              <th className="px-2 py-2 text-left text-text-muted font-medium w-10 border-r border-border">#</th>
              {columns.map((col) => (
                <th
                  key={col}
                  className="px-3 py-2 text-left text-text-secondary font-medium whitespace-nowrap border-r border-border last:border-r-0"
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((_, rowIdx) => (
              <tr key={rowIdx} className="border-b border-border/50 hover:bg-accent/40 transition-colors">
                <td className="px-2 py-1.5 text-text-muted w-10 border-r border-border/50 text-right">
                  {rowIdx + 1}
                </td>
                {columns.map((col) => {
                  const editKey = `${rowIdx}:${col}`;
                  const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
                  const edited = edits.has(editKey);
                  return (
                    <td
                      key={col}
                      onDoubleClick={() => startEdit(rowIdx, col)}
                      className={`px-3 py-1.5 border-r border-border/50 last:border-r-0 max-w-[400px] ${
                        edited ? "bg-highlight/10 text-highlight" : "text-text-primary"
                      } ${editableTable ? "cursor-text" : ""}`}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          value={editingCell.value}
                          onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                          onBlur={commitCellEdit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitCellEdit();
                            else if (e.key === "Escape") setEditingCell(null);
                          }}
                          className="w-full bg-bg border border-highlight rounded px-1 py-0.5 text-text-primary outline-none"
                        />
                      ) : (
                        displayValue(cellValue(rowIdx, col))
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {data.length === 0 && (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            No rows returned
          </div>
        )}
      </div>

      {showPreview && editableTable && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowPreview(false)}>
          <div
            className="bg-sidebar border border-border rounded-lg shadow-xl w-[640px] max-w-[90vw] max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
              <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <Eye size={14} className="text-highlight" />
                Query preview — {edits.size} statement{edits.size === 1 ? "" : "s"}
              </div>
              <button
                onClick={() => setShowPreview(false)}
                className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <div className="bg-bg border border-border rounded p-2.5">
                <SqlPreview
                  value={buildUpdateStatements(dbType, database, editableTable, columns, data, edits, rowIds ?? undefined)
                    .map((sql) => formatSql(sql) + ";")
                    .join("\n\n")}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 px-4 py-2.5 border-t border-border">
              <button
                onClick={() => setShowPreview(false)}
                className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => { setShowPreview(false); handleCommit(); }}
                disabled={committing}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-500 disabled:opacity-50 transition-colors"
              >
                <Check size={13} />
                Run &amp; Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
