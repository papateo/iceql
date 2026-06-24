import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import {
  RefreshCw,
  Loader2,
  Check,
  RotateCcw,
  ChevronsUpDown,
  ChevronUp,
  ChevronDown,
  X,
  Search,
  Download,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { ActiveConnection, QueryLog, QueryResult } from "../types";
import { tableRef, buildUpdateStatements } from "../utils/sql";

interface Props {
  configId: string;
  database: string;
  table: string;
  activeConnections: Map<string, ActiveConnection>;
  addLog: (log: Omit<QueryLog, "id" | "timestamp">) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  infiniteScroll: boolean;
  onInfiniteScrollChange: (value: boolean) => void;
}

interface EditCell {
  rowIdx: number;
  col: string;
  value: string;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 500] as const;

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
  pageSize,
  onPageSizeChange,
  infiniteScroll,
  onInfiniteScrollChange,
}: Props) {
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loadedPages, setLoadedPages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [execMs, setExecMs] = useState(0);

  const [edits, setEdits] = useState<Map<string, unknown>>(new Map());
  const [editingCell, setEditingCell] = useState<EditCell | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const lastClickedRow = useRef<number | null>(null);
  const isDragging = useRef(false);
  const dragMode = useRef<"select" | "deselect">("select");

  const allSelected = rows.length > 0 && selectedRows.size === rows.length;
  const someSelected = selectedRows.size > 0 && !allSelected;

  const toggleAll = () => setSelectedRows(allSelected ? new Set() : new Set(rows.map((_, i) => i)));

  const handleRowMouseDown = useCallback((e: React.MouseEvent, rowIdx: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && lastClickedRow.current !== null) {
      const from = Math.min(lastClickedRow.current, rowIdx);
      const to = Math.max(lastClickedRow.current, rowIdx);
      setSelectedRows((prev) => { const n = new Set(prev); for (let i = from; i <= to; i++) n.add(i); return n; });
    } else {
      isDragging.current = true;
      dragMode.current = selectedRows.has(rowIdx) ? "deselect" : "select";
      lastClickedRow.current = rowIdx;
      setSelectedRows((prev) => { const n = new Set(prev); dragMode.current === "select" ? n.add(rowIdx) : n.delete(rowIdx); return n; });
    }
  }, [selectedRows]);

  const handleRowMouseEnter = useCallback((rowIdx: number) => {
    if (!isDragging.current) return;
    setSelectedRows((prev) => { const n = new Set(prev); dragMode.current === "select" ? n.add(rowIdx) : n.delete(rowIdx); return n; });
  }, []);

  useEffect(() => {
    const onUp = () => { isDragging.current = false; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const exportData = async (format: "csv" | "json", forceAll = false) => {
    const exportRows = !forceAll && selectedRows.size > 0
      ? rows.filter((_, i) => selectedRows.has(i))
      : rows;
    let content: string;
    if (format === "csv") {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      content = `${columns.map(esc).join(",")}\n${exportRows.map((r) => columns.map((c) => esc(r[c])).join(",")).join("\n")}`;
    } else {
      content = JSON.stringify(exportRows, null, 2);
    }
    const date = new Date().toISOString().slice(0, 10);
    const path = await save({
      defaultPath: `${table}_${date}.${format}`,
      filters: format === "csv" ? [{ name: "CSV", extensions: ["csv"] }] : [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) await writeTextFile(path, content);
  };

  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilter, setShowFilter] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ac = activeConnections.get(configId);
  const hasEdits = edits.size > 0;
  const hasMore = rows.length < totalCount;
  const totalPages = Math.ceil(totalCount / pageSize) || 1;
  const currentPage = loadedPages - 1;

  // Initial load
  const fetchInitial = useCallback(async () => {
    if (!ac) return;
    setLoading(true);
    setError(null);
    setEdits(new Map());
    setEditingCell(null);
    setSortCol(null);
    setFilters({});
    setRows([]);
    setLoadedPages(0);
    const sql = `SELECT * FROM ${tableRef(ac.config.db_type, database, table)} LIMIT ${pageSize} OFFSET 0`;
    try {
      const res = await invoke<QueryResult>("get_table_data", {
        connectionId: ac.connectionId,
        database,
        table,
        page: 0,
        pageSize,
      });
      setColumns(res.columns);
      setTotalCount(res.row_count);
      setExecMs(res.execution_time_ms);
      setRows(res.rows.map((row) => {
        const obj: Record<string, unknown> = {};
        res.columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      }));
      setLoadedPages(1);
      addLog({ sql, connectionName: ac.config.name, database, status: "success", rowsAffected: res.row_count, executionTimeMs: res.execution_time_ms });
    } catch (e) {
      setError(String(e));
      addLog({ sql, connectionName: ac.config.name, database, status: "error", error: String(e) });
    } finally {
      setLoading(false);
    }
  }, [ac, database, table, pageSize]);

  // Load next page (append)
  const fetchMore = useCallback(async () => {
    if (!ac || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const sql = `SELECT * FROM ${tableRef(ac.config.db_type, database, table)} LIMIT ${pageSize} OFFSET ${loadedPages * pageSize}`;
    try {
      const res = await invoke<QueryResult>("get_table_data", {
        connectionId: ac.connectionId,
        database,
        table,
        page: loadedPages,
        pageSize,
      });
      setRows((prev) => [
        ...prev,
        ...res.rows.map((row) => {
          const obj: Record<string, unknown> = {};
          res.columns.forEach((col, i) => { obj[col] = row[i]; });
          return obj;
        }),
      ]);
      setLoadedPages((p) => p + 1);
      addLog({ sql, connectionName: ac.config.name, database, status: "success", rowsAffected: res.row_count, executionTimeMs: res.execution_time_ms });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingMore(false);
    }
  }, [ac, database, table, pageSize, loadedPages, loadingMore, hasMore]);

  useEffect(() => { fetchInitial(); }, [fetchInitial]);

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
      setEdits((prev) => { const n = new Map(prev); n.delete(editKey); return n; });
    } else {
      setEdits((prev) => new Map(prev).set(editKey, value));
    }
    setEditingCell(null);
  };

  const revertAll = () => { setEdits(new Map()); setEditingCell(null); };

  const buildUpdateSQL = (): string[] =>
    buildUpdateStatements(ac?.config.db_type, database, table, columns, rows, edits);

  const commitAll = async () => {
    if (!ac || !hasEdits) return;
    const sqls = buildUpdateSQL();
    setLoading(true);
    setError(null);
    try {
      for (const sql of sqls) {
        const res = await invoke<QueryResult>("execute_query", { connectionId: ac.connectionId, database, query: sql });
        addLog({ sql, connectionName: ac.config.name, database, status: "success", rowsAffected: (res as QueryResult).row_count, executionTimeMs: (res as QueryResult).execution_time_ms });
      }
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      addLog({ sql: sqls.join(";\n"), connectionName: ac.config.name, database, status: "error", error: String(e) });
      setLoading(false);
    }
  };

  const getCellValue = (rowIdx: number, col: string): unknown => {
    const editKey = `${rowIdx}:${col}`;
    return edits.has(editKey) ? edits.get(editKey) : rows[rowIdx]?.[col];
  };

  const isEdited = (rowIdx: number, col: string) => edits.has(`${rowIdx}:${col}`);

  const handleSortClick = (col: string) => {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("asc"); }
  };

  const clearFilter = (col: string) => {
    setFilters((prev) => { const n = { ...prev }; delete n[col]; return n; });
  };

  const displayedRows = useMemo(() => {
    let r: (Record<string, unknown> & { __idx: number })[] = rows.map((row, idx) => ({ ...row, __idx: idx }));
    Object.entries(filters).forEach(([col, val]) => {
      if (!val) return;
      const lower = val.toLowerCase();
      r = r.filter((row) => {
        const v = row[col];
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase().includes(lower);
      });
    });
    if (sortCol) {
      r = [...r].sort((a, b) => {
        const av = a[sortCol], bv = b[sortCol];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return r;
  }, [rows, filters, sortCol, sortDir]);

  const virtualizer = useVirtualizer({
    count: displayedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 20,
  });

  // Trigger fetchMore when near end — only when infinite scroll is ON
  useEffect(() => {
    if (!infiniteScroll) return;
    const items = virtualizer.getVirtualItems();
    if (!items.length) return;
    const lastItem = items[items.length - 1];
    if (lastItem.index >= displayedRows.length - 10 && hasMore && !loadingMore && !loading) {
      fetchMore();
    }
  }, [virtualizer.getVirtualItems(), displayedRows.length, hasMore, loadingMore, loading, fetchMore, infiniteScroll]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border bg-sidebar">
        <span className="text-text-secondary text-xs font-mono">
          {database}.<span className="text-text-primary">{table}</span>
        </span>
        <button
          onClick={() => setShowFilter((v) => !v)}
          className={`p-1.5 rounded transition-colors ${showFilter ? "bg-highlight/20 text-highlight" : "text-text-muted hover:bg-accent hover:text-text-primary"}`}
          title="Toggle filter row"
        >
          <Search size={13} />
        </button>
        <div className="flex-1" />
        {!hasEdits && totalCount > 0 && (
          <span className="text-text-muted text-xs">
            {rows.length.toLocaleString()} / {totalCount.toLocaleString()} rows · {execMs}ms
          </span>
        )}
        {selectedRows.size > 0 && (
          <span className="text-highlight text-xs">{selectedRows.size} selected</span>
        )}
        {rows.length > 0 && !hasEdits && (
          <div className="flex items-center gap-0.5 text-text-muted text-[10px]">
            <Download size={10} />
            <button onClick={() => exportData("csv")} className="px-1 py-0.5 hover:text-text-primary transition-colors">CSV</button>
            <span>·</span>
            <button onClick={() => exportData("json")} className="px-1 py-0.5 hover:text-text-primary transition-colors">JSON</button>
          </div>
        )}

        {hasEdits && (
          <div className="flex items-center gap-2">
            <span className="text-text-muted text-xs">{edits.size} change{edits.size > 1 ? "s" : ""}</span>
            <button onClick={revertAll} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-accent border border-border text-text-secondary hover:text-text-primary transition-colors">
              <RotateCcw size={12} /> Revert
            </button>
            <button onClick={commitAll} disabled={loading} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-highlight text-bg hover:bg-highlight/90 transition-colors disabled:opacity-50">
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Commit
            </button>
          </div>
        )}

        <button onClick={fetchInitial} disabled={loading} className="p-1.5 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors" title="Refresh">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-900/20 border-b border-red-800/50 text-red-300 text-xs">{error}</div>
      )}

      {/* Table */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-muted gap-2">
            <Loader2 size={16} className="animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-accent border-b border-border">
                <th className="px-2 py-2 w-8 border-r border-border text-center">
                  <input type="checkbox" checked={allSelected} ref={(el) => { if (el) el.indeterminate = someSelected; }} onChange={toggleAll} className="cursor-pointer accent-highlight" title="Select all" />
                </th>
                <th className="px-2 py-2 text-left text-text-muted font-medium w-10 border-r border-border select-none">#</th>
                {columns.map((col) => {
                  const isSorted = sortCol === col;
                  return (
                    <th key={col} className="px-3 py-2 text-left text-text-secondary font-medium whitespace-nowrap border-r border-border last:border-r-0 select-none cursor-pointer hover:bg-accent/80 group" onClick={() => handleSortClick(col)}>
                      <div className="flex items-center gap-1">
                        <span className={isSorted ? "text-highlight" : ""}>{col}</span>
                        {isSorted
                          ? sortDir === "asc" ? <ChevronUp size={11} className="text-highlight" /> : <ChevronDown size={11} className="text-highlight" />
                          : <ChevronsUpDown size={11} className="opacity-0 group-hover:opacity-40 transition-opacity" />}
                      </div>
                    </th>
                  );
                })}
              </tr>
              {showFilter && (
                <tr className="bg-sidebar border-b border-border">
                  <td className="w-8 border-r border-border" /><td className="w-10 border-r border-border" />
                  {columns.map((col) => (
                    <td key={col} className="px-1 py-1 border-r border-border last:border-r-0">
                      <div className="relative">
                        <input type="text" placeholder="Filter…" value={filters[col] ?? ""} onChange={(e) => setFilters((prev) => ({ ...prev, [col]: e.target.value }))} className="w-full text-[11px] bg-accent/60 border border-transparent focus:border-border rounded px-2 py-0.5 text-text-secondary placeholder:text-text-muted outline-none focus:bg-accent pr-5" />
                        {filters[col] && (
                          <button onClick={() => clearFilter(col)} className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"><X size={10} /></button>
                        )}
                      </div>
                    </td>
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {virtualizer.getVirtualItems().length > 0 && (
                <tr><td style={{ height: virtualizer.getVirtualItems()[0].start }} colSpan={columns.length + 2} className="p-0 border-0" /></tr>
              )}
              {virtualizer.getVirtualItems().map((vRow) => {
                const displayRow = displayedRows[vRow.index];
                const rowIdx = displayRow.__idx;
                const isSelected = selectedRows.has(rowIdx);
                return (
                  <tr
                    key={rowIdx}
                    className={`border-b border-border/50 transition-colors select-none ${isSelected ? "bg-highlight/10" : "hover:bg-accent/30"}`}
                    onMouseDown={(e) => handleRowMouseDown(e, rowIdx)}
                    onMouseEnter={() => handleRowMouseEnter(rowIdx)}
                    onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); if (!selectedRows.has(rowIdx)) { lastClickedRow.current = rowIdx; setSelectedRows(new Set([rowIdx])); } }}
                  >
                    <td className="px-2 py-1.5 w-8 border-r border-border/50 text-center" onMouseDown={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isSelected} onChange={() => { lastClickedRow.current = rowIdx; setSelectedRows((prev) => { const n = new Set(prev); n.has(rowIdx) ? n.delete(rowIdx) : n.add(rowIdx); return n; }); }} className="cursor-pointer accent-highlight" />
                    </td>
                    <td className="px-2 py-1.5 text-text-muted w-10 border-r border-border/50 text-right select-none">{rowIdx + 1}</td>
                    {columns.map((col) => {
                      const isActive = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
                      const edited = isEdited(rowIdx, col);
                      return (
                        <td key={col} className={`relative border-r border-border/50 last:border-r-0 max-w-[400px] ${edited ? "bg-highlight/10" : ""}`} onDoubleClick={() => startEdit(rowIdx, col)}>
                          {isActive ? (
                            <input ref={inputRef} className="w-full h-full px-3 py-1.5 bg-surface border border-highlight outline-none text-text-primary text-xs font-mono" value={editingCell.value}
                              onChange={(e) => setEditingCell((prev) => prev ? { ...prev, value: e.target.value } : null)}
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
                              {edited && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-highlight" />}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {virtualizer.getVirtualItems().length > 0 && (() => {
                const items = virtualizer.getVirtualItems();
                const bottomPad = virtualizer.getTotalSize() - items[items.length - 1].end;
                return bottomPad > 0
                  ? <tr><td style={{ height: bottomPad }} colSpan={columns.length + 2} className="p-0 border-0" /></tr>
                  : null;
              })()}
            </tbody>
          </table>
        )}

        {!loading && displayedRows.length === 0 && !error && (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            {rows.length === 0 ? "Table is empty" : "No rows match the filter"}
          </div>
        )}

        {loadingMore && (
          <div className="flex items-center justify-center py-3 text-text-muted gap-2">
            <Loader2 size={13} className="animate-spin" />
            <span className="text-xs">Loading more…</span>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-t border-border bg-sidebar">
        {/* Pagination (only when infinite scroll OFF) */}
        {!infiniteScroll ? (
          <>
            <button
              onClick={async () => {
              if (!ac || currentPage === 0) return;
              const prevPage = currentPage - 1;
              setLoading(true);
              setError(null);
              try {
                const res = await invoke<QueryResult>("get_table_data", { connectionId: ac.connectionId, database, table, page: prevPage, pageSize });
                setColumns(res.columns);
                setTotalCount(res.row_count);
                setExecMs(res.execution_time_ms);
                setRows(res.rows.map((row) => { const obj: Record<string, unknown> = {}; res.columns.forEach((col, i) => { obj[col] = row[i]; }); return obj; }));
                setLoadedPages(prevPage + 1);
                scrollRef.current?.scrollTo(0, 0);
              } catch (e) { setError(String(e)); } finally { setLoading(false); }
            }}
              disabled={currentPage === 0 || loading}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              ← Prev
            </button>
            <span className="text-text-muted text-xs whitespace-nowrap">
              Page {currentPage + 1} of {totalPages} · {totalCount.toLocaleString()} rows
            </span>
            <button
              onClick={async () => {
              if (!ac || !hasMore) return;
              const nextPage = currentPage + 1;
              setLoading(true);
              setError(null);
              try {
                const res = await invoke<QueryResult>("get_table_data", { connectionId: ac.connectionId, database, table, page: nextPage, pageSize });
                setColumns(res.columns);
                setTotalCount(res.row_count);
                setExecMs(res.execution_time_ms);
                setRows(res.rows.map((row) => { const obj: Record<string, unknown> = {}; res.columns.forEach((col, i) => { obj[col] = row[i]; }); return obj; }));
                setLoadedPages(nextPage + 1);
                scrollRef.current?.scrollTo(0, 0);
              } catch (e) { setError(String(e)); } finally { setLoading(false); }
            }}
              disabled={!hasMore || loading}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-text-muted hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              Next →
            </button>
          </>
        ) : (
          <span className="text-text-muted text-xs">
            {rows.length.toLocaleString()} / {totalCount.toLocaleString()} rows loaded
          </span>
        )}

        <div className="flex-1" />

        {/* Rows per page */}
        <div className="flex items-center gap-1.5">
          <span className="text-text-muted text-xs">Rows:</span>
          <div className="flex items-center gap-0.5">
            {PAGE_SIZE_OPTIONS.map((opt) => (
              <button key={opt} onClick={() => onPageSizeChange(opt)} className={`px-2 py-0.5 rounded text-xs transition-colors ${pageSize === opt ? "bg-highlight text-bg font-medium" : "text-text-muted hover:text-text-primary hover:bg-accent"}`}>
                {opt}
              </button>
            ))}
          </div>
        </div>

        {/* Infinite scroll toggle */}
        <button
          onClick={() => onInfiniteScrollChange(!infiniteScroll)}
          className="flex items-center gap-2 text-xs text-text-muted hover:text-text-primary transition-colors"
          title="Toggle infinite scroll"
        >
          <span className={`inline-flex items-center w-7 h-4 rounded-full transition-colors flex-shrink-0 ${infiniteScroll ? "bg-highlight" : "bg-border"}`}>
            <span className={`inline-block w-3 h-3 rounded-full bg-white shadow transition-transform mx-0.5 ${infiniteScroll ? "translate-x-3" : "translate-x-0"}`} />
          </span>
          <span className={infiniteScroll ? "text-highlight" : ""}>Infinite scroll</span>
        </button>
      </div>

      {ctxMenu && (
        <TableCtxMenu
          x={ctxMenu.x} y={ctxMenu.y}
          selectedCount={selectedRows.size} totalCount={rows.length}
          onExport={(fmt, scope) => exportData(fmt, scope === "all")}
          onSelectAll={() => setSelectedRows(new Set(rows.map((_, i) => i)))}
          onDeselectAll={() => setSelectedRows(new Set())}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function TableCtxMenu({ x, y, selectedCount, totalCount, onExport, onSelectAll, onDeselectAll, onClose }: {
  x: number; y: number;
  selectedCount: number; totalCount: number;
  onExport: (format: "csv" | "json", scope: "selected" | "all") => void;
  onSelectAll: () => void; onDeselectAll: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);

  const menuW = 220;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + 240 > window.innerHeight ? y - 240 : y;

  const btn = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <button onClick={() => { onClick(); onClose(); }} className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-text-primary hover:bg-accent transition-colors">
      <span className="text-text-muted w-3.5 flex-shrink-0">{icon}</span>{label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 9999, minWidth: menuW }} className="bg-sidebar border border-border rounded-lg shadow-2xl py-1">
      {selectedCount > 0 && <>
        <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">{selectedCount} row{selectedCount > 1 ? "s" : ""} selected</div>
        {btn("Export selected as CSV", <Download size={12} />, () => onExport("csv", "selected"))}
        {btn("Export selected as JSON", <Download size={12} />, () => onExport("json", "selected"))}
        <div className="my-1 border-t border-border" />
      </>}
      <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">All {totalCount} rows (this page)</div>
      {btn("Export all as CSV", <Download size={12} />, () => onExport("csv", "all"))}
      {btn("Export all as JSON", <Download size={12} />, () => onExport("json", "all"))}
      <div className="my-1 border-t border-border" />
      {selectedCount < totalCount
        ? btn("Select all rows", <Check size={12} />, onSelectAll)
        : btn("Deselect all", <X size={12} />, onDeselectAll)}
    </div>
  );
}
