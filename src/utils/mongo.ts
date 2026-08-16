// Helpers shared between TableDataView (collection browse) and ResultsPanel (Mongo query-tab
// results) for the parts of Mongo document editing that aren't SQL — see utils/sql.ts for the
// SQL-dialect equivalents these mirror.

// Best-effort read of the "collection" field out of a Mongo query tab's JSON spec text.
export function parseMongoCollection(query: string): string | null {
  try {
    const parsed = JSON.parse(query);
    return typeof parsed?.collection === "string" ? parsed.collection : null;
  } catch {
    return null;
  }
}

// Preview text for the Mongo commit modal: one updateOne per changed document, grouping all
// of that document's pending field edits into a single $set so the user sees exactly what
// will change per row (mirrors how the SQL preview groups a row's edits into one UPDATE).
export function buildMongoUpdatePreview(
  collection: string,
  rows: Record<string, unknown>[],
  edits: Map<string, unknown>
): string[] {
  const byRow = new Map<number, Record<string, unknown>>();
  edits.forEach((value, key) => {
    const sepIdx = key.indexOf(":");
    const rowIdx = Number(key.slice(0, sepIdx));
    const col = key.slice(sepIdx + 1);
    if (!byRow.has(rowIdx)) byRow.set(rowIdx, {});
    byRow.get(rowIdx)![col] = value;
  });
  return [...byRow.entries()].map(([rowIdx, changes]) => {
    const idJson = JSON.stringify(rows[rowIdx]?.["_id"]);
    const setJson = JSON.stringify(changes, null, 2).replace(/\n/g, "\n  ");
    return `db.${collection}.updateOne(\n  { _id: ${idJson} },\n  { $set: ${setJson} }\n);`;
  });
}
