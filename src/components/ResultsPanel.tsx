import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { useMemo } from "react";
import { CheckCircle2, AlertCircle, Clock, Hash } from "lucide-react";
import type { QueryResult } from "../types";

interface Props {
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
}

export default function ResultsPanel({ result, error, loading }: Props) {
  const columnHelper = createColumnHelper<Record<string, unknown>>();

  const columns = useMemo(() => {
    if (!result?.columns) return [];
    return result.columns.map((col) =>
      columnHelper.accessor(col, {
        header: col,
        cell: (info) => {
          const val = info.getValue();
          if (val === null || val === undefined)
            return <span className="text-text-muted italic text-xs">NULL</span>;
          const str = typeof val === "object" ? JSON.stringify(val) : String(val);
          return (
            <span className="truncate max-w-[300px] block" title={str}>
              {str}
            </span>
          );
        },
      })
    );
  }, [result?.columns]);

  const data = useMemo(() => {
    if (!result?.rows || !result?.columns) return [];
    return result.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
  }, [result]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted gap-2">
        <div className="w-4 h-4 border-2 border-highlight border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Running query…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="flex items-start gap-2 bg-red-900/20 border border-red-800/50 rounded-lg p-3">
          <AlertCircle size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
          <pre className="text-red-300 text-xs whitespace-pre-wrap font-mono">{error}</pre>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        Run a query to see results
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Status bar */}
      <div className="flex items-center gap-4 px-3 py-1.5 border-b border-border bg-sidebar text-xs">
        <div className="flex items-center gap-1 text-green-400">
          <CheckCircle2 size={12} />
          <span>Success</span>
        </div>
        <div className="flex items-center gap-1 text-text-secondary">
          <Hash size={12} />
          <span>{result.row_count} rows</span>
        </div>
        <div className="flex items-center gap-1 text-text-secondary">
          <Clock size={12} />
          <span>{result.execution_time_ms}ms</span>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="bg-accent border-b border-border">
                <th className="px-2 py-2 text-left text-text-muted font-medium w-10 border-r border-border">
                  #
                </th>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-3 py-2 text-left text-text-secondary font-medium whitespace-nowrap border-r border-border last:border-r-0"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, idx) => (
              <tr
                key={row.id}
                className="border-b border-border/50 hover:bg-accent/40 transition-colors"
              >
                <td className="px-2 py-1.5 text-text-muted w-10 border-r border-border/50 text-right">
                  {idx + 1}
                </td>
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="px-3 py-1.5 text-text-primary border-r border-border/50 last:border-r-0 max-w-[400px]"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        {data.length === 0 && (
          <div className="flex items-center justify-center py-8 text-text-muted text-sm">
            No rows returned
          </div>
        )}
      </div>
    </div>
  );
}
