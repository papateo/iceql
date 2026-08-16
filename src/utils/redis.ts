// Preview text for the Redis commit modal — redis-cli-style command lines per key, mirroring
// how utils/mongo.ts's buildMongoUpdatePreview groups a document's pending edits together.
export function buildRedisUpdatePreview(
  rows: Record<string, unknown>[],
  edits: Map<string, unknown>
): string[] {
  const byRow = new Map<number, Record<string, unknown>>();
  edits.forEach((value, editKey) => {
    const sepIdx = editKey.indexOf(":");
    const rowIdx = Number(editKey.slice(0, sepIdx));
    const field = editKey.slice(sepIdx + 1);
    if (!byRow.has(rowIdx)) byRow.set(rowIdx, {});
    byRow.get(rowIdx)![field] = value;
  });

  return [...byRow.entries()].map(([rowIdx, changes]) => {
    const key = String(rows[rowIdx]?.["key"] ?? "");
    const type = String(rows[rowIdx]?.["type"] ?? "string");
    const lines: string[] = [];
    if ("ttl" in changes) {
      const ttl = changes.ttl;
      lines.push(ttl === null || ttl === "null" || ttl === "-1" ? `PERSIST ${key}` : `EXPIRE ${key} ${ttl}`);
    }
    if ("value" in changes) {
      const setCmd = type === "hash" ? "HSET" : type === "list" ? "RPUSH (after DEL)" : type === "set" ? "SADD (after DEL)" : type === "zset" ? "ZADD (after DEL)" : "SET";
      lines.push(`${setCmd} ${key} ${changes.value}`);
    }
    return lines.join("\n");
  });
}
