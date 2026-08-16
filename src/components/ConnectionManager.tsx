import { useState } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { Plus, Plug, PlugZap, Edit2, Trash2, Database, X, FlaskConical, Download, Upload } from "lucide-react";
import type { ConnectionConfig, ActiveConnection, DbType } from "../types";
import AddConnectionModal from "./AddConnectionModal";
import DbLogo from "./DbLogo";

const VALID_DB_TYPES: DbType[] = ["postgresql", "mysql", "sqlite", "csv", "mongodb", "redis"];

interface Props {
  savedConnections: ConnectionConfig[];
  activeConnections: Map<string, ActiveConnection>;
  connectingIds: Set<string>;
  onConnect: (config: ConnectionConfig) => void;
  onDisconnect: (configId: string) => void;
  onAdd: (config: ConnectionConfig) => void;
  onUpdate: (config: ConnectionConfig) => void;
  onDelete: (id: string) => void;
  onImport: (configs: ConnectionConfig[]) => Promise<ConnectionConfig[]>;
  onSelectDataSource: (configId: string) => void;
  onConnectDemo: () => Promise<void>;
  onClose: () => void;
}

interface ExportFile {
  app: "iceql";
  version: 1;
  exportedAt: string;
  connections: ConnectionConfig[];
}

// Accepts either our own export envelope or a bare array, and drops entries
// missing the fields a connection can't function without.
function parseImportedConnections(raw: string): ConnectionConfig[] {
  const data = JSON.parse(raw);
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.connections) ? data.connections : [];
  return list
    .filter((c): c is Record<string, unknown> => {
      if (!c || typeof c !== "object") return false;
      const r = c as Record<string, unknown>;
      return typeof r.name === "string" && VALID_DB_TYPES.includes(r.db_type as DbType);
    })
    .map((c) => ({
      id: "",
      host: "",
      port: 0,
      username: "",
      password: "",
      database: "",
      ...c,
    } as ConnectionConfig));
}


export default function ConnectionManager({
  savedConnections,
  activeConnections,
  connectingIds,
  onConnect,
  onDisconnect,
  onAdd,
  onUpdate,
  onDelete,
  onImport,
  onSelectDataSource,
  onConnectDemo,
  onClose,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [editingConn, setEditingConn] = useState<ConnectionConfig | undefined>();
  const [deletingConn, setDeletingConn] = useState<ConnectionConfig | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const [includePasswords, setIncludePasswords] = useState(false);
  const [ioMsg, setIoMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const showIoMsg = (ok: boolean, text: string) => {
    setIoMsg({ ok, text });
    setTimeout(() => setIoMsg((m) => (m?.text === text ? null : m)), 4000);
  };

  const runExport = async () => {
    setShowExportConfirm(false);
    const connections = savedConnections.map((c) => (includePasswords ? c : { ...c, password: "" }));
    const payload: ExportFile = {
      app: "iceql",
      version: 1,
      exportedAt: new Date().toISOString(),
      connections,
    };
    try {
      const path = await save({
        defaultPath: `iceql-connections_${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(payload, null, 2));
      showIoMsg(true, `Exported ${connections.length} connection${connections.length === 1 ? "" : "s"}.`);
    } catch (e) {
      showIoMsg(false, `Export failed: ${String(e)}`);
    }
  };

  const runImport = async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: "Import connections",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (typeof selected !== "string") return;
      const raw = await readTextFile(selected);
      const parsed = parseImportedConnections(raw);
      if (parsed.length === 0) {
        showIoMsg(false, "No valid connections found in that file.");
        return;
      }
      const imported = await onImport(parsed);
      showIoMsg(true, `Imported ${imported.length} connection${imported.length === 1 ? "" : "s"}.`);
    } catch (e) {
      showIoMsg(false, `Import failed: ${String(e)}`);
    }
  };

  const handleSave = (config: ConnectionConfig) => {
    if (editingConn) onUpdate(config); else onAdd(config);
    setShowModal(false);
    setEditingConn(undefined);
  };

  const handleDemoClick = async () => {
    setDemoLoading(true);
    setDemoError(null);
    try {
      await onConnectDemo();
      onClose();
    } catch (e) {
      setDemoError(String(e));
      setDemoLoading(false);
    }
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
                onClick={handleDemoClick}
                disabled={demoLoading}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-accent text-text-secondary hover:text-text-primary border border-border hover:border-highlight/50 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Connect to a built-in demo database with sample data"
              >
                {demoLoading
                  ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  : <FlaskConical size={12} />
                }
                Demo
              </button>
              <button
                onClick={() => { setEditingConn(undefined); setShowModal(true); }}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-highlight text-bg hover:bg-highlight/90 font-medium transition-colors"
              >
                <Plus size={12} /> New
              </button>
              <button
                onClick={runImport}
                className="p-1.5 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"
                title="Import connections from a JSON file"
              >
                <Download size={14} />
              </button>
              <button
                onClick={() => { setIncludePasswords(false); setShowExportConfirm(true); }}
                disabled={savedConnections.length === 0}
                className="p-1.5 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                title="Export connections to a JSON file"
              >
                <Upload size={14} />
              </button>
              <button onClick={onClose} className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary" title="Close">
                <X size={14} />
              </button>
            </div>
          </div>

          {ioMsg && (
            <div className={`px-4 py-1.5 text-[11px] border-b border-border flex-shrink-0 ${ioMsg.ok ? "text-green-400" : "text-red-400"}`}>
              {ioMsg.text}
            </div>
          )}

          <div className="overflow-y-auto py-1">
            {savedConnections.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-36 text-text-muted text-xs gap-3 px-4 text-center">
                <Database size={24} className="opacity-40" />
                <span>No connections yet. Click "New" to add one.</span>
                <button
                  onClick={handleDemoClick}
                  disabled={demoLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border border-border hover:border-highlight/60 text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {demoLoading
                    ? <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    : <FlaskConical size={12} className="text-highlight" />
                  }
                  {demoLoading ? "Connecting..." : "Try Demo Database"}
                </button>
                {demoError && (
                  <p className="text-red-400 text-[11px] max-w-[240px] text-center leading-snug">{demoError}</p>
                )}
              </div>
            ) : (
              savedConnections.map((conn) => {
                const isConnected = activeConnections.has(conn.id);
                const isConnecting = connectingIds.has(conn.id);
                return (
                  <div key={conn.id} className="group flex items-center gap-2 px-4 py-2 hover:bg-accent/50">
                    <DbLogo type={conn.db_type} size={16} className="flex-shrink-0" />
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

      {showExportConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={(e) => e.stopPropagation()}>
          <div className="bg-sidebar border border-border rounded-lg shadow-xl w-[340px] p-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 rounded-full bg-accent text-highlight"><Upload size={16} /></div>
              <h2 className="text-sm font-semibold text-text-primary">Export connections</h2>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-3">
              Save all {savedConnections.length} connection{savedConnections.length === 1 ? "" : "s"} to a JSON file.
            </p>
            <label className="flex items-start gap-2 mb-5 cursor-pointer">
              <input
                type="checkbox"
                checked={includePasswords}
                onChange={(e) => setIncludePasswords(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-xs text-text-secondary leading-relaxed">
                Include passwords <span className="text-text-muted">(stored in plain text in the exported file — keep it somewhere safe)</span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowExportConfirm(false)} className="px-3 py-1.5 rounded text-xs text-text-secondary hover:bg-accent hover:text-text-primary transition-colors">Cancel</button>
              <button onClick={runExport} className="px-3 py-1.5 rounded text-xs bg-highlight text-bg hover:bg-highlight/90 font-medium transition-colors">Export</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
