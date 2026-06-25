import { useState, useCallback } from "react";
import {
  Plus,
  Trash2,
  Edit2,
  Plug,
  PlugZap,
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
import AddConnectionModal from "./AddConnectionModal";
import ContextMenu, { type ContextMenuEntry } from "./ContextMenu";

interface Props {
  savedConnections: ConnectionConfig[];
  activeConnections: Map<string, ActiveConnection>;
  selectedConnectionId: string | null;
  connectingIds: Set<string>;
  onConnect: (config: ConnectionConfig) => void;
  onDisconnect: (configId: string) => void;
  onAdd: (config: ConnectionConfig) => void;
  onUpdate: (config: ConnectionConfig) => void;
  onDelete: (id: string) => void;
  onExpandDb: (configId: string, dbName: string) => void;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string, preview?: boolean) => void;
  onOpenQuery: (configId: string, dbName: string, initialQuery?: string) => void;
  onEditTable: (configId: string, dbName: string, tableName: string, dbType: string) => void;
}

interface CtxState {
  x: number;
  y: number;
  items: ContextMenuEntry[];
}

export default function ConnectionsPanel({
  savedConnections,
  activeConnections,
  connectingIds,
  onConnect,
  onDisconnect,
  onAdd,
  onUpdate,
  onDelete,
  onExpandDb,
  onExpandTable,
  onOpenTable,
  onOpenQuery,
  onEditTable,
}: Props) {
  const [sidebarTab, setSidebarTab] = useState<"connections" | "pinned">("connections");
  const [pinnedTables, setPinnedTables] = useState<PinnedTable[]>(loadPinned);
  const [showModal, setShowModal] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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
  const [deletingConn, setDeletingConn] = useState<ConnectionConfig | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const toggleCollapse = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSave = (config: ConnectionConfig) => {
    if (editingConn) {
      onUpdate(config);
    } else {
      onAdd(config);
    }
    setShowModal(false);
    setEditingConn(undefined);
  };

  const dbTypeIcon = (type: string) => {
    const colors: Record<string, string> = {
      postgresql: "text-blue-400",
      mysql: "text-orange-400",
      sqlite: "text-green-400",
    };
    return colors[type] ?? "text-text-secondary";
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab header */}
      <div className="flex items-center gap-1 border-b border-border flex-shrink-0 px-2 py-1.5">
        <button
          onClick={() => setSidebarTab("connections")}
          className={`flex-1 h-8 flex items-center justify-center text-xs font-semibold rounded-lg transition-colors ${sidebarTab === "connections" ? "bg-highlight/15 text-highlight ring-1 ring-inset ring-highlight/30" : "text-text-muted hover:text-text-secondary hover:bg-accent/50"}`}
        >
          Connections
        </button>
        <button
          onClick={() => setSidebarTab("pinned")}
          className={`flex-1 h-8 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 ${sidebarTab === "pinned" ? "bg-highlight/15 text-highlight ring-1 ring-inset ring-highlight/30" : "text-text-muted hover:text-text-secondary hover:bg-accent/50"}`}
        >
          <Pin size={11} />
          Pinned
          {pinnedTables.length > 0 && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${sidebarTab === "pinned" ? "bg-highlight/20 text-highlight" : "bg-accent text-text-muted"}`}>
              {pinnedTables.length}
            </span>
          )}
        </button>
        {sidebarTab === "connections" && (
          <button
            onClick={() => { setEditingConn(undefined); setShowModal(true); }}
            className="p-1.5 rounded-lg hover:bg-accent text-text-muted hover:text-highlight transition-colors flex-shrink-0"
            title="Add connection"
          >
            <Plus size={14} />
          </button>
        )}
      </div>

      {/* Pinned panel */}
      {sidebarTab === "pinned" && (
        <div className="flex-1 overflow-y-auto">
          {pinnedTables.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-text-muted text-xs gap-2 px-4 text-center">
              <Pin size={22} className="opacity-30" />
              <span>No pinned tables yet.<br />Hover a table and click <Pin size={10} className="inline" /> to pin it.</span>
            </div>
          ) : (
            <div className="py-1">
              {pinnedTables.map((p) => {
                const ac = activeConnections.get(p.configId);
                const isConnected = !!ac;
                return (
                  <div
                    key={p.id}
                    className={`group flex items-center gap-2 pl-3 pr-2 py-1.5 hover:bg-accent/60 cursor-pointer ${isConnected ? "" : "opacity-40"}`}
                    onClick={() => isConnected && onOpenTable(p.configId, p.dbName, p.tableName)}
                    title={isConnected ? undefined : "Connection not active"}
                  >
                    <Table size={12} className="text-blue-300 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-text-secondary truncate">{p.tableName}</div>
                      <div className="text-[10px] text-text-muted truncate">{p.connectionName} · {p.dbName}</div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); unpinTable(p.id); }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-all flex-shrink-0"
                      title="Unpin"
                    >
                      <PinOff size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Connections panel */}
      {sidebarTab === "connections" && <div className="flex-1 overflow-y-auto">
        {savedConnections.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-text-muted text-xs gap-2">
            <Database size={24} className="opacity-40" />
            <span>No connections yet</span>
          </div>
        )}

        {savedConnections.map((conn) => {
          const ac = activeConnections.get(conn.id);
          const isConnected = !!ac;
          const isConnecting = connectingIds.has(conn.id);
          const isCollapsed = collapsedIds.has(conn.id);

          return (
            <div key={conn.id}>
              {/* Connection row */}
              <div
                className="flex items-center gap-1 px-2 py-1.5 hover:bg-accent/60 group cursor-pointer"
                onMouseEnter={() => setHoveredId(conn.id)}
                onMouseLeave={() => setHoveredId(null)}
                onDoubleClick={() => !isConnected && !isConnecting && onConnect(conn)}
                onContextMenu={(e) => {
                  const db = ac?.databases[0] ?? "";
                  const isPg = conn.db_type === "postgresql";
                  const isSqlite = conn.db_type === "sqlite";
                  const items: import("./ContextMenu").ContextMenuEntry[] = [
                    ...(isConnected ? [{ label: "New Query", icon: <Code2 size={12} />, onClick: () => onOpenQuery(conn.id, db) }] : []),
                    ...(isConnected && !isSqlite ? [
                      { separator: true as const },
                      isPg
                        ? { label: "Create Schema", icon: <FilePlus2 size={12} />, onClick: () => onOpenQuery(conn.id, db, `CREATE SCHEMA "new_schema";`) }
                        : { label: "Create Database", icon: <FilePlus2 size={12} />, onClick: () => onOpenQuery(conn.id, db, `CREATE DATABASE \`new_database\`;`) },
                      isPg
                        ? { label: "Create Database", icon: <Database size={12} />, onClick: () => onOpenQuery(conn.id, db, `CREATE DATABASE new_database;`) }
                        : null,
                    ].filter(Boolean) as import("./ContextMenu").ContextMenuEntry[] : []),
                    ...(!isConnected && !isConnecting ? [
                      { label: "Connect", icon: <Plug size={12} />, onClick: () => onConnect(conn) },
                    ] : []),
                    { separator: true as const },
                    { label: "Edit Connection", icon: <Edit2 size={12} />, onClick: () => { setEditingConn(conn); setShowModal(true); } },
                    { label: "Delete Connection", icon: <Trash2 size={12} />, danger: true, onClick: () => setDeletingConn(conn) },
                  ];
                  openCtx(e, items);
                }}
              >
                {isConnected ? (
                  <button
                    onClick={() => toggleCollapse(conn.id)}
                    className="text-text-muted flex-shrink-0"
                  >
                    {isCollapsed
                      ? <ChevronRight size={13} />
                      : <ChevronDown size={13} />}
                  </button>
                ) : (
                  <span className="w-[13px] flex-shrink-0" />
                )}
                <Database size={14} className={dbTypeIcon(conn.db_type)} />
                <span className="flex items-center gap-1.5 flex-1 min-w-0 ml-1">
                  <span className="text-sm text-text-primary truncate">{conn.name}</span>
                  {isConnected && <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />}
                </span>

                {/* Right side: fixed layout, all elements always in DOM */}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  {/* Spinner: visible only while connecting, occupies same slot as edit button */}
                  <div className={`p-1 transition-opacity ${isConnecting ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                    <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                  </div>
                  <button
                    onClick={() => { setEditingConn(conn); setShowModal(true); }}
                    className={`p-1 rounded hover:bg-border text-text-muted hover:text-text-primary transition-opacity ${!isConnecting && hoveredId === conn.id ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                    title="Edit"
                  >
                    <Edit2 size={12} />
                  </button>
                  <button
                    onClick={() => setDeletingConn(conn)}
                    className={`p-1 rounded hover:bg-border text-text-muted hover:text-red-400 transition-opacity ${!isConnecting && hoveredId === conn.id ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                  {isConnected ? (
                    <button
                      onClick={() => onDisconnect(conn.id)}
                      className={`p-1 rounded hover:bg-border text-green-400 hover:text-red-400 transition-opacity ${!isConnecting && hoveredId === conn.id ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                      title="Disconnect"
                    >
                      <PlugZap size={12} />
                    </button>
                  ) : (
                    <button
                      onClick={() => onConnect(conn)}
                      className={`p-1 rounded hover:bg-border text-text-muted hover:text-green-400 transition-opacity ${!isConnecting && hoveredId === conn.id ? "opacity-100" : "opacity-0 pointer-events-none"}`}
                      title="Connect"
                    >
                      <Plug size={12} />
                    </button>
                  )}
                </div>
              </div>

              {/* Database tree */}
              {isConnected && !isCollapsed && ac.databases.map((dbName) => (
                <DatabaseNode
                  key={dbName}
                  dbName={dbName}
                  ac={ac}
                  configId={conn.id}
                  dbType={conn.db_type}
                  connectionName={conn.name}
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
              ))}
            </div>
          );
        })}
      </div>}

      {showModal && (
        <AddConnectionModal
          initial={editingConn}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingConn(undefined); }}
        />
      )}

      {ctx && (
        <ContextMenu x={ctx.x} y={ctx.y} items={ctx.items} onClose={() => setCtx(null)} />
      )}

      {deletingConn && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-sidebar border border-border rounded-lg shadow-xl w-[340px] p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-full bg-red-900/30 text-red-400">
                <Trash2 size={16} />
              </div>
              <h2 className="text-sm font-semibold text-text-primary">Delete connection</h2>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-5">
              Are you sure you want to delete{" "}
              <span className="font-medium text-text-primary">{deletingConn.name}</span>? This action
              cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeletingConn(null)}
                className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(deletingConn.id); setDeletingConn(null); }}
                className="px-3 py-1.5 rounded text-xs bg-red-600 text-white hover:bg-red-500 font-medium transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
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
    { separator: true },
    {
      label: "Create Table",
      icon: <FilePlus2 size={12} />,
      onClick: () => q(`CREATE TABLE \`new_table\` (\n  id INT AUTO_INCREMENT PRIMARY KEY,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);`),
    },
    {
      label: "Drop Database",
      icon: <Trash2 size={12} />,
      danger: true,
      onClick: () => q(`DROP DATABASE \`${dbName}\`;`),
    },
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

  const tableMenuItems: ContextMenuEntry[] = [
    { label: "View Data",      icon: <TableProperties size={12} />, onClick: () => onOpenTable(configId, dbName, table.name) },
    { label: "Select 100 rows", icon: <Code2 size={12} />,          onClick: () => q(`SELECT * FROM ${tbl} LIMIT 100;`) },
    { label: "Copy Name",      icon: <Copy size={12} />,            onClick: () => navigator.clipboard.writeText(table.name) },
    { separator: true },
    pinned
      ? { label: "Unpin Table", icon: <PinOff size={12} />, onClick: () => onUnpin(pinned.id) }
      : { label: "Pin Table",   icon: <Pin size={12} />,    onClick: () => onPin({ id: crypto.randomUUID(), configId, connectionName, dbName, tableName: table.name, dbType }) },
    { label: "Edit Table",     icon: <PenLine size={12} />,         onClick: () => onEditTable(configId, dbName, table.name, dbType) },
    { label: "Create Table",   icon: <FilePlus2 size={12} />,       onClick: () => q(`CREATE TABLE ${tbl}_copy LIKE ${tbl};`) },
    { label: "Truncate Table", icon: <Eraser size={12} />,  danger: true, onClick: () => q(`TRUNCATE TABLE ${tbl};`) },
    { label: "Drop Table",     icon: <Trash2 size={12} />,  danger: true, onClick: () => q(`DROP TABLE ${tbl};`) },
  ];

  return (
    <div>
      <div
        className="relative flex items-center gap-1 pl-9 pr-2 py-1 hover:bg-accent/60 cursor-pointer group"
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
