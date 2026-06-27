import { useState } from "react";
import { Plus, Plug, PlugZap, Edit2, Trash2, Database, X } from "lucide-react";
import type { ConnectionConfig, ActiveConnection } from "../types";
import AddConnectionModal from "./AddConnectionModal";

interface Props {
  savedConnections: ConnectionConfig[];
  activeConnections: Map<string, ActiveConnection>;
  connectingIds: Set<string>;
  onConnect: (config: ConnectionConfig) => void;
  onDisconnect: (configId: string) => void;
  onAdd: (config: ConnectionConfig) => void;
  onUpdate: (config: ConnectionConfig) => void;
  onDelete: (id: string) => void;
  onSelectDataSource: (configId: string) => void;
  onClose: () => void;
}

const dbColor = (t: string) =>
  t === "postgresql" ? "text-blue-400"
  : t === "mysql" ? "text-orange-400"
  : t === "sqlite" ? "text-green-400"
  : t === "csv" ? "text-yellow-400"
  : "text-text-secondary";

export default function ConnectionManager({
  savedConnections,
  activeConnections,
  connectingIds,
  onConnect,
  onDisconnect,
  onAdd,
  onUpdate,
  onDelete,
  onSelectDataSource,
  onClose,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>();
  const [deletingConn, setDeletingConn] = useState<ConnectionConfig | null>(null);

  const handleSave = (config: ConnectionConfig) => {
    if (editingConn) onUpdate(config); else onAdd(config);
    setShowModal(false);
    setEditingConn(undefined);
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div
          className="bg-sidebar border border-border rounded-lg shadow-xl w-[460px] max-w-[92vw] max-h-[80vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Database size={15} className="text-highlight" />
              Connections
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => { setEditingConn(undefined); setShowModal(true); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-highlight text-bg hover:bg-highlight/90 font-medium transition-colors"
              >
                <Plus size={12} /> New
              </button>
              <button onClick={onClose} className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary" title="Close">
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="overflow-y-auto py-1">
            {savedConnections.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-text-muted text-xs gap-2 px-4 text-center">
                <Database size={24} className="opacity-40" />
                <span>No connections yet. Click “New” to add one.</span>
              </div>
            ) : (
              savedConnections.map((conn) => {
                const isConnected = activeConnections.has(conn.id);
                const isConnecting = connectingIds.has(conn.id);
                return (
                  <div key={conn.id} className="group flex items-center gap-2 px-4 py-2 hover:bg-accent/50">
                    <Database size={16} className={`${dbColor(conn.db_type)} flex-shrink-0`} />
                    <button
                      onClick={() => { if (isConnected) { onSelectDataSource(conn.id); onClose(); } else if (!isConnecting) onConnect(conn); }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                      title={isConnected ? "Go to this data source" : "Connect"}
                    >
                      <span className="text-sm text-text-primary truncate">{conn.name}</span>
                      <span className="text-[10px] text-text-muted truncate flex-shrink-0">{conn.db_type}</span>
                      {isConnected && <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />}
                    </button>
                    <div className="flex items-center gap-0.5 flex-shrink-0">
                      {isConnecting ? (
                        <div className="p-1"><div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /></div>
                      ) : isConnected ? (
                        <button onClick={() => onDisconnect(conn.id)} title="Disconnect" className="p-1 rounded hover:bg-border text-green-400 hover:text-red-400 transition-colors">
                          <PlugZap size={13} />
                        </button>
                      ) : (
                        <button onClick={() => onConnect(conn)} title="Connect" className="p-1 rounded hover:bg-border text-text-muted hover:text-green-400 transition-colors">
                          <Plug size={13} />
                        </button>
                      )}
                      <button onClick={() => { setEditingConn(conn); setShowModal(true); }} title="Edit" className="p-1 rounded hover:bg-border text-text-muted hover:text-text-primary transition-colors">
                        <Edit2 size={13} />
                      </button>
                      <button onClick={() => setDeletingConn(conn)} title="Delete" className="p-1 rounded hover:bg-border text-text-muted hover:text-red-400 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <AddConnectionModal
          initial={editingConn}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingConn(undefined); }}
        />
      )}

      {deletingConn && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={(e) => e.stopPropagation()}>
          <div className="bg-sidebar border border-border rounded-lg shadow-xl w-[340px] p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-full bg-red-900/30 text-red-400"><Trash2 size={16} /></div>
              <h2 className="text-sm font-semibold text-text-primary">Delete connection</h2>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-5">
              Are you sure you want to delete{" "}
              <span className="font-medium text-text-primary">{deletingConn.name}</span>? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeletingConn(null)} className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors">Cancel</button>
              <button onClick={() => { onDelete(deletingConn.id); setDeletingConn(null); }} className="px-3 py-1.5 rounded text-xs bg-red-600 text-white hover:bg-red-500 font-medium transition-colors">Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
