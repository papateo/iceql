import { useRef, useEffect, useState } from "react";
import { Copy, Scissors, Clipboard, Eraser, RotateCcw, Fingerprint, ChevronRight } from "lucide-react";

interface Props {
  x: number;
  y: number;
  onClose: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onSetNull: () => void;
  onSetDefault?: () => void;
  hasDefault?: boolean;
  // Present only where generating a fresh UUID into the cell makes sense (RDBMS cells).
  onGenerateUuid?: (version: "v4" | "v7") => void;
}

export default function EditCellCtxMenu({ x, y, onClose, onCopy, onCut, onPaste, onSetNull, onSetDefault, hasDefault, onGenerateUuid }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [uuidSubmenuOpen, setUuidSubmenuOpen] = useState(false);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [onClose]);

  const menuW = 200;
  const menuH = (hasDefault ? 150 : 120) + (onGenerateUuid ? 32 : 0);
  const left = x + menuW > window.innerWidth ? x - menuW : x;
  const top = y + menuH > window.innerHeight ? y - menuH : y;
  // The UUID submenu opens to the right by default, flipping to the left if it would
  // otherwise overflow the window (mirrors how the outer menu itself flips near an edge).
  const submenuW = 140;
  const submenuOpensLeft = left + menuW + submenuW > window.innerWidth;

  const btn = (label: string, icon: React.ReactNode, onClick: () => void, opts?: { danger?: boolean; title?: string }) => (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { onClick(); onClose(); }}
      title={opts?.title}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors ${opts?.danger ? "text-red-400 hover:bg-red-500/10" : "text-text-primary hover:bg-accent"}`}
    >
      <span className="text-text-muted w-3.5 flex-shrink-0">{icon}</span>{label}
    </button>
  );

  return (
    <div ref={ref} style={{ position: "fixed", left, top, zIndex: 9999, minWidth: menuW }} className="bg-sidebar border border-border rounded-lg shadow-2xl py-1">
      {btn("Copy", <Copy size={12} />, onCopy)}
      {btn("Cut", <Scissors size={12} />, onCut)}
      {btn("Paste", <Clipboard size={12} />, onPaste)}
      <div className="my-1 border-t border-border" />
      {btn("Set NULL", <Eraser size={12} />, onSetNull)}
      {hasDefault && onSetDefault && btn("Set Default", <RotateCcw size={12} />, onSetDefault)}
      {onGenerateUuid && (
        <div className="relative" onMouseEnter={() => setUuidSubmenuOpen(true)} onMouseLeave={() => setUuidSubmenuOpen(false)}>
          <button
            onMouseDown={(e) => e.preventDefault()}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs transition-colors text-text-primary ${uuidSubmenuOpen ? "bg-accent" : "hover:bg-accent"}`}
          >
            <span className="text-text-muted w-3.5 flex-shrink-0"><Fingerprint size={12} /></span>
            <span className="flex-1">UUID</span>
            <ChevronRight size={12} className="text-text-muted" />
          </button>
          {uuidSubmenuOpen && (
            <div
              className="absolute top-0 bg-sidebar border border-border rounded-lg shadow-2xl py-1"
              style={submenuOpensLeft ? { right: "100%", minWidth: submenuW } : { left: "100%", minWidth: submenuW }}
            >
              {btn("UUID v4", <Fingerprint size={12} />, () => onGenerateUuid("v4"), { title: "Random" })}
              {btn("UUID v7", <Fingerprint size={12} />, () => onGenerateUuid("v7"), { title: "Time-ordered, sortable" })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
