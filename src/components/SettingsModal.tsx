import { X, Sun, Moon, Monitor } from "lucide-react";

export type AppTheme = "dark" | "light" | "system";
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

const FONT_SIZES: { value: FontSize; label: string; px: number }[] = [
  { value: "sm", label: "Small", px: 12 },
  { value: "md", label: "Medium", px: 14 },
  { value: "lg", label: "Large", px: 16 },
  { value: "xl", label: "X-Large", px: 18 },
];

const THEMES: { value: AppTheme; label: string; icon: typeof Sun }[] = [
  { value: "dark", label: "Dark", icon: Moon },
  { value: "light", label: "Light", icon: Sun },
  { value: "system", label: "System", icon: Monitor },
];

export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-sidebar border border-border rounded-xl shadow-2xl w-[400px]">
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
              Theme
            </label>
            <div className="flex gap-2">
              {THEMES.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => onChange({ ...settings, theme: value })}
                  className={`flex-1 flex flex-col items-center gap-2 py-3 rounded-lg border transition-all text-xs font-medium
                    ${settings.theme === value
                      ? "border-highlight bg-accent text-highlight"
                      : "border-border bg-surface text-text-muted hover:border-highlight/50 hover:text-text-primary"
                    }`}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
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
