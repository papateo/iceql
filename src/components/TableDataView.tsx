import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4, v7 as uuidv7 } from "uuid";
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
  Trash2,
  Columns3,
  Copy,
  Eye,
  Table2,
  Braces,
  PenLine,
  Plus,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile, writeFile } from "@tauri-apps/plugin-fs";
import * as XLSX from "xlsx";
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { dracula } from "@uiw/codemirror-theme-dracula";
import { EditorView } from "@codemirror/view";
import type { ActiveConnection, QueryLog, QueryResult } from "../types";
import { tableRef, buildUpdateStatements, buildDeleteStatements, buildInsertStatements, sqlLiteral, quoteIdent } from "../utils/sql";
import { buildMongoUpdatePreview } from "../utils/mongo";
import { buildRedisUpdatePreview } from "../utils/redis";
import EditCellCtxMenu from "./EditCellCtxMenu";
import { lightTheme } from "./SqlEditor";

// Transparent background + compact font, sized by content (via CodeMirror's maxHeight prop)
// rather than filling its parent — unlike SqlEditor's customTheme, which forces height:100%
// for its own fixed-height layout and would collapse this auto-sizing card to nothing.
const jsonCardTheme = EditorView.theme({
  "&": { backgroundColor: "transparent !important", fontSize: "11px" },
  ".cm-scroller": { fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace", lineHeight: "1.6" },
});

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
  isDark: boolean;
}

interface EditCell {
  rowIdx: number;
  col: string;
  value: string | null;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 500] as const;
const MARKER_W = 40;
const CELL_CHAR_W = 7;
const CELL_MIN_W = 80;
const CELL_MAX_W = 320;
const CELL_PAD = 28;
const RESIZE_MIN_W = 50;

// Object/array cell values (Mongo documents, Postgres JSON/JSONB columns) must round-trip
// through the edit box as their JSON text, not `String(v)` — which gives "[object Object]"
// and makes every such cell look "changed" the moment it's opened and blurred, even
// untouched. Exported so ResultsPanel's edit flow uses the exact same rule.
export const stringifyCellValue = (v: unknown): string =>
  typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);

// Used by JsonDocCard's live "removed fields" hint while the user is mid-edit — parse
// failures just mean "can't tell yet," not an error worth surfacing here.
function tryParse(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

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

// Lightweight regex-based JSON syntax highlighter for the Mongo JSON view — cheap enough to
// run per document without mounting a full editor instance for each one. Input is escaped for
// HTML first, so only fixed, non-user-controlled class names ever end up inside the markup.
// Exported so ResultsPanel's Mongo query-result JSON view can reuse it without duplicating.
export function highlightJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "";
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(
    /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "text-amber-400"; // number
      if (match.startsWith('"')) {
        cls = match.endsWith(":") ? "text-sky-300" : "text-green-400"; // key vs string value
      } else if (match === "true" || match === "false") {
        cls = "text-purple-400";
      } else if (match === "null") {
        cls = "text-text-muted italic";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

export function JsonDocCard({
  doc, index, selected, edited, onToggleSelect, editable, onFieldsChange, isDark, readOnlyFields = ["_id"],
}: {
  doc: Record<string, unknown>;
  index: number;
  selected: boolean;
  // Whether this document has any pending (uncommitted) field edits — drawn from the same
  // `edits` map Grid mode uses, so the two views stay visually consistent.
  edited?: boolean;
  onToggleSelect: (e: React.MouseEvent) => void;
  // When set, a pencil button lets the user edit the document's JSON directly. Saving diffs
  // the parsed object against `doc` and reports only the changed/added top-level fields —
  // removed fields are not detected as deletions (no $unset support yet).
  editable?: boolean;
  onFieldsChange?: (rowIdx: number, changes: Record<string, unknown>) => void;
  isDark?: boolean;
  // Top-level keys excluded from the diff/edit — Mongo's "_id" by default, or Redis's
  // "key"/"type" (both fixed; changing either means a different key or structure entirely).
  readOnlyFields?: string[];
}) {
  const html = useMemo(() => highlightJson(doc), [doc]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(doc, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setText(JSON.stringify(doc, null, 2));
  }, [doc, editing]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setText(JSON.stringify(doc, null, 2));
    setParseError(null);
    setEditing(true);
  };

  const cancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setText(JSON.stringify(doc, null, 2));
    setParseError(null);
    setEditing(false);
  };

  const applyEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setParseError("Must be a JSON object");
      return;
    }
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (readOnlyFields.includes(key)) continue;
      if (JSON.stringify(value) !== JSON.stringify(doc[key])) changes[key] = value;
    }
    if (Object.keys(changes).length > 0) onFieldsChange?.(index, changes);
    setParseError(null);
    setEditing(false);
  };

  const removedFields = editing
    ? Object.keys(doc).filter((k) => !readOnlyFields.includes(k) && !(k in (tryParse(text) ?? {})))
    : [];

  return (
    <div
      onMouseDown={editing ? undefined : onToggleSelect}
      onDoubleClick={editable && !editing ? startEditing : undefined}
      className={`group relative rounded-lg border px-3 py-2.5 transition-colors ${editing ? "cursor-default" : editable ? "cursor-text" : "cursor-pointer"} ${
        selected ? "border-highlight bg-highlight/10" : edited ? "border-highlight/60" : "border-border hover:bg-accent/30"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-text-muted flex items-center gap-1.5">
          #{index + 1}
          {edited && <span className="w-1.5 h-1.5 rounded-full bg-highlight" title="Has pending changes" />}
        </span>
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <button onClick={applyEdit} className="p-0.5 rounded text-green-400 hover:bg-accent transition-colors" title="Apply changes">
                <Check size={11} />
              </button>
              <button onClick={cancelEdit} className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-accent transition-colors" title="Cancel">
                <X size={11} />
              </button>
            </>
          ) : (
            <>
              {editable && (
                <button
                  onClick={startEditing}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-highlight hover:bg-accent transition-all"
                  title="Edit document"
                >
                  <PenLine size={11} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-highlight hover:bg-accent transition-all"
                title="Copy document as JSON"
              >
                <Copy size={11} />
              </button>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <>
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded border border-highlight overflow-hidden text-[11px]"
          >
            <CodeMirror
              value={text}
              onChange={setText}
              theme={isDark ? dracula : lightTheme}
              extensions={[json(), jsonCardTheme]}
              maxHeight="500px"
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                highlightActiveLine: false,
              }}
            />
          </div>
          {parseError && <p className="text-[10px] text-red-400 mt-1">{parseError}</p>}
          {!parseError && removedFields.length > 0 && (
            <p className="text-[10px] text-yellow-400 mt-1">
              Removing fields isn't supported here — {removedFields.join(", ")} will stay unchanged.
            </p>
          )}
        </>
      ) : (
        <pre
          className="text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all text-text-primary"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
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
  isDark,
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
  // A newly-added, not-yet-committed row (RDBMS only) — always the last row in `rows` while
  // pending. Only one at a time, so index bookkeeping on discard/commit stays simple.
  const [newRowIndex, setNewRowIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [primaryKeys, setPrimaryKeys] = useState<string[]>([]);
  const [showSqlPreview, setShowSqlPreview] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [cellSel, setCellSel] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const isCellDragging = useRef(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [editCtxMenu, setEditCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [colWidthOverrides, setColWidthOverrides] = useState<Map<string, number>>(new Map());
  const lastClickedRow = useRef<number | null>(null);
  const isDragging = useRef(false);
  const dragMode = useRef<"select" | "deselect">("select");

  const allSelected = rows.length > 0 && selectedRows.size === rows.length;
  const someSelected = selectedRows.size > 0 && !allSelected;

  const toggleAll = () => setSelectedRows(allSelected ? new Set() : new Set(rows.map((_, i) => i)));

  const handleRowMouseDown = useCallback((e: React.MouseEvent, rowIdx: number) => {
    if (e.button !== 0) return;
    if (e.shiftKey && lastClickedRow.current !== null) {
      const from = Math.min(lastClickedRow.current, rowIdx);
      const to = Math.max(lastClickedRow.current, rowIdx);
      setSelectedRows((prev) => { const n = new Set(prev); for (let i = from; i <= to; i++) n.add(i); return n; });
    } else if (e.metaKey || e.ctrlKey) {
      lastClickedRow.current = rowIdx;
      setSelectedRows((prev) => { const n = new Set(prev); n.has(rowIdx) ? n.delete(rowIdx) : n.add(rowIdx); return n; });
    } else {
      isDragging.current = true;
      dragMode.current = "select";
      lastClickedRow.current = rowIdx;
      setSelectedRows(new Set([rowIdx]));
    }
  }, []);

  const handleRowMouseEnter = useCallback((rowIdx: number) => {
    if (!isDragging.current) return;
    setSelectedRows((prev) => { const n = new Set(prev); dragMode.current === "select" ? n.add(rowIdx) : n.delete(rowIdx); return n; });
  }, []);

  useEffect(() => {
    const onUp = () => { isCellDragging.current = false; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    const onUp = () => { isDragging.current = false; };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const exportData = async (format: "csv" | "json" | "sql" | "xlsx", forceAll = false) => {
    const exportRows = !forceAll && selectedRows.size > 0
      ? rows.filter((_, i) => selectedRows.has(i))
      : rows;
    const dbType = ac?.config.db_type;
    const qi = (n: string) => quoteIdent(dbType, n);
    let content: string;
    if (format === "csv") {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
      };
      content = `${columns.map(esc).join(",")}\n${exportRows.map((r) => columns.map((c) => esc(r[c])).join(",")).join("\n")}`;
    } else if (format === "sql") {
      const colList = columns.map(qi).join(", ");
      const tref = tableRef(dbType, database, table);
      content = exportRows
        .map((r) => {
          const vals = columns.map((c) => sqlLiteral(r[c])).join(", ");
          return `INSERT INTO ${tref} (${colList}) VALUES (${vals});`;
        })
        .join("\n");
    } else {
      content = JSON.stringify(exportRows, null, 2);
    }
    const date = new Date().toISOString().slice(0, 10);

    if (format === "xlsx") {
      const ws = XLSX.utils.json_to_sheet(exportRows, { header: columns });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, table.slice(0, 31));
      const buf: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      const path = await save({
        defaultPath: `${table}_${date}.xlsx`,
        filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
      });
      if (path) await writeFile(path, new Uint8Array(buf));
      return;
    }

    const ext = format === "sql" ? "sql" : format;
    const path = await save({
      defaultPath: `${table}_${date}.${ext}`,
      filters: format === "csv"
        ? [{ name: "CSV", extensions: ["csv"] }]
        : format === "sql"
        ? [{ name: "SQL", extensions: ["sql"] }]
        : [{ name: "JSON", extensions: ["json"] }],
    });
    if (path) await writeTextFile(path, content);
  };

  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilter, setShowFilter] = useState(false);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
  const [showColumns, setShowColumns] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "json">("grid");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Columns the user has chosen to display (column-visibility checklist).
  const visibleColumns = useMemo(() => columns.filter((c) => !hiddenColumns.has(c)), [columns, hiddenColumns]);

  const toggleColumn = (col: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(col)) {
        next.delete(col);
      } else {
        // Always keep at least one column visible.
        if (columns.length - next.size <= 1) return prev;
        next.add(col);
      }
      return next;
    });
  };

  const ac = activeConnections.get(configId);
  const dbType = ac?.config.db_type;
  const isMongo = dbType === "mongodb";
  const isRedis = dbType === "redis";
  // Both are "document-ish" (JSON-cell) stores rather than relational tables — used to gate
  // UI that's identical for either (JSON view, hiding SQL-only actions), while the actual
  // commit/delete logic below still dispatches per-type since the backend commands differ.
  const isDocStore = isMongo || isRedis;
  const readOnlyJsonFields = isRedis ? ["key", "type"] : ["_id"];
  // Schema default values for the open table, keyed by column name — powers "Set Default" in
  // the edit-cell context menu. Absent (undefined) when the sidebar hasn't loaded this table's
  // columns yet; in that case "Set Default" just stays hidden rather than guessing.
  const columnDefaults = useMemo(() => {
    const cols = ac?.dbColumns[`${database}.${table}`];
    if (!cols) return {};
    const map: Record<string, string | null> = {};
    cols.forEach((c) => { map[c.name] = c.column_default; });
    return map;
  }, [ac, database, table]);
  const hasEdits = edits.size > 0;
  // A pending new row still counts even with zero edited cells (it'll insert an all-default
  // row), so the commit/revert toolbar needs its own, broader check.
  const hasPendingChanges = hasEdits || newRowIndex !== null;
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
    setNewRowIndex(null);
    setSelectedRows(new Set());
    setRows([]);
    setLoadedPages(0);
    // Fetch primary keys once per table load (fire-and-forget; doesn't block data load)
    invoke<string[]>("get_primary_keys", { connectionId: ac.connectionId, database, table })
      .then((pks) => setPrimaryKeys(pks))
      .catch(() => setPrimaryKeys([]));
    const orderSql = sortCol ? ` ORDER BY ${sortCol} ${sortDir.toUpperCase()}` : "";
    const sql = `SELECT * FROM ${tableRef(ac.config.db_type, database, table)}${orderSql} LIMIT ${pageSize} OFFSET 0`;
    try {
      const res = await invoke<QueryResult>("get_table_data", {
        connectionId: ac.connectionId,
        database,
        table,
        page: 0,
        pageSize,
        sortCol,
        sortDir,
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
  }, [ac, database, table, pageSize, sortCol, sortDir]);

  // Load next page (append)
  const fetchMore = useCallback(async () => {
    if (!ac || loadingMore || !hasMore) return;
    setLoadingMore(true);
    const orderSql = sortCol ? ` ORDER BY ${sortCol} ${sortDir.toUpperCase()}` : "";
    const sql = `SELECT * FROM ${tableRef(ac.config.db_type, database, table)}${orderSql} LIMIT ${pageSize} OFFSET ${loadedPages * pageSize}`;
    try {
      const res = await invoke<QueryResult>("get_table_data", {
        connectionId: ac.connectionId,
        database,
        table,
        page: loadedPages,
        pageSize,
        sortCol,
        sortDir,
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
  }, [ac, database, table, pageSize, loadedPages, loadingMore, hasMore, sortCol, sortDir]);

  useEffect(() => { fetchInitial(); }, [fetchInitial]);

  useEffect(() => {
    if (editingCell) inputRef.current?.focus();
  }, [editingCell]);

  // Mongo's _id can't be changed via update (it would need a delete + reinsert); Redis's key
  // name and type are likewise fixed (changing type means recreating the key as a different
  // structure). Editing these is disallowed rather than silently failing on commit.
  const isCellEditable = (col: string) => !(isDocStore && readOnlyJsonFields.includes(col));

  const startEdit = (rowIdx: number, col: string) => {
    if (!isCellEditable(col)) return;
    if (selectedRows.size > 0) setSelectedRows(new Set());
    const editKey = `${rowIdx}:${col}`;
    const current: string | null = edits.has(editKey)
      ? (edits.get(editKey) === null ? null : stringifyCellValue(edits.get(editKey)))
      : (() => {
          const v = rows[rowIdx]?.[col];
          return v === null || v === undefined ? null : stringifyCellValue(v);
        })();
    setEditingCell({ rowIdx, col, value: current });
  };

  const commitCell = () => {
    if (!editingCell) return;
    const { rowIdx, col, value } = editingCell;
    const editKey = `${rowIdx}:${col}`;
    const original = rows[rowIdx]?.[col];
    const isOriginalNull = original === null || original === undefined;
    const noChange = value === null ? isOriginalNull : (!isOriginalNull && value === stringifyCellValue(original));
    if (noChange) {
      setEdits((prev) => { const n = new Map(prev); n.delete(editKey); return n; });
    } else {
      setEdits((prev) => new Map(prev).set(editKey, value));
    }
    setEditingCell(null);
  };

  const revertAll = () => {
    setEdits(new Map());
    setEditingCell(null);
    setError(null);
    // A pending new row was never persisted — drop it (it's always the last row) rather than
    // leaving a blank row sitting in the grid with nothing to "revert" it to.
    if (newRowIndex !== null) {
      setRows((prev) => prev.slice(0, -1));
      setNewRowIndex(null);
    }
  };

  // Removes just the pending new row (and only its own edits), leaving any edits on existing
  // rows untouched — unlike Revert, which discards everything.
  const discardNewRow = () => {
    if (newRowIndex === null) return;
    const prefix = `${newRowIndex}:`;
    setEdits((prev) => {
      const next = new Map(prev);
      for (const key of next.keys()) if (key.startsWith(prefix)) next.delete(key);
      return next;
    });
    setRows((prev) => prev.slice(0, -1));
    setEditingCell((prev) => (prev?.rowIdx === newRowIndex ? null : prev));
    setNewRowIndex(null);
  };

  // Appends a blank row for the user to fill in — inserted on Commit. Only RDBMS dialects
  // (not Mongo/Redis) go through this; only one pending new row at a time keeps every other
  // index-based lookup (edits, selection, sort) unambiguous.
  const handleAddRow = () => {
    if (newRowIndex !== null) return;
    const blank: Record<string, unknown> = {};
    columns.forEach((c) => { blank[c] = null; });
    const idx = rows.length;
    setRows((prev) => [...prev, blank]);
    setNewRowIndex(idx);
    setSelectedRows(new Set());
    if (visibleColumns.length > 0) setEditingCell({ rowIdx: idx, col: visibleColumns[0], value: null });
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  };

  const rowHasEdits = (rowIdx: number) => {
    const prefix = `${rowIdx}:`;
    for (const key of edits.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  // JSON view's per-document edit diff lands here — same `edits` map Grid mode uses, so Save,
  // Preview, Discard, and the edited-cell highlight all work identically either way.
  const applyJsonFieldEdits = (rowIdx: number, changes: Record<string, unknown>) => {
    setEdits((prev) => {
      const next = new Map(prev);
      for (const [field, value] of Object.entries(changes)) {
        next.set(`${rowIdx}:${field}`, stringifyCellValue(value));
      }
      return next;
    });
  };

  // Edits on the pending new row are its INSERT's values, not an UPDATE on an existing row —
  // keep them out of the update set.
  const existingRowEdits = useMemo(() => {
    if (newRowIndex === null) return edits;
    const prefix = `${newRowIndex}:`;
    const filtered = new Map(edits);
    for (const key of filtered.keys()) if (key.startsWith(prefix)) filtered.delete(key);
    return filtered;
  }, [edits, newRowIndex]);

  const buildUpdateSQL = (): string[] =>
    buildUpdateStatements(ac?.config.db_type, database, table, columns, rows, existingRowEdits, undefined, primaryKeys);

  const buildInsertSQL = (): string[] =>
    newRowIndex === null
      ? []
      : buildInsertStatements(ac?.config.db_type, database, table, rows, edits, [newRowIndex]);

  const buildMongoPreview = (): string[] => buildMongoUpdatePreview(table, rows, edits);
  const buildRedisPreview = (): string[] => buildRedisUpdatePreview(rows, edits);

  // Mongo documents have no WHERE-by-column story — every edit is a single updateOne
  // matched by _id, sent field by field through a dedicated command instead of SQL text.
  const commitAllMongo = async () => {
    if (!ac || !hasEdits) return;
    setLoading(true);
    setError(null);
    try {
      for (const [key, value] of edits.entries()) {
        const sepIdx = key.indexOf(":");
        const rowIdx = Number(key.slice(0, sepIdx));
        const col = key.slice(sepIdx + 1);
        const idJson = JSON.stringify(rows[rowIdx]?.["_id"]);
        const valueJson = value === null ? "null" : stringifyCellValue(value);
        await invoke("mongo_update_field", {
          connectionId: ac.connectionId,
          database,
          collection: table,
          idJson,
          field: col,
          valueJson,
        });
      }
      addLog({ sql: `db.${table}.update — ${edits.size} field${edits.size > 1 ? "s" : ""}`, connectionName: ac.config.name, database, status: "success", rowsAffected: edits.size });
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      addLog({ sql: `db.${table}.update — ${edits.size} field${edits.size > 1 ? "s" : ""}`, connectionName: ac.config.name, database, status: "error", error: String(e) });
      setLoading(false);
    }
  };

  // Redis keys have two editable pseudo-fields: "value" (type-aware full replace) and "ttl"
  // (EXPIRE/PERSIST) — both handled server-side by redis_update_field per the field name.
  const commitAllRedis = async () => {
    if (!ac || !hasEdits) return;
    setLoading(true);
    setError(null);
    try {
      for (const [editKey, value] of edits.entries()) {
        const sepIdx = editKey.indexOf(":");
        const rowIdx = Number(editKey.slice(0, sepIdx));
        const field = editKey.slice(sepIdx + 1);
        const key = String(rows[rowIdx]?.["key"] ?? "");
        const valueJson = value === null ? "null" : stringifyCellValue(value);
        await invoke("redis_update_field", { connectionId: ac.connectionId, database, key, field, valueJson });
      }
      addLog({ sql: `redis update — ${edits.size} field${edits.size > 1 ? "s" : ""}`, connectionName: ac.config.name, database, status: "success", rowsAffected: edits.size });
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      addLog({ sql: `redis update — ${edits.size} field${edits.size > 1 ? "s" : ""}`, connectionName: ac.config.name, database, status: "error", error: String(e) });
      setLoading(false);
    }
  };

  const commitAll = async () => {
    if (!ac || !hasPendingChanges) return;
    if (isMongo) return commitAllMongo();
    if (isRedis) return commitAllRedis();
    const sqls = [...buildInsertSQL(), ...buildUpdateSQL()];
    setLoading(true);
    setError(null);
    try {
      for (const sql of sqls) {
        const res = await invoke<QueryResult>("execute_query", { connectionId: ac.connectionId, database, query: sql, queryId: uuidv4() });
        addLog({ sql, connectionName: ac.config.name, database, status: "success", rowsAffected: (res as QueryResult).row_count, executionTimeMs: (res as QueryResult).execution_time_ms });
      }
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      addLog({ sql: sqls.join(";\n"), connectionName: ac.config.name, database, status: "error", error: String(e) });
      setLoading(false);
    }
  };

  const handleDeleteMongo = async () => {
    if (!ac || selectedRows.size === 0) return;
    const indices = [...selectedRows].sort((a, b) => a - b);
    const idJsons = indices.map((i) => JSON.stringify(rows[i]?.["_id"]));
    setDeleting(true);
    setError(null);
    try {
      const deletedCount = await invoke<number>("mongo_delete_documents", {
        connectionId: ac.connectionId,
        database,
        collection: table,
        idJsons,
      });
      addLog({ sql: `db.${table}.deleteMany`, connectionName: ac.config.name, database, status: "success", rowsAffected: deletedCount });
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleDeleteRedis = async () => {
    if (!ac || selectedRows.size === 0) return;
    const indices = [...selectedRows].sort((a, b) => a - b);
    const keys = indices.map((i) => String(rows[i]?.["key"] ?? ""));
    setDeleting(true);
    setError(null);
    try {
      const deletedCount = await invoke<number>("redis_delete_keys", { connectionId: ac.connectionId, database, keys });
      addLog({ sql: `DEL ${keys.length} key${keys.length > 1 ? "s" : ""}`, connectionName: ac.config.name, database, status: "success", rowsAffected: deletedCount });
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleDelete = async () => {
    if (!ac || selectedRows.size === 0) return;
    if (isMongo) return handleDeleteMongo();
    if (isRedis) return handleDeleteRedis();
    // A pending new row has nothing in the DB to DELETE yet — drop it locally instead.
    const indices = [...selectedRows].filter((i) => i !== newRowIndex).sort((a, b) => a - b);
    if (selectedRows.has(newRowIndex as number)) discardNewRow();
    if (indices.length === 0) {
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
      return;
    }
    const sqls = buildDeleteStatements(dbType, database, table, columns, rows, indices, undefined, primaryKeys);
    setDeleting(true);
    setError(null);
    try {
      for (const sql of sqls) {
        const res = await invoke<QueryResult>("execute_query", { connectionId: ac.connectionId, database, query: sql, queryId: uuidv4() });
        addLog({ sql, connectionName: ac.config.name, database, status: "success", rowsAffected: (res as QueryResult).row_count, executionTimeMs: (res as QueryResult).execution_time_ms });
      }
      setSelectedRows(new Set());
      setShowDeleteConfirm(false);
      await fetchInitial();
    } catch (e) {
      setError(String(e));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  const getCellValue = (rowIdx: number, col: string): unknown => {
    const editKey = `${rowIdx}:${col}`;
    return edits.has(editKey) ? edits.get(editKey) : rows[rowIdx]?.[col];
  };

  const isEdited = (rowIdx: number, col: string) => edits.has(`${rowIdx}:${col}`);

  const normCellSel = () => {
    if (!cellSel) return null;
    return { r1: Math.min(cellSel.r1, cellSel.r2), r2: Math.max(cellSel.r1, cellSel.r2), c1: Math.min(cellSel.c1, cellSel.c2), c2: Math.max(cellSel.c1, cellSel.c2) };
  };
  const isCellInSel = (displayIdx: number, colIdx: number) => {
    const s = normCellSel();
    return s ? displayIdx >= s.r1 && displayIdx <= s.r2 && colIdx >= s.c1 && colIdx <= s.c2 : false;
  };

  const selectedRowsSorted = () =>
    [...selectedRows].sort((a, b) => a - b);

  const copyRowsAsText = () => {
    const idxs = selectedRowsSorted();
    const lines = idxs.map((ri) =>
      visibleColumns.map((col) => {
        const v = getCellValue(ri, col);
        return v === null || v === undefined ? "" : String(v);
      }).join("\t")
    );
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const copyRowsAsCSV = () => {
    const esc = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
    const idxs = selectedRowsSorted();
    const header = visibleColumns.map(esc).join(",");
    const lines = idxs.map((ri) =>
      visibleColumns.map((col) => {
        const v = getCellValue(ri, col);
        return v === null || v === undefined ? "" : esc(String(v));
      }).join(",")
    );
    navigator.clipboard.writeText([header, ...lines].join("\n"));
  };

  const copyRowsAsInsertSQL = () => {
    const dbType = ac?.config.db_type ?? "mysql";
    const qi = (n: string) => quoteIdent(dbType, n);
    const colList = visibleColumns.map(qi).join(", ");
    const idxs = selectedRowsSorted();
    const lines = idxs.map((ri) => {
      const vals = visibleColumns.map((col) => sqlLiteral(getCellValue(ri, col)));
      return `INSERT INTO ${tableRef(dbType, database, table)} (${colList}) VALUES (${vals.join(", ")});`;
    });
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const copySelAsText = () => {
    const s = normCellSel();
    if (!s) return;
    const cols = visibleColumns.slice(s.c1, s.c2 + 1);
    const lines: string[] = [];
    for (let di = s.r1; di <= s.r2; di++) {
      const row = displayedRows[di];
      if (!row) continue;
      lines.push(cols.map((col) => {
        const v = getCellValue(row.__idx, col);
        return v === null || v === undefined ? "" : String(v);
      }).join("\t"));
    }
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const copySelAsCSV = () => {
    const s = normCellSel();
    if (!s) return;
    const cols = visibleColumns.slice(s.c1, s.c2 + 1);
    const esc = (v: string) => v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
    const lines: string[] = [cols.map(esc).join(",")];
    for (let di = s.r1; di <= s.r2; di++) {
      const row = displayedRows[di];
      if (!row) continue;
      const vals = cols.map((col) => {
        const v = getCellValue(row.__idx, col);
        return v === null || v === undefined ? "" : esc(String(v));
      });
      lines.push(vals.join(","));
    }
    navigator.clipboard.writeText(lines.join("\n"));
  };

  const copySelAsInsertSQL = () => {
    const s = normCellSel();
    if (!s) return;
    const cols = visibleColumns.slice(s.c1, s.c2 + 1);
    const dbType = ac?.config.db_type ?? "mysql";
    const qi = (n: string) => quoteIdent(dbType, n);
    const lines: string[] = [];
    for (let di = s.r1; di <= s.r2; di++) {
      const row = displayedRows[di];
      if (!row) continue;
      const vals = cols.map((col) => sqlLiteral(getCellValue(row.__idx, col)));
      lines.push(`INSERT INTO ${tableRef(dbType, database, table)} (${cols.map(qi).join(", ")}) VALUES (${vals.join(", ")});`);
    }
    navigator.clipboard.writeText(lines.join("\n"));
  };

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
        // A pending new row is blank by definition — don't let an unrelated filter hide it
        // out from under the user while they're still filling it in.
        if (row.__idx === newRowIndex) return true;
        const v = row[col];
        if (v === null || v === undefined) return false;
        return String(v).toLowerCase().includes(lower);
      });
    });
    // Sorting is applied server-side (ORDER BY across the whole table), so rows arrive
    // already ordered — only client-side filtering of the loaded rows happens here.
    return r;
  }, [rows, filters, newRowIndex]);

  // Fixed per-column pixel widths, sampled from the loaded rows. Needed because div-based
  // virtualized rows can't rely on <table>'s automatic cross-row column sizing. Kept separate
  // from `colWidths` so a manual resize (which only touches colWidthOverrides) doesn't re-scan
  // sample rows for every column on every drag tick.
  const baseColWidths = useMemo(() => {
    const sampleSize = Math.min(rows.length, 500);
    return visibleColumns.map((col) => {
      let maxLen = col.length;
      for (let r = 0; r < sampleSize; r++) {
        const v = rows[r][col];
        const len = v === null || v === undefined ? 4 : String(v).length;
        if (len > maxLen) maxLen = len;
      }
      return Math.min(CELL_MAX_W, Math.max(CELL_MIN_W, maxLen * CELL_CHAR_W + CELL_PAD));
    });
  }, [visibleColumns, rows]);

  const colWidths = useMemo(
    () => visibleColumns.map((col, i) => colWidthOverrides.get(col) ?? baseColWidths[i]),
    [visibleColumns, baseColWidths, colWidthOverrides]
  );

  const totalWidth = useMemo(() => MARKER_W + colWidths.reduce((a, b) => a + b, 0), [colWidths]);

  const virtualizer = useVirtualizer({
    count: displayedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 29,
    overscan: 20,
  });

  // Column virtualization: with wide tables (dozens of columns), rendering every column for
  // every mounted row makes each row-mount during vertical scroll cost O(columns). Only the
  // columns currently in the horizontal viewport (+ overscan) get rendered.
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: visibleColumns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i],
    overscan: 5,
  });
  const virtualColumns = columnVirtualizer.getVirtualItems();

  // Drag-to-resize a column header. react-virtual's internal measurement cache only
  // invalidates via an explicit resizeItem() call — just changing colWidths (state) updates
  // the header, but the virtualized body cells need resizeItem() to pick up the new size too.
  const startColumnResize = useCallback((e: React.MouseEvent, col: string, index: number, startWidth: number) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(RESIZE_MIN_W, startWidth + (ev.clientX - startX));
      setColWidthOverrides((prev) => new Map(prev).set(col, newWidth));
      columnVirtualizer.resizeItem(index, newWidth);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [columnVirtualizer]);

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
        <div className="relative">
          <button
            onClick={() => setShowColumns((v) => !v)}
            className={`p-1.5 rounded transition-colors ${hiddenColumns.size > 0 || showColumns ? "bg-highlight/20 text-highlight" : "text-text-muted hover:bg-accent hover:text-text-primary"}`}
            title="Choose visible columns"
          >
            <Columns3 size={13} />
          </button>
          {showColumns && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowColumns(false)} />
              <div className="absolute left-0 mt-1 z-50 w-56 bg-sidebar border border-border rounded-lg shadow-xl flex flex-col max-h-[60vh]">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
                  <span className="text-xs font-semibold text-text-primary">
                    Columns <span className="text-text-muted font-normal">{visibleColumns.length}/{columns.length}</span>
                  </span>
                  <button
                    onClick={() => setHiddenColumns(new Set())}
                    disabled={hiddenColumns.size === 0}
                    className="text-[10px] text-text-muted hover:text-highlight disabled:opacity-40 disabled:hover:text-text-muted transition-colors"
                  >
                    Show all
                  </button>
                </div>
                <div className="overflow-y-auto py-1">
                  {columns.map((col) => {
                    const visible = !hiddenColumns.has(col);
                    return (
                      <button
                        key={col}
                        onClick={() => toggleColumn(col)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-accent/60 transition-colors"
                      >
                        <span className={`flex items-center justify-center w-3.5 h-3.5 rounded border flex-shrink-0 ${visible ? "bg-highlight border-highlight text-bg" : "border-border text-transparent"}`}>
                          <Check size={10} />
                        </span>
                        <span className={`truncate ${visible ? "text-text-primary" : "text-text-muted"}`}>{col}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
        {!isDocStore && (
          <button
            onClick={handleAddRow}
            disabled={newRowIndex !== null}
            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-text-muted hover:text-text-primary hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={newRowIndex !== null ? "Finish or discard the current new row first" : "Add a new row"}
          >
            <Plus size={13} /> Add Row
          </button>
        )}
        {isDocStore && (
          <div className="flex items-center bg-accent/60 border border-border rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("grid")}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${viewMode === "grid" ? "bg-highlight text-bg" : "text-text-muted hover:text-text-primary"}`}
              title="Grid view"
            >
              <Table2 size={12} /> Grid
            </button>
            <button
              onClick={() => setViewMode("json")}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors ${viewMode === "json" ? "bg-highlight text-bg" : "text-text-muted hover:text-text-primary"}`}
              title="JSON view"
            >
              <Braces size={12} /> JSON
            </button>
          </div>
        )}
        <div className="flex-1" />
        {!hasPendingChanges && totalCount > 0 && (
          <span className="text-text-muted text-xs">
            {rows.length.toLocaleString()} / {totalCount.toLocaleString()} rows · {execMs}ms
          </span>
        )}
        {selectedRows.size > 0 && (
          <span className="text-highlight text-xs">{selectedRows.size} selected</span>
        )}
        {selectedRows.size > 0 && !hasPendingChanges && (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-red-400 hover:bg-red-500/10 transition-colors text-xs"
            title={`Delete ${selectedRows.size} selected row${selectedRows.size > 1 ? "s" : ""}`}
          >
            <Trash2 size={11} />
            Delete {selectedRows.size}
          </button>
        )}
        {rows.length > 0 && !hasPendingChanges && (
          <div className="flex items-center gap-0.5 text-text-muted text-[10px]">
            <Download size={10} />
            <button onClick={() => exportData("csv")} className="px-1 py-0.5 hover:text-text-primary transition-colors">CSV</button>
            <span>·</span>
            <button onClick={() => exportData("json")} className="px-1 py-0.5 hover:text-text-primary transition-colors">JSON</button>
            <span>·</span>
            {!isDocStore && (
              <>
                <button onClick={() => exportData("sql")} className="px-1 py-0.5 hover:text-text-primary transition-colors">SQL</button>
                <span>·</span>
              </>
            )}
            <button onClick={() => exportData("xlsx")} className="px-1 py-0.5 hover:text-text-primary transition-colors">Excel</button>
          </div>
        )}

        {hasPendingChanges && (
          <div className="flex items-center gap-2">
            <span className="text-text-muted text-xs">
              {[
                newRowIndex !== null ? "1 new row" : null,
                existingRowEdits.size > 0 ? `${existingRowEdits.size} change${existingRowEdits.size > 1 ? "s" : ""}` : null,
              ].filter(Boolean).join(", ")}
            </span>
            <button onClick={revertAll} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-accent border border-border text-text-secondary hover:text-text-primary transition-colors">
              <RotateCcw size={12} /> Revert
            </button>
            <button onClick={() => setShowSqlPreview(true)} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-accent border border-border text-text-secondary hover:text-text-primary transition-colors" title={isDocStore ? "Preview changes" : "Preview SQL"}>
              <Eye size={12} />
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
        ) : isDocStore && viewMode === "json" ? (
          <div className="flex flex-col gap-2 p-3">
            {displayedRows.map((row) => {
              const rowIdx = row.__idx;
              const doc = Object.fromEntries(visibleColumns.map((c) => [c, row[c]]));
              return (
                <JsonDocCard
                  key={rowIdx}
                  doc={doc}
                  index={rowIdx}
                  selected={selectedRows.has(rowIdx)}
                  edited={rowHasEdits(rowIdx)}
                  editable
                  readOnlyFields={readOnlyJsonFields}
                  isDark={isDark}
                  onFieldsChange={applyJsonFieldEdits}
                  onToggleSelect={(e) => handleRowMouseDown(e, rowIdx)}
                />
              );
            })}
          </div>
        ) : (
          <div className="text-xs" style={{ width: totalWidth, minWidth: "100%" }}>
            <div className="sticky top-0 z-10">
              <div className="flex bg-accent border-b border-border">
                <div
                  className={`flex items-center justify-center px-2 py-2 font-medium border-r border-border select-none cursor-pointer hover:bg-accent/80 transition-colors ${someSelected || allSelected ? "text-highlight" : "text-text-muted"}`}
                  style={{ width: MARKER_W, flexShrink: 0 }}
                  onClick={toggleAll}
                  title={allSelected ? "Deselect all" : "Select all"}
                >
                  #
                </div>
                {visibleColumns.map((col, i) => {
                  const isSorted = sortCol === col;
                  return (
                    <div
                      key={col}
                      className="relative flex items-center gap-1 px-3 py-2 text-text-secondary font-medium border-r border-border last:border-r-0 select-none cursor-pointer hover:bg-accent/80 group overflow-hidden"
                      style={{ width: colWidths[i], flexShrink: 0 }}
                      onClick={() => handleSortClick(col)}
                      title={col}
                    >
                      <span className={`truncate ${isSorted ? "text-highlight" : ""}`}>{col}</span>
                      {isSorted
                        ? sortDir === "asc" ? <ChevronUp size={11} className="text-highlight flex-shrink-0" /> : <ChevronDown size={11} className="text-highlight flex-shrink-0" />
                        : <ChevronsUpDown size={11} className="opacity-0 group-hover:opacity-40 transition-opacity flex-shrink-0" />}
                      <div
                        onMouseDown={(e) => startColumnResize(e, col, i, colWidths[i])}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-highlight/60 active:bg-highlight"
                      />
                    </div>
                  );
                })}
              </div>
              {showFilter && (
                <div className="flex bg-sidebar border-b border-border">
                  <div style={{ width: MARKER_W, flexShrink: 0 }} className="border-r border-border" />
                  {visibleColumns.map((col, i) => (
                    <div key={col} style={{ width: colWidths[i], flexShrink: 0 }} className="px-1 py-1 border-r border-border last:border-r-0">
                      <div className="relative">
                        <input type="text" placeholder="Filter…" value={filters[col] ?? ""} onChange={(e) => setFilters((prev) => ({ ...prev, [col]: e.target.value }))} className="w-full text-[11px] bg-accent/60 border border-transparent focus:border-border rounded px-2 py-0.5 text-text-secondary placeholder:text-text-muted outline-none focus:bg-accent pr-5" />
                        {filters[col] && (
                          <button onClick={() => clearFilter(col)} className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"><X size={10} /></button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((vRow) => {
                const displayIdx = vRow.index;
                const displayRow = displayedRows[displayIdx];
                const rowIdx = displayRow.__idx;
                const isSelected = selectedRows.has(rowIdx);
                const isNewRow = rowIdx === newRowIndex;
                return (
                  <div
                    key={rowIdx}
                    className={`border-b border-border/50 transition-colors ${isNewRow ? "bg-green-500/5" : isSelected && !cellSel ? "bg-highlight/10" : "hover:bg-accent/30"}`}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", height: vRow.size, transform: `translateY(${vRow.start}px)`, boxShadow: isNewRow ? "inset 2px 0 0 0 rgb(34 197 94)" : undefined }}
                    onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
                  >
                    {isNewRow ? (
                      <div
                        className="absolute top-0 flex items-center justify-center gap-1 px-1 border-r border-border/50 select-none"
                        style={{ left: 0, width: MARKER_W, height: "100%" }}
                      >
                        <button
                          onClick={discardNewRow}
                          className="p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"
                          title="Discard this new row"
                        >
                          <X size={11} />
                        </button>
                      </div>
                    ) : (
                      <div
                        className={`absolute top-0 flex items-center justify-end px-2 border-r border-border/50 select-none cursor-pointer ${isSelected ? "bg-highlight/20 text-highlight" : "text-text-muted hover:bg-accent/60"}`}
                        style={{ left: 0, width: MARKER_W, height: "100%" }}
                        onMouseDown={(e) => { setCellSel(null); handleRowMouseDown(e, rowIdx); }}
                        onMouseEnter={() => handleRowMouseEnter(rowIdx)}
                      >
                        {rowIdx + 1}
                      </div>
                    )}
                    {virtualColumns.map((vCol) => {
                      const colIdx = vCol.index;
                      const col = visibleColumns[colIdx];
                      const isActive = editingCell?.rowIdx === rowIdx && editingCell?.col === col;
                      const edited = isEdited(rowIdx, col);
                      const inSel = isCellInSel(displayIdx, colIdx);
                      return (
                        <div
                          key={col}
                          className={`absolute top-0 flex items-center border-r border-border/50 overflow-hidden ${isActive ? "select-text" : "select-none"} ${inSel ? "bg-blue-500/20" : edited ? "bg-highlight/10" : ""}`}
                          style={{ left: MARKER_W + vCol.start, width: vCol.size, height: "100%" }}
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            if (selectedRows.size > 0) setSelectedRows(new Set());
                            setCellSel({ r1: displayIdx, c1: colIdx, r2: displayIdx, c2: colIdx });
                            isCellDragging.current = true;
                          }}
                          onMouseEnter={() => {
                            if (!isCellDragging.current) return;
                            setCellSel((prev) => prev ? { ...prev, r2: displayIdx, c2: colIdx } : null);
                          }}
                          onDoubleClick={() => { setCellSel(null); startEdit(rowIdx, col); }}
                        >
                          {isActive ? (
                            <input ref={inputRef} className="w-full h-full px-3 bg-surface ring-1 ring-inset ring-highlight outline-none text-text-primary text-xs font-mono selection:bg-highlight/40 selection:text-text-primary" style={{ userSelect: "text", WebkitUserSelect: "text" }} value={editingCell.value ?? ""}
                              placeholder={editingCell.value === null ? "NULL" : undefined}
                              onChange={(e) => setEditingCell((prev) => prev ? { ...prev, value: e.target.value } : null)}
                              onMouseDown={(e) => e.stopPropagation()}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setEditCtxMenu({ x: e.clientX, y: e.clientY }); }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); commitCell(); }
                                if (e.key === "Escape") setEditingCell(null);
                                if (e.key === "Tab") { e.preventDefault(); commitCell(); }
                              }}
                              onBlur={commitCell}
                            />
                          ) : (
                            <div className={`px-3 w-full min-w-0 cursor-default font-mono ${edited ? "text-highlight" : "text-text-primary"}`}>
                              <CellValue value={getCellValue(rowIdx, col)} />
                              {edited && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-highlight" />}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
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
                const res = await invoke<QueryResult>("get_table_data", { connectionId: ac.connectionId, database, table, page: prevPage, pageSize, sortCol, sortDir });
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
                const res = await invoke<QueryResult>("get_table_data", { connectionId: ac.connectionId, database, table, page: nextPage, pageSize, sortCol, sortDir });
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

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-sidebar border border-border rounded-xl shadow-2xl w-[360px] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 rounded-full bg-red-900/30 text-red-400 flex-shrink-0"><Trash2 size={16} /></div>
              <h2 className="text-sm font-semibold text-text-primary">Delete {selectedRows.size} row{selectedRows.size > 1 ? "s" : ""}?</h2>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-5">
              This will permanently delete <span className="font-medium text-text-primary">{selectedRows.size} row{selectedRows.size > 1 ? "s" : ""}</span> from <span className="font-mono text-highlight">{table}</span>. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors">Cancel</button>
              <button onClick={handleDelete} disabled={deleting} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-red-600 text-white hover:bg-red-500 font-medium transition-colors disabled:opacity-50">
                {deleting ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <TableCtxMenu
          x={ctxMenu.x} y={ctxMenu.y}
          selectedCount={selectedRows.size} totalCount={rows.length}
          hasCellSel={!!cellSel}
          hideSql={isDocStore}
          onCopy={copySelAsText}
          onCopyCSV={copySelAsCSV}
          onCopyInsertSQL={copySelAsInsertSQL}
          onCopyRows={copyRowsAsText}
          onCopyRowsCSV={copyRowsAsCSV}
          onCopyRowsInsertSQL={copyRowsAsInsertSQL}
          onExport={(fmt, scope) => exportData(fmt, scope === "all")}
          onSelectAll={() => setSelectedRows(new Set(rows.map((_, i) => i)))}
          onDeselectAll={() => setSelectedRows(new Set())}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {editCtxMenu && editingCell && (
        <EditCellCtxMenu
          x={editCtxMenu.x} y={editCtxMenu.y}
          onClose={() => setEditCtxMenu(null)}
          onCopy={() => navigator.clipboard.writeText(editingCell.value ?? "")}
          onCut={() => {
            navigator.clipboard.writeText(editingCell.value ?? "");
            setEditingCell((prev) => prev ? { ...prev, value: "" } : null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onPaste={async () => {
            const text = await navigator.clipboard.readText();
            setEditingCell((prev) => prev ? { ...prev, value: text } : null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onSetNull={() => {
            setEditingCell((prev) => prev ? { ...prev, value: null } : null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          hasDefault={columnDefaults[editingCell.col] !== undefined && columnDefaults[editingCell.col] !== null}
          onSetDefault={() => {
            const def = columnDefaults[editingCell.col];
            setEditingCell((prev) => prev ? { ...prev, value: def ?? null } : null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
          onGenerateUuid={(version) => {
            setEditingCell((prev) => prev ? { ...prev, value: version === "v4" ? uuidv4() : uuidv7() } : null);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      )}

      {showSqlPreview && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowSqlPreview(false)}>
          <div className="bg-sidebar border border-border rounded-xl shadow-2xl w-[640px] max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-2">
                <Eye size={14} className="text-highlight" />
                <span className="text-sm font-semibold text-text-primary">{isDocStore ? "Preview changes" : "Preview SQL"}</span>
                <span className="text-text-muted text-xs">
                  — {[...buildInsertSQL(), ...buildUpdateSQL()].length || edits.size} statement{([...buildInsertSQL(), ...buildUpdateSQL()].length || edits.size) === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const text = isMongo ? buildMongoPreview().join("\n\n") : isRedis ? buildRedisPreview().join("\n\n") : [...buildInsertSQL(), ...buildUpdateSQL()].join(";\n");
                    navigator.clipboard.writeText(text);
                    setPreviewCopied(true);
                    setTimeout(() => setPreviewCopied(false), 1500);
                  }}
                  className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${previewCopied ? "text-green-400" : "text-text-muted hover:text-text-primary hover:bg-accent"}`}
                >
                  {previewCopied ? <><Check size={12} /> Copied</> : "Copy"}
                </button>
                <button onClick={() => setShowSqlPreview(false)} className="text-text-muted hover:text-text-primary transition-colors"><X size={14} /></button>
              </div>
            </div>
            <pre className="flex-1 overflow-auto px-4 py-3 text-xs font-mono text-text-primary leading-relaxed whitespace-pre-wrap break-all">
              {isMongo ? buildMongoPreview().join("\n\n") : isRedis ? buildRedisPreview().join("\n\n") : [...buildInsertSQL(), ...buildUpdateSQL()].join(";\n\n")}
            </pre>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
              <button onClick={() => setShowSqlPreview(false)} className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors">Close</button>
              <button onClick={() => { setShowSqlPreview(false); commitAll(); }} disabled={loading} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-highlight text-bg hover:bg-highlight/90 font-medium transition-colors disabled:opacity-50">
                <Check size={12} /> Commit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TableCtxMenu({ x, y, selectedCount, totalCount, hasCellSel, hideSql, onCopy, onCopyCSV, onCopyInsertSQL, onCopyRows, onCopyRowsCSV, onCopyRowsInsertSQL, onExport, onSelectAll, onDeselectAll, onClose }: {
  x: number; y: number;
  selectedCount: number; totalCount: number;
  hasCellSel: boolean;
  hideSql?: boolean;
  onCopy: () => void;
  onCopyCSV: () => void;
  onCopyInsertSQL: () => void;
  onCopyRows: () => void;
  onCopyRowsCSV: () => void;
  onCopyRowsInsertSQL: () => void;
  onExport: (format: "csv" | "json" | "sql" | "xlsx", scope: "selected" | "all") => void;
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
      {hasCellSel && <>
        {btn("Copy", <Copy size={12} />, onCopy)}
        {btn("Copy as CSV", <Copy size={12} />, onCopyCSV)}
        {!hideSql && btn("Copy as Insert SQL", <Copy size={12} />, onCopyInsertSQL)}
        <div className="my-1 border-t border-border" />
      </>}
      {selectedCount > 0 && <>
        <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">{selectedCount} row{selectedCount > 1 ? "s" : ""} selected</div>
        {btn("Copy", <Copy size={12} />, onCopyRows)}
        {btn("Copy as CSV", <Copy size={12} />, onCopyRowsCSV)}
        {!hideSql && btn("Copy as Insert SQL", <Copy size={12} />, onCopyRowsInsertSQL)}
        <div className="my-1 border-t border-border" />
        {btn("Export selected as CSV", <Download size={12} />, () => onExport("csv", "selected"))}
        {btn("Export selected as JSON", <Download size={12} />, () => onExport("json", "selected"))}
        {!hideSql && btn("Export selected as SQL Insert", <Download size={12} />, () => onExport("sql", "selected"))}
        {btn("Export selected as Excel", <Download size={12} />, () => onExport("xlsx", "selected"))}
        <div className="my-1 border-t border-border" />
      </>}
      <div className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">All {totalCount} rows (this page)</div>
      {btn("Export all as CSV", <Download size={12} />, () => onExport("csv", "all"))}
      {btn("Export all as JSON", <Download size={12} />, () => onExport("json", "all"))}
      {!hideSql && btn("Export all as SQL Insert", <Download size={12} />, () => onExport("sql", "all"))}
      {btn("Export all as Excel", <Download size={12} />, () => onExport("xlsx", "all"))}
      <div className="my-1 border-t border-border" />
      {selectedCount < totalCount
        ? btn("Select all rows", <Check size={12} />, onSelectAll)
        : btn("Deselect all", <X size={12} />, onDeselectAll)}
    </div>
  );
}
