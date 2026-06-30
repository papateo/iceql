import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: never;
}

export interface ContextMenuSeparator {
  separator: true;
  label?: never;
  icon?: never;
  onClick?: never;
  danger?: never;
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface Props {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handle);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  // Adjust position so menu doesn't overflow viewport
  const menuW = 200;
  const menuH = items.length * 32;
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;

  return (
    <div
      ref={ref}
      style={{ left, top, position: "fixed", zIndex: 9999, minWidth: menuW }}
      className="bg-sidebar border border-border rounded-lg shadow-2xl py-1 text-xs"
    >
      {items.map((item, i) => {
        if ("separator" in item && item.separator) {
          return <div key={i} className="my-1 border-t border-border" />;
        }
        const { label, icon, onClick, danger, disabled } = item as ContextMenuItem;
        return (
          <button
            key={i}
            onClick={() => { if (!disabled) { onClick(); onClose(); } }}
            disabled={disabled}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors disabled:opacity-40 disabled:cursor-default
              ${danger
                ? "text-red-400 hover:bg-red-500/10 disabled:hover:bg-transparent"
                : "text-text-primary hover:bg-accent disabled:hover:bg-transparent"
              }`}
          >
            {icon && <span className="text-text-muted w-3.5 flex-shrink-0">{icon}</span>}
            {label}
          </button>
        );
      })}
    </div>
  );
}
