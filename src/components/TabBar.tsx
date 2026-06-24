import { X, Table, Code2, Plus } from "lucide-react";
import type { Tab } from "../types";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewQuery: () => void;
  canNewQuery: boolean;
}

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onNewQuery, canNewQuery }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-end bg-sidebar border-b border-border overflow-x-auto flex-shrink-0">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 cursor-pointer border-r border-border flex-shrink-0 group transition-colors ${
              isActive
                ? "bg-bg text-text-primary border-t-2 border-t-highlight"
                : "bg-sidebar text-text-muted hover:text-text-secondary hover:bg-accent/40"
            }`}
          >
            {tab.type === "table" ? (
              <Table size={13} className={isActive ? "text-blue-300" : "text-text-muted"} />
            ) : (
              <Code2 size={13} className={isActive ? "text-highlight" : "text-text-muted"} />
            )}
            <span className="text-xs max-w-[140px] truncate">{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              className="ml-0.5 rounded hover:bg-border p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      {canNewQuery && (
        <button
          onClick={onNewQuery}
          title="New query editor"
          className="flex items-center justify-center px-2.5 py-2 flex-shrink-0 text-text-muted hover:text-highlight hover:bg-accent/40 transition-colors"
        >
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}
