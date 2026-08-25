import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { v4 as uuidv4 } from "uuid";
import { X, Loader2, FolderOpen, FileText, ChevronDown, ChevronRight } from "lucide-react";
import type { ConnectionConfig, DbType, SshTunnelConfig } from "../types";
import DbLogo from "./DbLogo";

interface Props {
  initial?: ConnectionConfig;
  onSave: (config: ConnectionConfig) => void;
  onClose: () => void;
}

const DEFAULTS: Record<DbType, Partial<ConnectionConfig>> = {
  postgresql: { host: "localhost", port: 5432, username: "postgres", database: "postgres" },
  mysql: { host: "localhost", port: 3306, username: "root", database: "mysql" },
  sqlite: { host: "", port: 0, username: "", database: "" },
  csv: { host: "", port: 0, username: "", database: "", filename: "" },
  mongodb: { host: "localhost", port: 27017, username: "", database: "" },
  redis: { host: "localhost", port: 6379, username: "", database: "0" },
};

const DEFAULT_SSH_TUNNEL: SshTunnelConfig = {
  enabled: false,
  host: "",
  port: 22,
  username: "",
  auth_method: "password",
  password: "",
  private_key_path: "",
  passphrase: "",
};

const DB_LABELS: Record<DbType, string> = {
  postgresql: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  csv: "CSV",
  mongodb: "MongoDB",
  redis: "Redis",
};

export default function AddConnectionModal({ initial, onSave, onClose }: Props) {
  const [form, setForm] = useState<ConnectionConfig>(
    initial ?? {
      id: uuidv4(),
      name: "",
      db_type: "postgresql",
      host: "localhost",
      port: 5432,
      username: "postgres",
      password: "",
      database: "postgres",
      filename: "",
    }
  );
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [sshOpen, setSshOpen] = useState(!!initial?.ssh_tunnel?.enabled);

  const set = (k: keyof ConnectionConfig, v: unknown) => {
    setForm((f) => ({ ...f, [k]: v }));
    setTestResult(null);
  };

  const changeType = (t: DbType) => {
    const defs = DEFAULTS[t];
    setForm((f) => ({
      ...f,
      db_type: t,
      host: defs.host ?? f.host,
      port: defs.port ?? f.port,
      username: defs.username ?? f.username,
      database: defs.database ?? f.database,
    }));
    setTestResult(null);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await invoke("test_connection", { config: form });
      setTestResult({ ok: true, msg: "Connection successful!" });
    } catch (e) {
      setTestResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const isSqlite = form.db_type === "sqlite";
  const isCsv = form.db_type === "csv";
  const ssh = form.ssh_tunnel ?? DEFAULT_SSH_TUNNEL;

  const setSsh = (k: keyof SshTunnelConfig, v: unknown) => {
    setForm((f) => ({ ...f, ssh_tunnel: { ...(f.ssh_tunnel ?? DEFAULT_SSH_TUNNEL), [k]: v } }));
    setTestResult(null);
  };

  const browsePrivateKey = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select SSH private key",
      filters: [{ name: "All Files", extensions: ["*"] }],
    });
    if (typeof selected === "string") setSsh("private_key_path", selected);
  };

  const browseSqliteFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select SQLite database file",
      filters: [
        { name: "SQLite Database", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") {
      set("filename", selected);
      if (!form.name.trim()) {
        const base = selected.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
        if (base) set("name", base);
      }
    }
  };

  const browseCsvFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select CSV file",
      filters: [
        { name: "CSV Files", extensions: ["csv", "tsv", "txt"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") {
      set("filename", selected);
      if (!form.name.trim()) {
        const base = selected.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, "") ?? "";
        if (base) set("name", base);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-sidebar border border-border rounded-xl shadow-2xl w-[520px] max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-2 text-text-primary font-semibold text-lg">
            <DbLogo type={form.db_type} size={20} />
            {initial ? "Edit Connection" : "New Connection"}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Connection Name */}
          <div>
            <label className="block text-text-secondary text-sm mb-1">Connection Name</label>
            <input
              className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="My Database"
            />
          </div>

          {/* DB Type */}
          <div>
            <label className="block text-text-secondary text-sm mb-1">Database Type</label>
            <div className="flex gap-2">
              {(["postgresql", "mysql", "sqlite", "mongodb", "redis", "csv"] as DbType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => changeType(t)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors ${
                    form.db_type === t
                      ? "bg-highlight border-highlight text-white"
                      : "bg-accent border-border text-text-secondary hover:text-text-primary"
                  }`}
                >
                  {DB_LABELS[t]}
                </button>
              ))}
            </div>
          </div>

          {/* CSV file picker */}
          {isCsv && (
            <div>
              <label className="block text-text-secondary text-sm mb-1">CSV File</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                  value={form.filename ?? ""}
                  onChange={(e) => set("filename", e.target.value)}
                  placeholder="/path/to/data.csv"
                />
                <button
                  type="button"
                  onClick={browseCsvFile}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-accent border border-border text-text-secondary hover:bg-accent/70 hover:text-text-primary transition-colors whitespace-nowrap"
                >
                  <FolderOpen size={15} />
                  Browse
                </button>
              </div>
              <p className="text-text-muted text-xs mt-1.5 flex items-center gap-1">
                <FileText size={11} />
                CSV data is loaded into memory — edits are not written back to the file.
              </p>
            </div>
          )}

          {/* SQLite file picker */}
          {isSqlite && (
            <div>
              <label className="block text-text-secondary text-sm mb-1">Database File Path</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                  value={form.filename ?? ""}
                  onChange={(e) => set("filename", e.target.value)}
                  placeholder="/path/to/database.db"
                />
                <button
                  type="button"
                  onClick={browseSqliteFile}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-accent border border-border text-text-secondary hover:bg-accent/70 hover:text-text-primary transition-colors whitespace-nowrap"
                  title="Browse for database file"
                >
                  <FolderOpen size={15} />
                  Browse
                </button>
              </div>
            </div>
          )}

          {/* Host/port/credentials — only for postgres/mysql */}
          {!isSqlite && !isCsv && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="block text-text-secondary text-sm mb-1">Host</label>
                  <input
                    className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                    value={form.host}
                    onChange={(e) => set("host", e.target.value)}
                    placeholder="localhost"
                  />
                </div>
                <div>
                  <label className="block text-text-secondary text-sm mb-1">Port</label>
                  <input
                    type="number"
                    className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                    value={form.port}
                    onChange={(e) => set("port", parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-text-secondary text-sm mb-1">Username</label>
                  <input
                    className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                    value={form.username}
                    onChange={(e) => set("username", e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-text-secondary text-sm mb-1">Password</label>
                  <input
                    type="password"
                    className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                    value={form.password}
                    onChange={(e) => set("password", e.target.value)}
                  />
                </div>
              </div>

              <div>
                <label className="block text-text-secondary text-sm mb-1">
                  {form.db_type === "mongodb" ? "Auth Database (optional)" : form.db_type === "redis" ? "Database Number" : "Database"}
                </label>
                <input
                  className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight"
                  value={form.database}
                  onChange={(e) => set("database", e.target.value)}
                  placeholder={form.db_type === "mongodb" ? "admin" : DEFAULTS[form.db_type].database}
                />
                {form.db_type === "mongodb" && (
                  <p className="text-text-muted text-xs mt-1.5">
                    Leave blank for a no-auth connection. All databases on the server are browsable after connecting.
                  </p>
                )}
                {form.db_type === "redis" && (
                  <p className="text-text-muted text-xs mt-1.5">
                    Redis databases are numbered (0-15 by default), not named. All numbered databases are browsable after connecting.
                  </p>
                )}
              </div>
            </>
          )}

          {/* SSH Tunnel — only meaningful for network databases, not local files */}
          {!isSqlite && !isCsv && (
            <div className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => setSshOpen((v) => !v)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-accent/40 hover:bg-accent/60 transition-colors text-left"
              >
                {sshOpen ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
                <span className="text-sm text-text-secondary flex-1">SSH Tunnel</span>
                <span
                  onClick={(e) => { e.stopPropagation(); setSsh("enabled", !ssh.enabled); if (!ssh.enabled) setSshOpen(true); }}
                  className={`inline-flex items-center w-7 h-4 rounded-full transition-colors flex-shrink-0 ${ssh.enabled ? "bg-highlight" : "bg-border"}`}
                  title={ssh.enabled ? "Disable SSH tunnel" : "Enable SSH tunnel"}
                >
                  <span className={`inline-block w-3 h-3 rounded-full bg-white shadow transition-transform mx-0.5 ${ssh.enabled ? "translate-x-3" : "translate-x-0"}`} />
                </span>
              </button>

              {sshOpen && (
                <div className="p-3 space-y-3 border-t border-border">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-text-secondary text-sm mb-1">SSH Host</label>
                      <input
                        disabled={!ssh.enabled}
                        className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                        value={ssh.host}
                        onChange={(e) => setSsh("host", e.target.value)}
                        placeholder="bastion.example.com"
                      />
                    </div>
                    <div>
                      <label className="block text-text-secondary text-sm mb-1">Port</label>
                      <input
                        type="number"
                        disabled={!ssh.enabled}
                        className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                        value={ssh.port}
                        onChange={(e) => setSsh("port", parseInt(e.target.value) || 0)}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-text-secondary text-sm mb-1">SSH Username</label>
                    <input
                      disabled={!ssh.enabled}
                      className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                      value={ssh.username}
                      onChange={(e) => setSsh("username", e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="block text-text-secondary text-sm mb-1">Authentication</label>
                    <div className="flex gap-2">
                      {(["password", "key"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          disabled={!ssh.enabled}
                          onClick={() => setSsh("auth_method", m)}
                          className={`flex-1 py-1.5 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 ${
                            ssh.auth_method === m
                              ? "bg-highlight border-highlight text-white"
                              : "bg-accent border-border text-text-secondary hover:text-text-primary"
                          }`}
                        >
                          {m === "password" ? "Password" : "Private Key"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {ssh.auth_method === "password" ? (
                    <div>
                      <label className="block text-text-secondary text-sm mb-1">SSH Password</label>
                      <input
                        type="password"
                        disabled={!ssh.enabled}
                        className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                        value={ssh.password ?? ""}
                        onChange={(e) => setSsh("password", e.target.value)}
                      />
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-text-secondary text-sm mb-1">Private Key File</label>
                        <div className="flex gap-2">
                          <input
                            disabled={!ssh.enabled}
                            className="flex-1 bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                            value={ssh.private_key_path ?? ""}
                            onChange={(e) => setSsh("private_key_path", e.target.value)}
                            placeholder="~/.ssh/id_ed25519"
                          />
                          <button
                            type="button"
                            disabled={!ssh.enabled}
                            onClick={browsePrivateKey}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-accent border border-border text-text-secondary hover:bg-accent/70 hover:text-text-primary transition-colors whitespace-nowrap disabled:opacity-50"
                          >
                            <FolderOpen size={15} />
                            Browse
                          </button>
                        </div>
                      </div>
                      <div>
                        <label className="block text-text-secondary text-sm mb-1">Passphrase (optional)</label>
                        <input
                          type="password"
                          disabled={!ssh.enabled}
                          className="w-full bg-accent border border-border rounded-lg px-3 py-2 text-text-primary text-sm focus:outline-none focus:border-highlight disabled:opacity-50"
                          value={ssh.passphrase ?? ""}
                          onChange={(e) => setSsh("passphrase", e.target.value)}
                        />
                      </div>
                    </>
                  )}

                  <p className="text-text-muted text-xs">
                    Traffic to {form.host || "the database host"} is tunneled through this SSH server instead of connecting to it directly.
                  </p>
                </div>
              )}
            </div>
          )}

          {testResult && (
            <div
              className={`rounded-lg px-3 py-2 text-sm ${
                testResult.ok
                  ? "bg-green-900/40 text-green-400 border border-green-800"
                  : "bg-red-900/40 text-red-400 border border-red-800"
              }`}
            >
              {testResult.msg}
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 pb-6">
          {!isCsv && (
            <button
              onClick={testConnection}
              disabled={testing}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-accent border border-border text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : null}
              Test Connection
            </button>
          )}
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={!form.name || (isCsv && !form.filename)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-highlight text-white hover:bg-highlight/90 transition-colors disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
