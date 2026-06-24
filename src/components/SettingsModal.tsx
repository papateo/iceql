import { X } from "lucide-react";

export type AppTheme =
  | "charcoal"
  | "ocean"
  | "midnight"
  | "nord"
  | "light"
  | "sepia";

export type FontSize = "sm" | "md" | "lg" | "xl";

export interface AppSettings {
  theme: AppTheme;
  fontSize: FontSize;
}

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
}

const THEMES: {
  value: AppTheme;
  label: string;
  dark: boolean;
  swatches: [string, string, string]; // bg, sidebar, highlight
}[] = [
  { value: "charcoal", label: "Charcoal",  dark: true,  swatches: ["#121212", "#1a1a1a", "#a855f7"] },
  { value: "ocean",    label: "Ocean",     dark: true,  swatches: ["#071a2e", "#0a2340", "#38bdf8"] },
  { value: "midnight", label: "Midnight",  dark: true,  swatches: ["#08080c", "#0e0e14", "#8b5cf6"] },
  { value: "nord",     label: "Nord",      dark: true,  swatches: ["#242933", "#2b3040", "#88c0d0"] },
  { value: "light",    label: "Light",     dark: false, swatches: ["#f0f4f8", "#e2eaf2", "#0284c7"] },
  { value: "sepia",    label: "Sepia",     dark: false, swatches: ["#f5f0e6", "#ebe4d7", "#b45309"] },
];

const FONT_SIZES: { value: FontSize; label: string; px: number }[] = [
  { value: "sm", label: "Small",   px: 12 },
  { value: "md", label: "Medium",  px: 14 },
  { value: "lg", label: "Large",   px: 16 },
  { value: "xl", label: "X-Large", px: 18 },
];

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-sidebar border border-border rounded-xl shadow-2xl w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-5 py-5 flex flex-col gap-6">
          {/* Theme */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
              Color Theme
            </label>
            <div className="grid grid-cols-3 gap-2">
              {THEMES.map(({ value, label, swatches }) => {
                const [bg, sidebar, highlight] = swatches;
                const active = settings.theme === value;
                return (
                  <button
                    key={value}
                    onClick={() => onChange({ ...settings, theme: value })}
                    className={`relative rounded-lg border-2 overflow-hidden transition-all text-left ${
                      active ? "border-highlight" : "border-border hover:border-highlight/40"
                    }`}
                  >
                    {/* Mini preview */}
                    <div className="flex h-14" style={{ background: bg }}>
                      {/* Sidebar strip */}
                      <div className="w-8 h-full flex flex-col gap-1 p-1" style={{ background: sidebar }}>
                        <div className="h-1.5 rounded-sm w-full opacity-60" style={{ background: highlight }} />
                        <div className="h-1 rounded-sm w-3/4 opacity-30" style={{ background: highlight }} />
                        <div className="h-1 rounded-sm w-1/2 opacity-20" style={{ background: highlight }} />
                      </div>
                      {/* Content area */}
                      <div className="flex-1 p-1.5 flex flex-col gap-1">
                        <div className="flex gap-1">
                          <div className="h-2 rounded w-8 opacity-40" style={{ background: highlight }} />
                          <div className="h-2 rounded w-6 opacity-20" style={{ background: highlight }} />
                        </div>
                        <div className="h-1 rounded w-full opacity-15" style={{ background: highlight }} />
                        <div className="h-1 rounded w-4/5 opacity-10" style={{ background: highlight }} />
                      </div>
                    </div>
                    {/* Label */}
                    <div className={`px-2 py-1.5 text-xs font-medium flex items-center justify-between ${
                      active ? "text-highlight bg-highlight/10" : "text-text-muted bg-surface"
                    }`}>
                      {label}
                      {active && (
                        <span className="w-2 h-2 rounded-full" style={{ background: highlight }} />
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Font Size */}
          <div>
            <label className="text-xs font-semibold text-text-secondary uppercase tracking-wider block mb-3">
              Font Size
            </label>
            <div className="flex gap-2">
              {FONT_SIZES.map(({ value, label, px }) => (
                <button
                  key={value}
                  onClick={() => onChange({ ...settings, fontSize: value })}
                  className={`flex-1 flex flex-col items-center gap-1 py-2.5 rounded-lg border transition-all font-medium
                    ${settings.fontSize === value
                      ? "border-highlight bg-accent text-highlight"
                      : "border-border bg-surface text-text-muted hover:border-highlight/50 hover:text-text-primary"
                    }`}
                  style={{ fontSize: px }}
                >
                  A
                  <span className="text-[10px]">{label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
