'use client';

import { useMemo, type ReactNode } from 'react';
import { Table, type TableColumn } from '@/components/motion/table';

export type DashboardTableRow = { id: string; cells: ReactNode[] };
export type DashboardTableProps = {
  headers: Array<{ label?: ReactNode; align?: 'left' | 'center' | 'right'; width?: string }>;
  rows: DashboardTableRow[];
  minWidth?: string;
  className?: string;
  ariaLabel?: string;
};

/** Server pages provide serializable cell content; beUI owns the table rendering. */
export function DashboardTable({ headers, rows, minWidth = '40rem', className, ariaLabel }: DashboardTableProps) {
  const columns = useMemo<TableColumn<DashboardTableRow>[]>(() => headers.map((header, index) => ({
    key: String(index), header: header.label, align: header.align, width: header.width, cell: (row) => row.cells[index],
  })), [headers]);
  return <div className={`min-w-0 overflow-x-auto ${className ?? ''}`} aria-label={ariaLabel}>
    <div style={{ minWidth }}><Table data={rows} columns={columns} getRowId={(row) => row.id} height={Math.min(640, (rows.length + 1) * 48)} /></div>
  </div>;
}
