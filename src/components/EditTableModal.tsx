import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Plus, Trash2, RotateCcw, Loader2, AlertCircle, CheckCircle2, Copy, Check } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { QueryResult } from "../types";

export interface EditTableTarget {
  connectionId: string;
  dbType: string;
  database: string;
  tableName: string;
}

// ─── Column types ────────────────────────────────────────────────────────────
interface ColDef {
  _key: string;
  _status: "original" | "modified" | "new" | "deleted";
  _origName: string;
  name: string;
  colType: string;
  length: string;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string;
}

// ─── Index types ─────────────────────────────────────────────────────────────
interface ExistingIndex {
  name: string;
  columns: string;
  unique: boolean;
  indexType: string;
  dropping: boolean; // marked for drop
}

interface NewIndex {
  _key: string;
  name: string;
  columns: string[]; // selected column names
  unique: boolean;
  fulltext: boolean;
}

// ─── FK types ────────────────────────────────────────────────────────────────
interface ExistingFK {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
  dropping: boolean;
}

interface NewFK {
  _key: string;
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
}

const FK_ACTIONS = ["RESTRICT", "CASCADE", "SET NULL", "NO ACTION"];

// ─── Column type lists ────────────────────────────────────────────────────────
const MYSQL_TYPES = [
  "INT","BIGINT","SMALLINT","TINYINT","MEDIUMINT",
  "DECIMAL","FLOAT","DOUBLE",
  "VARCHAR","CHAR","TEXT","TINYTEXT","MEDIUMTEXT","LONGTEXT",
  "DATE","DATETIME","TIMESTAMP","TIME","YEAR",
  "BOOLEAN","JSON","BLOB","LONGBLOB","ENUM",
];
const PG_TYPES = [
  "INTEGER","BIGINT","SMALLINT","SERIAL","BIGSERIAL",
  "NUMERIC","REAL","DOUBLE PRECISION",
  "VARCHAR","CHAR","TEXT",
  "BOOLEAN","DATE","TIMESTAMP","TIMESTAMPTZ","TIME",
  "JSON","JSONB","UUID","BYTEA",
];
const TYPES_WITH_LENGTH = new Set(["VARCHAR","CHAR","DECIMAL","NUMERIC","FLOAT","DOUBLE"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseColType(raw: string): { colType: string; length: string } {
  const m = raw.match(/^([A-Za-z ]+?)(?:\(([^)]+)\))?(?:\s.*)?$/);
  if (!m) return { colType: raw.toUpperCase(), length: "" };
  return { colType: m[1].trim().toUpperCase(), length: m[2] ?? "" };
}

function buildTypeSql(col: ColDef): string {
  return TYPES_WITH_LENGTH.has(col.colType) && col.length
    ? `${col.colType}(${col.length})`
    : col.colType;
}

function buildColDef(dbType: string, col: ColDef): string {
  const type = buildTypeSql(col);
  const nn = col.nullable ? "NULL" : "NOT NULL";
  const ai = col.autoIncrement && dbType !== "postgresql" ? " AUTO_INCREMENT" : "";
  const pk = col.primaryKey ? " PRIMARY KEY" : "";
  const def = col.defaultValue !== "" ? ` DEFAULT ${col.defaultValue}` : "";
  return `${type} ${nn}${def}${ai}${pk}`;
}

function generateSQL(
  dbType: string,
  database: string,
  tableName: string,
  cols: ColDef[],
  existingIndexes: ExistingIndex[],
  newIndexes: NewIndex[],
  existingFKs: ExistingFK[],
  newFKs: NewFK[],
): string[] {
  const w = (n: string) => dbType === "postgresql" ? `"${n}"` : `\`${n}\``;
  const tbl = dbType === "postgresql"
    ? w(tableName)
    : `\`${database}\`.\`${tableName}\``;

  const sqls: string[] = [];
  const mysqlColParts: string[] = [];

  // ── Columns ──
  for (const col of cols) {
    if (col._status === "deleted") {
      if (dbType === "postgresql") sqls.push(`ALTER TABLE ${tbl}\n  DROP COLUMN ${w(col._origName)};`);
      else mysqlColParts.push(`  DROP COLUMN ${w(col._origName)}`);
    } else if (col._status === "new") {
      if (dbType === "postgresql") sqls.push(`ALTER TABLE ${tbl}\n  ADD COLUMN ${w(col.name)} ${buildColDef(dbType, col)};`);
      else mysqlColParts.push(`  ADD COLUMN ${w(col.name)} ${buildColDef(dbType, col)}`);
    } else if (col._status === "modified") {
      if (dbType === "postgresql") {
        if (col._origName !== col.name) sqls.push(`ALTER TABLE ${tbl} RENAME COLUMN ${w(col._origName)} TO ${w(col.name)};`);
        sqls.push(`ALTER TABLE ${tbl}\n  ALTER COLUMN ${w(col.name)} TYPE ${buildTypeSql(col)},\n  ALTER COLUMN ${w(col.name)} ${col.nullable ? "DROP NOT NULL" : "SET NOT NULL"};`);
      } else {
        const def = buildColDef(dbType, col);
        if (col._origName !== col.name) mysqlColParts.push(`  CHANGE COLUMN ${w(col._origName)} ${w(col.name)} ${def}`);
        else mysqlColParts.push(`  MODIFY COLUMN ${w(col.name)} ${def}`);
      }
    }
  }
  if (mysqlColParts.length > 0) sqls.unshift(`ALTER TABLE ${tbl}\n${mysqlColParts.join(",\n")};`);

  // ── Drop indexes ──
  for (const idx of existingIndexes) {
    if (!idx.dropping || idx.name === "PRIMARY") continue;
    if (dbType === "postgresql") sqls.push(`DROP INDEX ${w(idx.name)};`);
    else sqls.push(`ALTER TABLE ${tbl} DROP INDEX \`${idx.name}\`;`);
  }

  // ── Add indexes ──
  for (const idx of newIndexes) {
    if (!idx.name || idx.columns.length === 0) continue;
    const cols = idx.columns.map((c) => w(c)).join(", ");
    const kind = idx.fulltext ? "FULLTEXT INDEX" : idx.unique ? "UNIQUE INDEX" : "INDEX";
    if (dbType === "postgresql") {
      sqls.push(`CREATE ${idx.unique ? "UNIQUE " : ""}INDEX ${w(idx.name)} ON ${tbl} (${cols});`);
    } else {
      sqls.push(`ALTER TABLE ${tbl} ADD ${kind} \`${idx.name}\` (${cols});`);
    }
  }

  // ── Drop FKs ──
  for (const fk of existingFKs) {
    if (!fk.dropping) continue;
    if (dbType === "postgresql") sqls.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${w(fk.name)};`);
    else sqls.push(`ALTER TABLE ${tbl} DROP FOREIGN KEY \`${fk.name}\`;`);
  }

  // ── Add FKs ──
  for (const fk of newFKs) {
    if (!fk.name || !fk.column || !fk.refTable || !fk.refColumn) continue;
    sqls.push(
      `ALTER TABLE ${tbl}\n  ADD CONSTRAINT ${w(fk.name)}\n  FOREIGN KEY (${w(fk.column)})\n  REFERENCES ${w(fk.refTable)} (${w(fk.refColumn)})\n  ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete};`
    );
  }

  return sqls;
}

// ─── SQL Preview block with copy button ──────────────────────────────────────
function SqlPreviewBlock({ sql }: { sql: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <div className="relative group">
      <pre className="bg-bg border border-border rounded-lg p-4 text-xs text-text-primary font-mono leading-relaxed whitespace-pre-wrap pr-12">
        {sql}
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 rounded text-[10px] border border-border bg-sidebar opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent text-text-secondary hover:text-text-primary"
        title="Copy SQL"
      >
        {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
interface Props {
  target: EditTableTarget;
  onClose: () => void;
}
type TabId = "columns" | "indexes" | "fk" | "preview";

export default function EditTableModal({ target, onClose }: Props) {
  const { connectionId, dbType, database, tableName } = target;

  const [activeTab, setActiveTab] = useState<TabId>("columns");
  const [cols, setCols] = useState<ColDef[]>([]);
  const [existingIndexes, setExistingIndexes] = useState<ExistingIndex[]>([]);
  const [newIndexes, setNewIndexes] = useState<NewIndex[]>([]);
  const [existingFKs, setExistingFKs] = useState<ExistingFK[]>([]);
  const [newFKs, setNewFKs] = useState<NewFK[]>([]);
  const [availableTables, setAvailableTables] = useState<string[]>([]);
  const [refColsCache, setRefColsCache] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const typeList = dbType === "postgresql" ? PG_TYPES : MYSQL_TYPES;

  const runQuery = useCallback(async (sql: string): Promise<QueryResult> => {
    return await invoke<QueryResult>("execute_query", { connectionId, database, query: sql });
  }, [connectionId, database]);

  useEffect(() => {
    const load = async () => {
      setLoading(true); setError(null);
      try {
        // Columns
        const colSql = dbType === "postgresql"
          ? `SELECT column_name, udt_name, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${tableName}' ORDER BY ordinal_position`
          : `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${database}' AND TABLE_NAME = '${tableName}' ORDER BY ORDINAL_POSITION`;
        const colRes = await runQuery(colSql);
        setCols(colRes.rows.map((row) => {
          const r = row as (string | null)[];
          if (dbType === "postgresql") {
            return { _key: uuidv4(), _status: "original" as const, _origName: r[0]??'', name: r[0]??'', colType: (r[1]??'text').toUpperCase(), length: r[2]??'', nullable: r[3]==="YES", primaryKey: false, autoIncrement: (r[4]??'').includes('nextval'), defaultValue: r[4]??'' };
          }
          const { colType, length } = parseColType(r[1] ?? "varchar");
          return { _key: uuidv4(), _status: "original" as const, _origName: r[0]??'', name: r[0]??'', colType, length, nullable: r[2]==="YES", primaryKey: r[4]==="PRI", autoIncrement: (r[5]??'').includes('auto_increment'), defaultValue: r[3]??'' };
        }));

        if (dbType !== "postgresql") {
          // Indexes
          try {
            const idxRes = await runQuery(`SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS COLS, NON_UNIQUE, INDEX_TYPE FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${tableName}' GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME`);
            setExistingIndexes(idxRes.rows.map((r) => { const row = r as (string|null)[]; return { name: row[0]??'', columns: row[1]??'', unique: row[2]==='0', indexType: row[3]??'', dropping: false }; }));
          } catch { /* ignore */ }

          // Foreign Keys
          try {
            const fkRes = await runQuery(`SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA=kcu.TABLE_SCHEMA WHERE kcu.TABLE_SCHEMA='${database}' AND kcu.TABLE_NAME='${tableName}' AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`);
            setExistingFKs(fkRes.rows.map((r) => { const row = r as (string|null)[]; return { name: row[0]??'', column: row[1]??'', refTable: row[2]??'', refColumn: row[3]??'', onUpdate: row[4]??'RESTRICT', onDelete: row[5]??'RESTRICT', dropping: false }; }));
          } catch { /* ignore */ }

          // Available tables for FK
          try {
            const tblRes = await runQuery(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${database}' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`);
            setAvailableTables(tblRes.rows.map((r) => (r as string[])[0]));
          } catch { /* ignore */ }
        }
      } catch (e) { setError(String(e)); }
      finally { setLoading(false); }
    };
    load();
  }, [connectionId, database, dbType, tableName, runQuery]);

  // Fetch ref table columns on demand
  const fetchRefCols = useCallback(async (refTable: string) => {
    if (refColsCache[refTable]) return;
    try {
      const res = await runQuery(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='${database}' AND TABLE_NAME='${refTable}' ORDER BY ORDINAL_POSITION`);
      setRefColsCache((prev) => ({ ...prev, [refTable]: res.rows.map((r) => (r as string[])[0]) }));
    } catch { /* ignore */ }
  }, [database, refColsCache, runQuery]);

  // ── Column helpers ──
  const updateCol = (key: string, patch: Partial<ColDef>) => {
    setNotice(null);
    setCols((prev) => prev.map((c) => c._key === key ? { ...c, ...patch, _status: c._status === "new" ? "new" : "modified" } : c));
  };
  const addCol = () => setCols((prev) => [...prev, { _key: uuidv4(), _status: "new", _origName: '', name: 'new_column', colType: 'VARCHAR', length: '255', nullable: true, primaryKey: false, autoIncrement: false, defaultValue: '' }]);
  const deleteCol = (key: string) => setCols((prev) => prev.map((c) => c._key === key ? (c._status === "new" ? null : { ...c, _status: "deleted" as const }) : c).filter(Boolean) as ColDef[]);
  const restoreCol = (key: string) => setCols((prev) => prev.map((c) => c._key === key ? { ...c, _status: "original" as const, name: c._origName } : c));

  // ── Index helpers ──
  const addNewIndex = () => setNewIndexes((prev) => [...prev, { _key: uuidv4(), name: '', columns: [], unique: false, fulltext: false }]);
  const updateNewIndex = (key: string, patch: Partial<NewIndex>) => setNewIndexes((prev) => prev.map((i) => i._key === key ? { ...i, ...patch } : i));
  const removeNewIndex = (key: string) => setNewIndexes((prev) => prev.filter((i) => i._key !== key));
  const toggleIdxCol = (key: string, col: string) => {
    setNewIndexes((prev) => prev.map((i) => {
      if (i._key !== key) return i;
      const cols = i.columns.includes(col) ? i.columns.filter((c) => c !== col) : [...i.columns, col];
      return { ...i, columns: cols };
    }));
  };

  // ── FK helpers ──
  const addNewFK = () => setNewFKs((prev) => [...prev, { _key: uuidv4(), name: '', column: '', refTable: '', refColumn: '', onUpdate: 'RESTRICT', onDelete: 'RESTRICT' }]);
  const updateNewFK = (key: string, patch: Partial<NewFK>) => {
    setNewFKs((prev) => prev.map((f) => f._key === key ? { ...f, ...patch } : f));
    if ((patch as Partial<NewFK>).refTable) fetchRefCols((patch as Partial<NewFK>).refTable!);
  };
  const removeNewFK = (key: string) => setNewFKs((prev) => prev.filter((f) => f._key !== key));

  const colNames = cols.filter((c) => c._status !== "deleted").map((c) => c.name);

  const sqls = generateSQL(dbType, database, tableName, cols, existingIndexes, newIndexes, existingFKs, newFKs);

  const colChanges = cols.filter((c) => c._status !== "original").length;
  const idxChanges = existingIndexes.filter((i) => i.dropping).length + newIndexes.length;
  const fkChanges = existingFKs.filter((f) => f.dropping).length + newFKs.length;
  const totalChanges = colChanges + idxChanges + fkChanges;

  const handleApply = async () => {
    if (sqls.length === 0) return;
    setApplying(true); setError(null); setNotice(null);
    try {
      for (const sql of sqls) await runQuery(sql);
      setNotice("Changes applied successfully.");
      setCols((prev) => prev.filter((c) => c._status !== "deleted").map((c) => ({ ...c, _status: "original" as const, _origName: c.name })));
      setExistingIndexes((prev) => prev.filter((i) => !i.dropping));
      setNewIndexes([]);
      setExistingFKs((prev) => prev.filter((f) => !f.dropping));
      setNewFKs([]);
    } catch (e) { setError(String(e)); }
    finally { setApplying(false); }
  };

  const TABS: { id: TabId; label: string; badge?: number }[] = [
    { id: "columns", label: "Columns", badge: colChanges || undefined },
    { id: "indexes", label: "Indexes", badge: idxChanges || undefined },
    { id: "fk", label: "Foreign Keys", badge: fkChanges || undefined },
    { id: "preview", label: "SQL Preview" },
  ];

  const inputCls = "bg-transparent border border-transparent hover:border-border/60 rounded px-1.5 py-0.5 text-text-primary outline-none focus:border-highlight focus:bg-bg text-xs w-full";
  const selectCls = `${inputCls} cursor-pointer`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-sidebar border border-border rounded-xl shadow-2xl flex flex-col" style={{ width: 760, maxHeight: "88vh" }} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div>
            <div className="text-sm font-semibold text-text-primary">Edit Table — <span className="font-mono text-highlight">{tableName}</span></div>
            <div className="text-xs text-text-muted mt-0.5">{database} · {dbType}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"><X size={15} /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border flex-shrink-0 px-4">
          {TABS.map(({ id, label, badge }) => (
            <button key={id} onClick={() => setActiveTab(id)} className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${activeTab === id ? "border-highlight text-highlight" : "border-transparent text-text-muted hover:text-text-primary"}`}>
              {label}
              {badge ? <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-highlight/20 text-highlight">{badge}</span> : null}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-48 gap-2 text-text-muted"><Loader2 size={16} className="animate-spin" /><span className="text-sm">Loading table structure…</span></div>
          ) : activeTab === "columns" ? (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60 bg-sidebar/60">
                <button onClick={addCol} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border border-border hover:bg-accent text-text-secondary hover:text-text-primary transition-colors"><Plus size={12} /> Add Column</button>
                <div className="flex-1" />
                <div className="flex items-center gap-3 text-xs">
                  {cols.filter(c=>c._status==="new").length > 0 && <span className="text-green-400">{cols.filter(c=>c._status==="new").length} new</span>}
                  {cols.filter(c=>c._status==="modified").length > 0 && <span className="text-yellow-400">{cols.filter(c=>c._status==="modified").length} modified</span>}
                  {cols.filter(c=>c._status==="deleted").length > 0 && <span className="text-red-400">{cols.filter(c=>c._status==="deleted").length} deleted</span>}
                  {colChanges === 0 && <span className="text-text-muted">No changes</span>}
                </div>
              </div>
              <table className="w-full text-xs border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-accent/80 border-b border-border">
                    <th className="px-3 py-2 text-left text-text-muted font-medium w-8">#</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Column Name</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium w-32">Type</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium w-20">Length</th>
                    <th className="px-3 py-2 text-center text-text-muted font-medium w-16">Not Null</th>
                    <th className="px-3 py-2 text-center text-text-muted font-medium w-12">PK</th>
                    {dbType !== "postgresql" && <th className="px-3 py-2 text-center text-text-muted font-medium w-12">A_I</th>}
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Default</th>
                    <th className="px-2 py-2 w-8" />
                  </tr>
                </thead>
                <tbody>
                  {cols.map((col, i) => {
                    const rowCls = col._status==="new" ? "bg-green-500/10" : col._status==="modified" ? "bg-yellow-500/10" : col._status==="deleted" ? "bg-red-500/10 opacity-50" : "";
                    const disabled = col._status === "deleted";
                    return (
                      <tr key={col._key} className={`border-b border-border/40 hover:bg-accent/20 transition-colors ${rowCls}`}>
                        <td className="px-3 py-1.5 text-text-muted text-center">{i+1}</td>
                        <td className="px-2 py-1"><input value={col.name} disabled={disabled} onChange={(e)=>updateCol(col._key,{name:e.target.value})} className={inputCls} /></td>
                        <td className="px-2 py-1">
                          <select value={col.colType} disabled={disabled} onChange={(e)=>updateCol(col._key,{colType:e.target.value})} className={selectCls}>
                            {typeList.map((t)=><option key={t} value={t}>{t}</option>)}
                            {!typeList.includes(col.colType)&&<option value={col.colType}>{col.colType}</option>}
                          </select>
                        </td>
                        <td className="px-2 py-1"><input value={col.length} disabled={disabled||!TYPES_WITH_LENGTH.has(col.colType)} onChange={(e)=>updateCol(col._key,{length:e.target.value})} placeholder="—" className={`${inputCls} disabled:opacity-25 disabled:cursor-not-allowed`} /></td>
                        <td className="px-2 py-1 text-center"><input type="checkbox" checked={!col.nullable} disabled={disabled} onChange={(e)=>updateCol(col._key,{nullable:!e.target.checked})} className="cursor-pointer accent-highlight disabled:opacity-40" /></td>
                        <td className="px-2 py-1 text-center"><input type="checkbox" checked={col.primaryKey} disabled={disabled} onChange={(e)=>updateCol(col._key,{primaryKey:e.target.checked})} className="cursor-pointer accent-highlight disabled:opacity-40" /></td>
                        {dbType!=="postgresql"&&<td className="px-2 py-1 text-center"><input type="checkbox" checked={col.autoIncrement} disabled={disabled} onChange={(e)=>updateCol(col._key,{autoIncrement:e.target.checked})} className="cursor-pointer accent-highlight disabled:opacity-40" /></td>}
                        <td className="px-2 py-1"><input value={col.defaultValue} disabled={disabled} onChange={(e)=>updateCol(col._key,{defaultValue:e.target.value})} placeholder="NULL" className={`${inputCls} text-text-muted focus:text-text-primary`} /></td>
                        <td className="px-1 py-1 text-center">
                          {col._status==="deleted"
                            ? <button onClick={()=>restoreCol(col._key)} className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-accent transition-colors" title="Restore"><RotateCcw size={11} /></button>
                            : <button onClick={()=>deleteCol(col._key)} className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors" title="Delete"><Trash2 size={11} /></button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>

          ) : activeTab === "indexes" ? (
            <div className="p-4 flex flex-col gap-4">
              {/* Existing indexes */}
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-accent/60 border-b border-border">
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Name</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Columns</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Type</th>
                    <th className="px-3 py-2 text-center text-text-muted font-medium w-16">Unique</th>
                    <th className="px-3 py-2 w-20 text-center text-text-muted font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {existingIndexes.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-6 text-center text-text-muted">No indexes</td></tr>
                  )}
                  {existingIndexes.map((idx) => (
                    <tr key={idx.name} className={`border-b border-border/40 ${idx.dropping ? "bg-red-500/10 opacity-50" : ""}`}>
                      <td className="px-3 py-2 font-mono text-text-primary">{idx.name}</td>
                      <td className="px-3 py-2 text-text-secondary">{idx.columns}</td>
                      <td className="px-3 py-2 text-text-muted">{idx.indexType}</td>
                      <td className="px-3 py-2 text-center">{idx.unique ? <span className="text-highlight">Yes</span> : <span className="text-text-muted">No</span>}</td>
                      <td className="px-3 py-2 text-center">
                        {idx.name === "PRIMARY" ? (
                          <span className="text-text-muted text-[10px]">protected</span>
                        ) : idx.dropping ? (
                          <button onClick={()=>setExistingIndexes(prev=>prev.map(i=>i.name===idx.name?{...i,dropping:false}:i))} className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-accent"><RotateCcw size={10}/> Restore</button>
                        ) : (
                          <button onClick={()=>setExistingIndexes(prev=>prev.map(i=>i.name===idx.name?{...i,dropping:true}:i))} className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-500/10"><Trash2 size={10}/> Drop</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* New indexes */}
              {newIndexes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium text-text-secondary uppercase tracking-wider">Add Indexes</div>
                  {newIndexes.map((idx) => (
                    <div key={idx._key} className="border border-border rounded-lg p-3 bg-green-500/5 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <input value={idx.name} onChange={(e)=>updateNewIndex(idx._key,{name:e.target.value})} placeholder="Index name" className="flex-1 bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight" />
                        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                          <input type="checkbox" checked={idx.unique} onChange={(e)=>updateNewIndex(idx._key,{unique:e.target.checked,fulltext:e.target.checked?false:idx.fulltext})} className="accent-highlight" /> Unique
                        </label>
                        {dbType !== "postgresql" && (
                          <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
                            <input type="checkbox" checked={idx.fulltext} onChange={(e)=>updateNewIndex(idx._key,{fulltext:e.target.checked,unique:e.target.checked?false:idx.unique})} className="accent-highlight" /> Fulltext
                          </label>
                        )}
                        <button onClick={()=>removeNewIndex(idx._key)} className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors"><Trash2 size={12}/></button>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted mb-1.5">Columns (select one or more):</div>
                        <div className="flex flex-wrap gap-1.5">
                          {colNames.map((c) => (
                            <label key={c} className={`flex items-center gap-1 px-2 py-0.5 rounded cursor-pointer text-xs border transition-colors ${idx.columns.includes(c) ? "border-highlight bg-highlight/10 text-highlight" : "border-border text-text-muted hover:border-highlight/50"}`}>
                              <input type="checkbox" checked={idx.columns.includes(c)} onChange={()=>toggleIdxCol(idx._key,c)} className="hidden" />{c}
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={addNewIndex} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-dashed border-border hover:border-highlight text-text-muted hover:text-text-primary transition-colors self-start">
                <Plus size={12} /> Add Index
              </button>
            </div>

          ) : activeTab === "fk" ? (
            <div className="p-4 flex flex-col gap-4">
              {/* Existing FKs */}
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-accent/60 border-b border-border">
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Constraint</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">Column</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">References</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">On Update</th>
                    <th className="px-3 py-2 text-left text-text-muted font-medium">On Delete</th>
                    <th className="px-3 py-2 w-20 text-center text-text-muted font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {existingFKs.length === 0 && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-text-muted">No foreign keys</td></tr>
                  )}
                  {existingFKs.map((fk) => (
                    <tr key={fk.name} className={`border-b border-border/40 ${fk.dropping ? "bg-red-500/10 opacity-50" : ""}`}>
                      <td className="px-3 py-2 font-mono text-text-muted text-[11px]">{fk.name}</td>
                      <td className="px-3 py-2 text-text-primary">{fk.column}</td>
                      <td className="px-3 py-2 text-text-secondary">{fk.refTable}.{fk.refColumn}</td>
                      <td className="px-3 py-2 text-text-muted">{fk.onUpdate}</td>
                      <td className="px-3 py-2 text-text-muted">{fk.onDelete}</td>
                      <td className="px-3 py-2 text-center">
                        {fk.dropping
                          ? <button onClick={()=>setExistingFKs(prev=>prev.map(f=>f.name===fk.name?{...f,dropping:false}:f))} className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary px-1.5 py-0.5 rounded hover:bg-accent"><RotateCcw size={10}/> Restore</button>
                          : <button onClick={()=>setExistingFKs(prev=>prev.map(f=>f.name===fk.name?{...f,dropping:true}:f))} className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-500/10"><Trash2 size={10}/> Drop</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* New FKs */}
              {newFKs.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium text-text-secondary uppercase tracking-wider">Add Foreign Keys</div>
                  {newFKs.map((fk) => (
                    <div key={fk._key} className="border border-border rounded-lg p-3 bg-green-500/5 flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <div className="flex-1">
                          <div className="text-[10px] text-text-muted mb-1">Constraint name</div>
                          <input value={fk.name} onChange={(e)=>updateNewFK(fk._key,{name:e.target.value})} placeholder="fk_table_column" className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight" />
                        </div>
                        <button onClick={()=>removeNewFK(fk._key)} className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 mt-4 transition-colors"><Trash2 size={12}/></button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-[10px] text-text-muted mb-1">Column</div>
                          <select value={fk.column} onChange={(e)=>updateNewFK(fk._key,{column:e.target.value})} className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight cursor-pointer">
                            <option value="">Select column…</option>
                            {colNames.map((c)=><option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted mb-1">References table</div>
                          <select value={fk.refTable} onChange={(e)=>updateNewFK(fk._key,{refTable:e.target.value,refColumn:''})} className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight cursor-pointer">
                            <option value="">Select table…</option>
                            {availableTables.map((t)=><option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <div className="text-[10px] text-text-muted mb-1">References column</div>
                          <select value={fk.refColumn} onChange={(e)=>updateNewFK(fk._key,{refColumn:e.target.value})} disabled={!fk.refTable} className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight cursor-pointer disabled:opacity-40">
                            <option value="">Select column…</option>
                            {(refColsCache[fk.refTable]??[]).map((c)=><option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <div className="text-[10px] text-text-muted mb-1">On Update</div>
                            <select value={fk.onUpdate} onChange={(e)=>updateNewFK(fk._key,{onUpdate:e.target.value})} className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight cursor-pointer">
                              {FK_ACTIONS.map((a)=><option key={a} value={a}>{a}</option>)}
                            </select>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-muted mb-1">On Delete</div>
                            <select value={fk.onDelete} onChange={(e)=>updateNewFK(fk._key,{onDelete:e.target.value})} className="w-full bg-bg border border-border rounded px-2 py-1 text-xs text-text-primary outline-none focus:border-highlight cursor-pointer">
                              {FK_ACTIONS.map((a)=><option key={a} value={a}>{a}</option>)}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={addNewFK} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-dashed border-border hover:border-highlight text-text-muted hover:text-text-primary transition-colors self-start">
                <Plus size={12} /> Add Foreign Key
              </button>
            </div>

          ) : (
            <div className="p-4">
              {sqls.length === 0
                ? <p className="text-text-muted text-sm text-center py-10">No changes to preview</p>
                : <SqlPreviewBlock sql={sqls.join("\n\n")} />}
            </div>
          )}
        </div>

        {notice && <div className="px-4 py-2 border-t border-border bg-green-500/10 flex items-center gap-2 text-xs text-green-400 flex-shrink-0"><CheckCircle2 size={13}/>{notice}</div>}
        {error && <div className="px-4 py-2 border-t border-border bg-red-500/10 flex items-center gap-2 text-xs text-red-400 flex-shrink-0"><AlertCircle size={13}/><span className="truncate">{error}</span></div>}

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border flex-shrink-0">
          <span className="text-xs text-text-muted">{totalChanges > 0 ? `${totalChanges} change${totalChanges>1?"s":""} pending` : "No changes"}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 rounded text-xs border border-border hover:bg-accent text-text-secondary transition-colors">Cancel</button>
            <button onClick={()=>setActiveTab("preview")} disabled={sqls.length===0} className="px-3 py-1.5 rounded text-xs border border-border hover:bg-accent text-text-secondary transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Preview SQL</button>
            <button onClick={handleApply} disabled={sqls.length===0||applying} className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-highlight text-white hover:bg-highlight/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {applying ? <Loader2 size={12} className="animate-spin"/> : <CheckCircle2 size={12}/>}
              Apply Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
