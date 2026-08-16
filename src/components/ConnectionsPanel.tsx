import { useState, useCallback, useEffect, useRef } from "react";
import {
  Trash2,
  Database,
  ChevronRight,
  ChevronDown,
  Table,
  Columns,
  Code2,
  RefreshCw,
  Copy,
  TableProperties,
  FilePlus2,
  Eraser,
  PenLine,
  Pin,
  PinOff,
  Unplug,
} from "lucide-react";

const PINNED_KEY = "iceql-pinned-tables";

export interface PinnedTable {
  id: string;
  configId: string;
  connectionName: string;
  dbName: string;
  tableName: string;
  dbType: string;
}

function loadPinned(): PinnedTable[] {
  try { return JSON.parse(localStorage.getItem(PINNED_KEY) ?? "[]"); } catch { return []; }
}
function savePinned(items: PinnedTable[]) {
  localStorage.setItem(PINNED_KEY, JSON.stringify(items));
}
import type { ConnectionConfig, ActiveConnection } from "../types";
import ContextMenu, { type ContextMenuEntry } from "./ContextMenu";
import DbLogo from "./DbLogo";

interface Props {
  savedConnections: ConnectionConfig[];
  activeConnections: Map<string, ActiveConnection>;
  activeDataSourceId: string | null;
  onExpandDb: (configId: string, dbName: string) => void;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string, preview?: boolean) => void;
  onOpenQuery: (configId: string, dbName: string, initialQuery?: string) => void;
  onEditTable: (configId: string, dbName: string, tableName: string, dbType: string) => void;
  locateTarget: { configId: string; dbName: string; tableName: string; nonce: number } | null;
  onDisconnect?: (configId: string) => void;
  onDeleteConnection?: (configId: string) => void;
}

interface CtxState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

export default function ConnectionsPanel({
  savedConnections,
  activeConnections,
  activeDataSourceId,
  onExpandDb,
  onExpandTable,
  onOpenTable,
  onOpenQuery,
  onEditTable,
  locateTarget,
  onDisconnect,
  onDeleteConnection,
}: Props) {
  // The table currently being revealed via "Show in structure" (briefly highlighted).
  const [highlight, setHighlight] = useState<{ key: string; nonce: number } | null>(null);
  const [pinnedTables, setPinnedTables] = useState<PinnedTable[]>(loadPinned);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [ctx, setCtx] = useState<CtxState | null>(null);

  const pinTable = useCallback((item: PinnedTable) => {
    setPinnedTables((prev) => {
      if (prev.some((p) => p.configId === item.configId && p.dbName === item.dbName && p.tableName === item.tableName)) return prev;
      const next = [...prev, item];
      savePinned(next);
      return next;
    });
  }, []);

  const unpinTable = useCallback((id: string) => {
    setPinnedTables((prev) => {
      const next = prev.filter((p) => p.id !== id);
      savePinned(next);
      return next;
    });
  }, []);

  const openCtx = useCallback((e: React.MouseEvent, items: ContextMenuEntry[]) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY, items });
  }, []);

  // Briefly highlight a table when it's revealed via "Show in structure".
  useEffect(() => {
    if (!locateTarget) return;
    const { configId, dbName, tableName, nonce } = locateTarget;
    setHighlight({ key: `${configId}::${dbName}::${tableName}`, nonce });
    const t = setTimeout(() => {
      setHighlight((cur) => (cur && cur.nonce === nonce ? null : cur));
    }, 2800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateTarget?.nonce]);

  const activeConn = savedConnections.find((c) => c.id === activeDataSourceId);
  const ac = activeDataSourceId ? activeConnections.get(activeDataSourceId) : undefined;
  const dsPinned = pinnedTables.filter((p) => p.configId === activeDataSourceId);

  const connMenuItems: ContextMenuEntry[] = activeConn ? [
    ...(ac ? [{
      label: "Disconnect",
      icon: <Unplug size={12} />,
      onClick: () => onDisconnect?.(activeConn.id),
    }] : []),
    {
      label: "Delete Connection",
      icon: <Trash2 size={12} />,
      danger: true,
      onClick: () => onDeleteConnection?.(activeConn.id),
    },
  ] : [];

  if (!activeConn) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted text-xs gap-3 px-6 text-center">
        <Database size={26} className="opacity-30" />
        <span>No data source selected.<br />Use the rail on the left — click <span className="text-highlight">+</span> to add or connect a connection.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Active data source header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 border-b border-border flex-shrink-0 cursor-context-menu"
        onContextMenu={(e) => connMenuItems.length > 0 && openCtx(e, connMenuItems)}
      >
        <DbLogo type={activeConn.db_type} size={15} />
        <span className="text-sm font-semibold text-text-primary truncate flex-1">{activeConn.name}</span>
        {ac && <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" title="Connected" />}
      </div>

      {/* Pinned tables for this data source */}
      {dsPinned.length > 0 && (
        <div className="flex-shrink-0 border-b border-border">
          <button
            onClick={() => setPinnedOpen((v) => !v)}
            className="w-full flex items-center gap-1 pl-5 pr-3 py-1 text-[11px] font-semibold text-text-muted hover:text-text-secondary transition-colors"
          >
            {pinnedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Pin size={13} className="text-highlight" />
            <span className="flex-1 text-left">Pinned</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent text-text-muted">{dsPinned.length}</span>
          </button>
          {pinnedOpen && (
            <div className="pb-1">
              {dsPinned.map((p) => (
                <div
                  key={p.id}
                  className="group flex items-center gap-2 pl-7 pr-2 py-1 hover:bg-accent/60 cursor-pointer"
                  onClick={() => onOpenTable(p.configId, p.dbName, p.tableName)}
                  title={p.dbName}
                >
                  <Table size={12} className="text-blue-300 flex-shrink-0" />
                  <span className="flex-1 min-w-0 truncate">
                    <span className="text-xs text-text-secondary">{p.tableName}</span>
                    <span className="text-[10px] text-text-muted ml-1.5">{p.dbName}</span>
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); unpinTable(p.id); }}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
                    title="Unpin"
                  >
                    <PinOff size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Structure: databases → tables of the active data source */}
      <div className="flex-1 overflow-y-auto py-1">
        {ac ? (
          ac.databases.map((dbName) => (
            <DatabaseNode
              key={dbName}
              dbName={dbName}
              ac={ac}
              configId={activeConn.id}
              dbType={activeConn.db_type}
              connectionName={activeConn.name}
              highlight={highlight}
              onExpandDb={onExpandDb}
              onExpandTable={onExpandTable}
              onOpenTable={onOpenTable}
              onOpenQuery={onOpenQuery}
              onEditTable={onEditTable}
              onContextMenu={openCtx}
              pinnedTables={pinnedTables}
              onPin={pinTable}
              onUnpin={unpinTable}
            />
          ))
        ) : (
          <div className="px-3 py-6 text-xs text-text-muted text-center">This connection is not active.</div>
        )}
      </div>

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />
      )}
    </div>
  );
}

function DatabaseNode({
  dbName,
  ac,
  configId,
  dbType,
  connectionName,
  highlight,
  onExpandDb,
  onExpandTable,
  onOpenTable,
  onOpenQuery,
  onEditTable,
  onContextMenu,
  pinnedTables,
  onPin,
  onUnpin,
}: {
  dbName: string;
  ac: ActiveConnection;
  configId: string;
  dbType: string;
  connectionName: string;
  highlight: { key: string; nonce: number } | null;
  onExpandDb: (configId: string, dbName: string) => void;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string, preview?: boolean) => void;
  onOpenQuery: (configId: string, dbName: string, initialQuery?: string) => void;
  onEditTable: (configId: string, dbName: string, tableName: string, dbType: string) => void;
  onContextMenu: (e: React.MouseEvent, items: ContextMenuEntry[]) => void;
  pinnedTables: PinnedTable[];
  onPin: (item: PinnedTable) => void;
  onUnpin: (id: string) => void;
}) {
  const isExpanded = ac.expandedDbs.has(dbName);
  const tables = ac.dbTables[dbName] ?? [];
  const dbError = ac.dbErrors?.[dbName];

  const q = (sql: string) => onOpenQuery(configId, dbName, sql);

  const dbMenuItems: ContextMenuEntry[] = [
    { label: "New Query", icon: <Code2 size={12} />, onClick: () => onOpenQuery(configId, dbName) },
    { label: "Refresh Tables", icon: <RefreshCw size={12} />, onClick: () => onExpandDb(configId, dbName) },
    ...(dbType === "mongodb" ? [] : [
      { separator: true } as ContextMenuEntry,
      {
        label: "Create Table",
        icon: <FilePlus2 size={12} />,
        onClick: () => q(`CREATE TABLE \`new_table\` (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);`),
      } as ContextMenuEntry,
      {
        label: "Drop Database",
        icon: <Trash2 size={12} />,
        danger: true,
        onClick: () => q(`DROP DATABASE \`${dbName}\`;`),
      } as ContextMenuEntry,
    ]),
  ];

  return (
    <div>
      <div
        className="flex items-center gap-1 pl-5 pr-2 py-1 hover:bg-accent/60 cursor-pointer group"
        onClick={() => onExpandDb(configId, dbName)}
        onContextMenu={(e) => onContextMenu(e, dbMenuItems)}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="text-text-muted" />
        ) : (
          <ChevronRight size={12} className="text-text-muted" />
        )}
        <Database size={13} className="text-yellow-400" />
        <span className="flex-1 text-xs text-text-primary/80 ml-1 truncate">{dbName}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenQuery(configId, dbName); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-border text-text-muted hover:text-highlight"
          title="New query"
        >
          <Code2 size={11} />
        </button>
      </div>

      {isExpanded && dbError && (
        <div className="pl-10 pr-3 py-1.5 text-[10px] text-red-400 flex items-start gap-1.5">
          <span className="flex-shrink-0 mt-0.5">⚠</span>
          <span className="break-all">{dbError}</span>
        </div>
      )}
      {isExpanded && !dbError && tables.map((table) => (
        <TableNode
          key={table.name}
          table={table}
          dbName={dbName}
          ac={ac}
          configId={configId}
          dbType={dbType}
          connectionName={connectionName}
          highlight={highlight}
          onExpandTable={onExpandTable}
          onOpenTable={onOpenTable}
          onOpenQuery={onOpenQuery}
          onEditTable={onEditTable}
          onContextMenu={onContextMenu}
          pinnedTables={pinnedTables}
          onPin={onPin}
          onUnpin={onUnpin}
        />
      ))}
    </div>
  );
}

function TableNode({
  table,
  dbName,
  ac,
  configId,
  dbType,
  connectionName,
  highlight,
  onExpandTable,
  onOpenTable,
  onOpenQuery,
  onEditTable,
  onContextMenu,
  pinnedTables,
  onPin,
  onUnpin,
}: {
  table: { name: string; table_type: string };
  dbName: string;
  ac: ActiveConnection;
  configId: string;
  dbType: string;
  highlight: { key: string; nonce: number } | null;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string, preview?: boolean) => void;
  onOpenQuery: (configId: string, dbName: string, initialQuery?: string) => void;
  onEditTable: (configId: string, dbName: string, tableName: string, dbType: string) => void;
  onContextMenu: (e: React.MouseEvent, items: ContextMenuEntry[]) => void;
  pinnedTables: PinnedTable[];
  onPin: (item: PinnedTable) => void;
  onUnpin: (id: string) => void;
  connectionName: string;
}) {
  const key = `${dbName}.${table.name}`;
  const isExpanded = ac.expandedTables.has(key);
  const columns = ac.dbColumns[key] ?? [];
  const pinned = pinnedTables.find((p) => p.configId === configId && p.dbName === dbName && p.tableName === table.name);

  const rowRef = useRef<HTMLDivElement>(null);
  const isLocated = highlight?.key === `${configId}::${dbName}::${table.name}`;
  // When this row becomes the locate target, scroll it into view.
  useEffect(() => {
    if (isLocated) rowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLocated, highlight?.nonce]);

  const wrap = (name: string) => dbType === "postgresql" ? `"${name}"` : `\`${name}\``;
  const tbl = wrap(table.name);
  const q = (sql: string) => onOpenQuery(configId, dbName, sql);

  const handlePin = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pinned) {
      onUnpin(pinned.id);
    } else {
      onPin({ id: crypto.randomUUID(), configId, connectionName, dbName, tableName: table.name, dbType });
    }
  };

  const isMongo = dbType === "mongodb";

  const tableMenuItems: ContextMenuEntry[] = [
    { label: "View Data",      icon: <TableProperties size={12} />, onClick: () => onOpenTable(configId, dbName, table.name) },
    ...(!isMongo ? [{ label: "Select 100 rows", icon: <Code2 size={12} />, onClick: () => q(`SELECT * FROM ${tbl} LIMIT 100;`) } as ContextMenuEntry] : []),
    { label: "Copy Name",      icon: <Copy size={12} />,            onClick: () => navigator.clipboard.writeText(table.name) },
    { separator: true },
    pinned
      ? { label: "Unpin Table", icon: <PinOff size={12} />, onClick: () => onUnpin(pinned.id) }
      : { label: "Pin Table",   icon: <Pin size={12} />,    onClick: () => onPin({ id: crypto.randomUUID(), configId, connectionName, dbName, tableName: table.name, dbType }) },
    ...(!isMongo ? [
      { label: "Edit Table",     icon: <PenLine size={12} />,         onClick: () => onEditTable(configId, dbName, table.name, dbType) } as ContextMenuEntry,
      { label: "Create Table",   icon: <FilePlus2 size={12} />,       onClick: () => q(`CREATE TABLE ${tbl}_copy LIKE ${tbl};`) } as ContextMenuEntry,
      { label: "Truncate Table", icon: <Eraser size={12} />,  danger: true, onClick: () => q(`TRUNCATE TABLE ${tbl};`) } as ContextMenuEntry,
      { label: "Drop Table",     icon: <Trash2 size={12} />,  danger: true, onClick: () => q(`DROP TABLE ${tbl};`) } as ContextMenuEntry,
    ] : []),
  ];

  return (
    <div>
      <div
        ref={rowRef}
        key={isLocated ? `loc-${highlight?.nonce}` : `row-${table.name}`}
        className={`relative flex items-center gap-1 pl-9 pr-2 py-1 cursor-pointer group ${
          isLocated ? "animate-locate-pulse" : "transition-colors hover:bg-accent/60"
        }`}
        onClick={() => onOpenTable(configId, dbName, table.name, true)}
        onDoubleClick={() => onOpenTable(configId, dbName, table.name, false)}
        onContextMenu={(e) => onContextMenu(e, tableMenuItems)}
      >
        <button
          onClick={(e) => { e.stopPropagation(); onExpandTable(configId, dbName, table.name); }}
          className="flex-shrink-0 p-0.5 -ml-0.5 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"
          title={isExpanded ? "Collapse columns" : "Expand columns"}
        >
          {isExpanded ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronRight size={11} />
          )}
        </button>
        <Table size={12} className="text-blue-300" />
        <span className="flex-1 text-xs text-text-secondary ml-1 truncate min-w-0">{table.name}</span>
        {/* Pin indicator when not hovered */}
        {pinned && (
          <Pin size={10} className="fill-current text-highlight flex-shrink-0 group-hover:hidden" />
        )}
        {/* Action buttons — absolutely positioned so they don't push the name */}
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-accent/90 rounded px-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenTable(configId, dbName, table.name); }}
            className="text-[10px] text-text-muted hover:text-highlight px-1 py-0.5"
            title="Open table"
          >
            open
          </button>
          <button
            onClick={handlePin}
            className="p-0.5 rounded transition-colors flex-shrink-0 text-text-muted hover:text-highlight"
            title={pinned ? "Unpin" : "Pin table"}
          >
            <Pin size={10} className={pinned ? "fill-current text-highlight" : ""} />
          </button>
        </div>
      </div>

      {isExpanded && columns.map((col) => (
        <div
          key={col.name}
          className="flex items-center gap-1 pl-14 pr-2 py-0.5 hover:bg-accent/30"
        >
          <Columns size={10} className="text-text-muted/70 flex-shrink-0" />
          <span className="text-[11px] text-text-secondary truncate">{col.name}</span>
          <span className="text-[10px] text-text-muted ml-auto flex-shrink-0 truncate max-w-[80px]">
            {col.data_type}
          </span>
        </div>
      ))}
    </div>
  );
}
