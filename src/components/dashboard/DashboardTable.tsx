"use client";

import { useMemo, type ReactNode } from "react";
import {
  Table,
  type TableColumn,
  type TableProps,
} from "@/components/motion/table";
import { Button } from "@/components/motion/button";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type DashboardTableRow = { id: string; cells: ReactNode[] };
export type DashboardTableProps = {
  headers: Array<{
    label?: ReactNode;
    align?: "left" | "center" | "right";
    width?: string;
  }>;
  rows: DashboardTableRow[];
  minWidth?: string;
  className?: string;
  height?: number;
  ariaLabel?: string;
  selectable?: boolean;
  /** Column resize and reorder handles; off for fixed-layout tables. */
  adjustableColumns?: boolean;
  selectedRowIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  selectionActions?: TableProps<DashboardTableRow>["selectionActions"];
  /** "above" keeps the selection toolbar out of the sticky header; it requires controlled selection. */
  selectionPlacement?: "header" | "above";
};

/** Server pages provide serializable cell content; beUI owns the table rendering. */
export function DashboardTable({
  headers,
  rows,
  minWidth = "40rem",
  className,
  height,
  ariaLabel,
  selectable = true,
  adjustableColumns = true,
  selectedRowIds,
  onSelectionChange,
  selectionActions,
  selectionPlacement = "header",
}: DashboardTableProps) {
  const t = useTranslations("console.agents");
  const columns = useMemo<TableColumn<DashboardTableRow>[]>(
    () =>
      headers.map((header, index) => ({
        key: String(index),
        header: header.label,
        align: header.align,
        width: header.width,
        cell: (row) => row.cells[index],
      })),
    [headers],
  );
  const toolbar: TableProps<DashboardTableRow>["selectionActions"] = (
    selection,
  ) => (
    <div
      role="toolbar"
      aria-label={t("selectedResources", {
        count: selection.selectedRowIds.length,
      })}
      className="flex flex-wrap items-center gap-2 py-1.5"
      style={
        selectionPlacement === "header"
          ? { maxWidth: "calc(100cqw - 80px)" }
          : undefined
      }
    >
      <span className="text-xs tabular-nums" aria-live="polite">
        {t("selectedResources", {
          count: selection.selectedRowIds.length,
        })}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("clearSelection")}
        onClick={selection.clearSelection}
      >
        <X className="size-3.5" />
      </Button>
      {selectionActions?.(selection)}
    </div>
  );
  const loadedIds = new Set(rows.map((row) => row.id));
  const selectedLoadedIds =
    selectable && selectionPlacement === "above"
      ? (selectedRowIds ?? []).filter((id) => loadedIds.has(id))
      : [];
  return (
    <section
      className={cn("min-w-0 overflow-x-auto", className, "rounded-xl")}
      aria-label={ariaLabel}
      style={{ containerType: "inline-size" }}
    >
      {selectedLoadedIds.length
        ? toolbar({
            selectedRows: rows.filter((row) =>
              selectedLoadedIds.includes(row.id),
            ),
            selectedRowIds: selectedLoadedIds,
            clearSelection: () => onSelectionChange?.([]),
          })
        : null}
      <div style={{ minWidth }}>
        <Table
          className={cn(
            "rounded-xl",
            height === undefined &&
              "[&>div:first-child]:h-auto! [&>div:first-child]:max-h-[640px]",
          )}
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          selectable={selectable}
          resizable={adjustableColumns}
          reorderable={adjustableColumns}
          selectedRowIds={selectedRowIds}
          onSelectionChange={onSelectionChange}
          selectionActions={
            selectionPlacement === "header" ? toolbar : undefined
          }
          height={height ?? 640}
        />
      </div>
    </section>
  );
}
