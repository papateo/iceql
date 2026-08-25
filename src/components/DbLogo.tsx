import { SiPostgresql, SiMysql, SiSqlite, SiMongodb, SiRedis, SiMqtt } from "react-icons/si";
import { Database, FileSpreadsheet } from "lucide-react";
import type { IconType } from "react-icons";

// Real brand marks per connection type, so a connection reads as "that's Postgres" at a
// glance instead of a generic database glyph plus a two-letter badge.
const BRAND_ICONS: Partial<Record<string, IconType>> = {
  postgresql: SiPostgresql,
  mysql: SiMysql,
  sqlite: SiSqlite,
  mongodb: SiMongodb,
  redis: SiRedis,
  mqtt: SiMqtt,
};

// Matches the color convention already used across ConnectionsPanel/ConnectionManager.
const COLORS: Record<string, string> = {
  postgresql: "text-blue-400",
  mysql: "text-orange-400",
  sqlite: "text-green-400",
  mongodb: "text-emerald-500",
  redis: "text-red-500",
  csv: "text-yellow-400",
  mqtt: "text-fuchsia-500",
};

export default function DbLogo({ type, size = 16, className = "" }: { type: string; size?: number; className?: string }) {
  const color = COLORS[type] ?? "text-text-secondary";
  const Icon = BRAND_ICONS[type];
  if (Icon) return <Icon size={size} className={`${color} ${className}`} />;
  if (type === "csv") return <FileSpreadsheet size={size} className={`${color} ${className}`} />;
  return <Database size={size} className={`${color} ${className}`} />;
}
