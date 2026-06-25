import { X, Table, Code2, Plus } from "lucide-react";
import type { Tab } from "../types";

interface Props {
  tabs: Tab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPromote: (id: string) => void;
  onNewQuery: () => void;
  canNewQuery: boolean;
}

export default function TabBar({ tabs, activeTabId, onSelect, onClose, onPromote, onNewQuery, canNewQuery }: Props) {
  if (tabs.length === 0) return null;

  return (
    <div className="flex items-center gap-1 bg-sidebar border-b border-border overflow-x-auto flex-shrink-0 px-2 py-1.5">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            onDoubleClick={() => onPromote(tab.id)}
            onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            onMouseUp={(e) => { if (e.button === 1) onClose(tab.id); }}
            className={`flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg cursor-pointer flex-shrink-0 group transition-colors ${
              isActive
                ? "bg-highlight/15 text-text-primary ring-1 ring-inset ring-highlight/30"
                : "text-text-muted hover:text-text-secondary hover:bg-accent/50"
            }`}
            title={tab.preview ? "Preview tab — double-click to keep open" : undefined}
          >
            {tab.type === "table" ? (
              <Table size={13} className={isActive ? "text-blue-300" : "text-text-muted"} />
            ) : (
              <Code2 size={13} className={isActive ? "text-highlight" : "text-text-muted"} />
            )}
            <span className={`text-xs max-w-[140px] truncate ${tab.preview ? "italic" : ""}`}>{tab.title}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
              className="ml-0.5 rounded-md hover:bg-border p-0.5 text-text-muted hover:text-text-primary opacity-0 group-hover:opacity-100 transition-opacity"
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
          className="flex items-center justify-center p-1.5 rounded-lg flex-shrink-0 text-text-muted hover:text-highlight hover:bg-accent/50 transition-colors"
        >
          <Plus size={15} />
        </button>
      )}
    </div>
  );
}
