import { useState } from "react";
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
} from "lucide-react";
import type { ConnectionConfig, ActiveConnection } from "../types";
import AddConnectionModal from "./AddConnectionModal";

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
  onOpenTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenQuery: (configId: string, dbName: string) => void;
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
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
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
      <div className="flex items-center justify-between px-3 py-3 border-b border-border">
        <span className="text-text-secondary text-xs font-semibold uppercase tracking-wider">
          Connections
        </span>
        <button
          onClick={() => { setEditingConn(undefined); setShowModal(true); }}
          className="p-1 rounded hover:bg-accent text-text-muted hover:text-highlight transition-colors"
          title="Add connection"
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
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
                <span className="flex-1 text-sm text-text-primary truncate ml-1">
                  {conn.name}
                </span>

                {/* Connecting spinner */}
                {isConnecting && (
                  <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                )}

                {/* Action buttons shown on hover */}
                {!isConnecting && hoveredId === conn.id && (
                  <div className="flex items-center gap-0.5">
                    <button
                      onClick={() => { setEditingConn(conn); setShowModal(true); }}
                      className="p-1 rounded hover:bg-border text-text-muted hover:text-text-primary"
                      title="Edit"
                    >
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={() => setDeletingConn(conn)}
                      className="p-1 rounded hover:bg-border text-text-muted hover:text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                    {isConnected ? (
                      <button
                        onClick={() => onDisconnect(conn.id)}
                        className="p-1 rounded hover:bg-border text-green-400 hover:text-red-400"
                        title="Disconnect"
                      >
                        <PlugZap size={12} />
                      </button>
                    ) : (
                      <button
                        onClick={() => onConnect(conn)}
                        className="p-1 rounded hover:bg-border text-text-muted hover:text-green-400"
                        title="Connect"
                      >
                        <Plug size={12} />
                      </button>
                    )}
                  </div>
                )}

                {isConnected && !isConnecting && hoveredId !== conn.id && (
                  <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                )}
              </div>

              {/* Database tree */}
              {isConnected && !isCollapsed && ac.databases.map((dbName) => (
                <DatabaseNode
                  key={dbName}
                  dbName={dbName}
                  ac={ac}
                  configId={conn.id}
                  onExpandDb={onExpandDb}
                  onExpandTable={onExpandTable}
                  onOpenTable={onOpenTable}
                  onOpenQuery={onOpenQuery}
                />
              ))}
            </div>
          );
        })}
      </div>

      {showModal && (
        <AddConnectionModal
          initial={editingConn}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingConn(undefined); }}
        />
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
  onExpandDb,
  onExpandTable,
  onOpenTable,
  onOpenQuery,
}: {
  dbName: string;
  ac: ActiveConnection;
  configId: string;
  onExpandDb: (configId: string, dbName: string) => void;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenQuery: (configId: string, dbName: string) => void;
}) {
  const isExpanded = ac.expandedDbs.has(dbName);
  const tables = ac.dbTables[dbName] ?? [];

  return (
    <div>
      <div
        className="flex items-center gap-1 pl-5 pr-2 py-1 hover:bg-accent/60 cursor-pointer group"
        onClick={() => onExpandDb(configId, dbName)}
      >
        {isExpanded ? (
          <ChevronDown size={12} className="text-text-muted" />
        ) : (
          <ChevronRight size={12} className="text-text-muted" />
        )}
        <Database size={13} className="text-yellow-400" />
        <span className="flex-1 text-xs text-text-secondary ml-1 truncate">{dbName}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenQuery(configId, dbName); }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-border text-text-muted hover:text-highlight"
          title="New query"
        >
          <Code2 size={11} />
        </button>
      </div>

      {isExpanded && tables.map((table) => (
        <TableNode
          key={table.name}
          table={table}
          dbName={dbName}
          ac={ac}
          configId={configId}
          onExpandTable={onExpandTable}
          onOpenTable={onOpenTable}
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
  onExpandTable,
  onOpenTable,
}: {
  table: { name: string; table_type: string };
  dbName: string;
  ac: ActiveConnection;
  configId: string;
  onExpandTable: (configId: string, dbName: string, tableName: string) => void;
  onOpenTable: (configId: string, dbName: string, tableName: string) => void;
}) {
  const key = `${dbName}.${table.name}`;
  const isExpanded = ac.expandedTables.has(key);
  const columns = ac.dbColumns[key] ?? [];

  return (
    <div>
      <div
        className="flex items-center gap-1 pl-9 pr-2 py-1 hover:bg-accent/60 cursor-pointer group"
        onClick={() => onExpandTable(configId, dbName, table.name)}
        onDoubleClick={() => onOpenTable(configId, dbName, table.name)}
      >
        {isExpanded ? (
          <ChevronDown size={11} className="text-text-muted" />
        ) : (
          <ChevronRight size={11} className="text-text-muted" />
        )}
        <Table size={12} className="text-blue-300" />
        <span className="flex-1 text-xs text-text-muted ml-1 truncate">{table.name}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onOpenTable(configId, dbName, table.name); }}
          className="opacity-0 group-hover:opacity-100 text-[10px] text-text-muted hover:text-highlight px-1"
          title="Open table"
        >
          open
        </button>
      </div>

      {isExpanded && columns.map((col) => (
        <div
          key={col.name}
          className="flex items-center gap-1 pl-14 pr-2 py-0.5 hover:bg-accent/30"
        >
          <Columns size={10} className="text-text-muted flex-shrink-0" />
          <span className="text-[11px] text-text-muted truncate">{col.name}</span>
          <span className="text-[10px] text-text-muted/50 ml-auto flex-shrink-0 truncate max-w-[80px]">
            {col.data_type}
          </span>
        </div>
      ))}
    </div>
  );
}
