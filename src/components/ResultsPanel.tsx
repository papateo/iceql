import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CheckCircle2, AlertCircle, Clock, Hash, Check, RotateCcw, Loader2, Pencil, Eye, Download, X, Trash2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { QueryResult } from "../types";
import { buildUpdateStatements, buildDeleteStatements, formatSql } from "../utils/sql";
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

const MARKER_W = 40;
const CELL_CHAR_W = 7;
const CELL_MIN_W = 80;
const CELL_MAX_W = 320;
const CELL_PAD = 28;

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
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [edits, setEdits] = useState<Map<string, unknown>>(new Map());
  const [editingCell, setEditingCell] = useState<EditCell | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitNotice, setCommitNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastClickedRow = useRef<number | null>(null);
  const isDragging = useRef(false);
  const dragStartRow = useRef<number | null>(null);
  const dragMode = useRef<"select" | "deselect">("select");

  const columns = result?.columns ?? [];

  const data = useMemo(() => {
    if (!result?.rows || !result?.columns) return [];
    return result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }, [result]);

  // Reset state whenever a fresh result arrives.
  useEffect(() => {
    setEdits(new Map());
    setEditingCell(null);
    setCommitError(null);
    setShowPreview(false);
    setSelectedRows(new Set());
  }, [result]);

  const allSelected = data.length > 0 && selectedRows.size === data.length;
  const someSelected = selectedRows.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelectedRows(allSelected ? new Set() : new Set(data.map((_, i) => i)));
  };

  const handleRowMouseDown = useCallback((e: React.MouseEvent, rowIdx: number) => {
    if (e.button !== 0) return;
    // Note: don't preventDefault here — it would block mouse text-selection inside the
    // edit input. Text selection during row-drag is suppressed via `select-none` on the row.

    if (e.shiftKey && lastClickedRow.current !== null) {
      // Range select — add range without clearing existing selection
      const from = Math.min(lastClickedRow.current, rowIdx);
      const to = Math.max(lastClickedRow.current, rowIdx);
      setSelectedRows((prev) => {
        const next = new Set(prev);
        for (let i = from; i <= to; i++) next.add(i);
        return next;
      });
    } else if (e.metaKey || e.ctrlKey) {
      // Ctrl/Cmd+Click → toggle individual row
      lastClickedRow.current = rowIdx;
      setSelectedRows((prev) => {
        const next = new Set(prev);
        if (next.has(rowIdx)) next.delete(rowIdx); else next.add(rowIdx);
        return next;
      });
    } else {
      // Plain click — select only this row (clear others), drag will expand
      isDragging.current = true;
      dragStartRow.current = rowIdx;
      dragMode.current = "select";
      lastClickedRow.current = rowIdx;
      setSelectedRows(new Set([rowIdx]));
    }
  }, []);

  const handleRowMouseEnter = useCallback((rowIdx: number) => {
    if (!isDragging.current) return;
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (dragMode.current === "select") next.add(rowIdx); else next.delete(rowIdx);
      return next;
    });
  }, []);

  useEffect(() => {
    const onMouseUp = () => { isDragging.current = false; };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  const exportData = async (format: "csv" | "json", forceAll = false) => {
    const rows = !forceAll && selectedRows.size > 0
      ? data.filter((_, i) => selectedRows.has(i))
      : data;

    let content: string;

    if (format === "csv") {
      const escape = (v: unknown) => {
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = columns.map(escape).join(",");
      const body = rows.map((row) => columns.map((c) => escape(row[c])).join(",")).join("\n");
      content = `${header}\n${body}`;
    } else {
      content = JSON.stringify(rows, null, 2);
    }

    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const baseName = (editableTable ?? "query").replace(/[^a-zA-Z0-9_]/g, "_");
    const path = await save({
      defaultPath: `${baseName}_${date}.${format}`,
      filters: format === "csv"
        ? [{ name: "CSV", extensions: ["csv"] }]
        : [{ name: "JSON", extensions: ["json"] }],
    });

    if (path) {
      await writeTextFile(path, content);
    }
  };

  // Focus + select only when the *target cell* changes (not on every keystroke), otherwise
  // typing would re-select the text on each change and block normal editing.
  const editingKey = editingCell ? `${editingCell.rowIdx}:${editingCell.col}` : null;
  useEffect(() => {
    if (editingKey) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editingKey]);

  const hasEdits = edits.size > 0;

  // Fixed per-column pixel widths, sampled from the loaded rows. Needed because div-based
  // virtualized rows can't rely on <table>'s automatic cross-row column sizing.
  const colWidths = useMemo(() => {
    const sampleSize = Math.min(data.length, 500);
    return columns.map((col) => {
      let maxLen = col.length;
      for (let r = 0; r < sampleSize; r++) {
        const v = data[r][col];
        const len = v === null || v === undefined ? 4 : String(v).length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(CELL_MAX_W, Math.max(CELL_MIN_W, maxLen * CELL_CHAR_W + CELL_PAD));
    });
  }, [columns, data]);

  const totalWidth = useMemo(() => MARKER_W + colWidths.reduce((a, b) => a + b, 0), [colWidths]);

  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 33,
    overscan: 20,
  });

  // Column virtualization: with wide tables (dozens of columns), rendering every column for
  // every mounted row makes each row-mount during vertical scroll cost O(columns). Only the
  // columns currently in the horizontal viewport (+ overscan) get rendered.
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i],
    overscan: 5,
  });
  const virtualColumns = columnVirtualizer.getVirtualItems();

  const startEdit = (rowIdx: number, col: string) => {
    if (!editableTable) return;
    setCommitNotice(null);
    setSelectedRows(new Set());
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

  const handleDelete = async () => {
    if (!editableTable || selectedRows.size === 0) return;
    const indices = [...selectedRows].sort((a, b) => a - b);
    const sqls = buildDeleteStatements(dbType, database, editableTable, columns, data, indices, rowIds ?? undefined);
    setDeleting(true);
    setCommitError(null);
    setCommitNotice(null);
    try {
      const affected = await onCommit(sqls);
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
      setCommitNotice({ ok: true, msg: `Deleted ${affected} row${affected === 1 ? "" : "s"}` });
    } catch (e) {
      setCommitError(String(e));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
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

        {selectedRows.size > 0 && !editingCell && (
          <span className="text-highlight text-xs">{selectedRows.size} / {data.length} selected</span>
        )}

        <div className="flex-1" />

        {commitError && (
          <span className="text-red-400 truncate max-w-[320px]" title={commitError}>{commitError}</span>
        )}

        {editableTable && selectedRows.size > 0 && !editingCell && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10 transition-colors text-xs"
            title={`Delete ${selectedRows.size} selected row${selectedRows.size > 1 ? "s" : ""}`}
          >
            <Trash2 size={11} />
            Delete {selectedRows.size}
          </button>
        )}
        {data.length > 0 && (
          <div className="flex items-center gap-0.5 text-text-muted text-[10px]">
            <Download size={10} />
            <button onClick={() => exportData("csv")} className="px-1 py-0.5 hover:text-text-primary transition-colors">CSV</button>
            <span>·</span>
            <button onClick={() => exportData("json")} className="px-1 py-0.5 hover:text-text-primary transition-colors">JSON</button>
          </div>
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
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="text-xs" style={{ width: totalWidth, minWidth: "100%" }}>
          <div className="flex sticky top-0 z-10 bg-accent border-b border-border">
            <div
              className={`flex items-center justify-center px-2 py-2 font-medium border-r border-border select-none cursor-pointer hover:bg-accent/60 transition-colors ${someSelected || allSelected ? "text-highlight" : "text-text-muted"}`}
              style={{ width: MARKER_W, flexShrink: 0 }}
              onClick={toggleAll}
              title={allSelected ? "Deselect all" : "Select all"}
            >
              #
            </div>
            {columns.map((col, i) => (
              <div
                key={col}
                className="flex items-center px-3 py-2 text-text-secondary font-medium border-r border-border last:border-r-0 truncate"
                style={{ width: colWidths[i], flexShrink: 0 }}
                title={col}
              >
                {col}
              </div>
            ))}
          </div>
          <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const rowIdx = vRow.index;
              const isSelected = selectedRows.has(rowIdx);
              return (
                <div
                  key={rowIdx}
                  className={`border-b border-border/50 transition-colors ${isSelected ? "bg-highlight/10" : "hover:bg-accent/40"}`}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: vRow.size, transform: `translateY(${vRow.start}px)` }}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); if (!selectedRows.has(rowIdx)) { lastClickedRow.current = rowIdx; setSelectedRows(new Set([rowIdx])); } }}
                >
                  <div
                    className={`absolute top-0 flex items-center justify-end px-2 border-r border-border/50 select-none cursor-pointer ${isSelected ? "bg-highlight/20 text-highlight" : "text-text-muted hover:bg-accent/60"}`}
                    style={{ left: 0, width: MARKER_W, height: "100%" }}
                    onMouseDown={(e) => handleRowMouseDown(e, rowIdx)}
                    onMouseEnter={() => handleRowMouseEnter(rowIdx)}
                  >
                    {rowIdx + 1}
                  </div>
                  {virtualColumns.map((vCol) => {
                    const col = columns[vCol.index];
                    const editKey = `${rowIdx}:${col}`;
                    const isEditing = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
                    const edited = edits.has(editKey);
                    return (
                      <div
                        key={col}
                        onMouseDown={() => { if (selectedRows.size > 0) setSelectedRows(new Set()); }}
                        onDoubleClick={() => startEdit(rowIdx, col)}
                        className={`absolute top-0 flex items-center px-3 border-r border-border/50 overflow-hidden ${
                          edited ? "bg-highlight/10 text-highlight" : "text-text-primary"
                        } ${editableTable ? "cursor-text" : ""} ${isEditing ? "select-text" : "select-none"}`}
                        style={{ left: MARKER_W + vCol.start, width: vCol.size, height: "100%" }}
                      >
                        {displayValue(cellValue(rowIdx, col))}
                        {isEditing && (
                          <input
                            ref={inputRef}
                            value={editingCell.value}
                            onChange={(e) => setEditingCell({ ...editingCell, value: e.target.value })}
                            onBlur={commitCellEdit}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitCellEdit();
                              else if (e.key === "Escape") setEditingCell(null);
                            }}
                            className="absolute inset-0 w-full h-full bg-bg border border-highlight rounded px-3 text-text-primary outline-none text-xs selection:bg-highlight/40 selection:text-text-primary"
                            style={{ userSelect: "text", WebkitUserSelect: "text" }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

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

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-sidebar border border-border rounded-xl shadow-2xl w-[360px] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-full bg-red-900/30 text-red-400 flex-shrink-0"><Trash2 size={16} /></div>
              <h2 className="text-sm font-semibold text-text-primary">Delete {selectedRows.size} row{selectedRows.size > 1 ? "s" : ""}?</h2>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-5">
              This will permanently delete <span className="font-medium text-text-primary">{selectedRows.size} row{selectedRows.size > 1 ? "s" : ""}</span> from <span className="font-mono text-highlight">{editableTable}</span>. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors">
                Cancel
              </button>
              <button onClick={handleDelete} disabled={deleting} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-red-600 text-white hover:bg-red-500 font-medium transition-colors disabled:opacity-50">
                {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <RowContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectedCount={selectedRows.size}
          totalCount={data.length}
          onExport={(format, scope) => exportData(format, scope === "all")}
          onSelectAll={() => setSelectedRows(new Set(data.map((_, i) => i)))}
          onDeselectAll={() => setSelectedRows(new Set())}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function RowContextMenu({ x, y, selectedCount, totalCount, onExport, onSelectAll, onDeselectAll, onClose }: {
  x: number; y: number;
  selectedCount: number; totalCount: number;
  onExport: (format: "csv" | "json", scope: "selected" | "all") => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  const menuW = 220;
  const menuH = 220;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;

  const item = (label: string, icon: React.ReactNode, onClick: () => void, danger = false) => (
    <button
      onClick={() => { onClick(); onClose(); }}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${danger ? "text-red-400 hover:bg-red-500/10" : "text-text-primary hover:bg-accent"}`}
    >
      <span className="text-text-muted w-3.5 flex-shrink-0">{icon}</span>
      {label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 9999, minWidth: menuW }} className="bg-sidebar border border-border rounded-lg shadow-2xl py-1 text-xs">
      {selectedCount > 0 && <>
        <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">{selectedCount} row{selectedCount > 1 ? "s" : ""} selected</div>
        {item(`Export selected as CSV`, <Download size={12} />, () => onExport("csv", "selected"))}
        {item(`Export selected as JSON`, <Download size={12} />, () => onExport("json", "selected"))}
        <div className="my-1 border-t border-border" />
      </>}
      <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">All {totalCount} rows</div>
      {item("Export all as CSV", <Download size={12} />, () => onExport("csv", "all"))}
      {item("Export all as JSON", <Download size={12} />, () => onExport("json", "all"))}
      <div className="my-1 border-t border-border" />
      {selectedCount < totalCount
        ? item("Select all rows", <Check size={12} />, onSelectAll)
        : item("Deselect all", <X size={12} />, onDeselectAll)}
    </div>
  );
}
