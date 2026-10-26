import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { flexRender } from "@tanstack/react-table";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import { getColumnPinningStyle } from "@/lib/data-table";
import { cn } from "@/lib/utils";
import { computeScrollEdges } from "./scrollEdges.js";
import { describeSortState } from "./sortState.js";

const HEADER_MIN_WIDTH = 64;

function getColumnAlignClass(column) {
  const align = column?.columnDef?.meta?.align;
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "";
}

function DataTable({
  table,
  actionBar,
  children,
  className,
  tableClassName,
  tableContainerClassName,
  tableChrome,
  tableChromeClassName,
  onRowClick,
  footerRow,
  resizable = false,
  onHorizontalScroll,
  onVisibleRowsChange,
  tableScrollRef,
  rowTestIdPrefix = "",
  rowGroupBy,
  rowGroupSort,
  renderRowGroup,
  ...props
}) {
  const rowRefs = useRef(new Map());
  const scrollNodeRef = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const node = scrollNodeRef.current;
    if (!node) return;
    const next = computeScrollEdges(node);
    setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);
  const setScrollNode = useCallback((node) => {
    scrollNodeRef.current = node;
    if (typeof tableScrollRef === "function") tableScrollRef(node);
    else if (tableScrollRef) tableScrollRef.current = node;
  }, [tableScrollRef]);
  useEffect(() => {
    const node = scrollNodeRef.current;
    if (!node) return undefined;
    updateEdges();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    const tableNode = node.querySelector("table");
    if (tableNode) observer.observe(tableNode);
    return () => observer.disconnect();
  }, [updateEdges]);
  // 只有本来就撑满父容器的表格才让外层包裹继续 flex-1；否则高度跟随内容（审计 batch2 #10）。
  const scrollWrapperGrows = /(^|\s)flex-1(\s|$)/.test(String(tableContainerClassName || ""));
  const rowModelRows = table.getRowModel().rows || [];
  const rowIdsSignature = rowModelRows.map((row) => row.id).join("|");

  const groupedRows = typeof rowGroupBy === "function"
    ? (() => {
      const groups = new Map();
      rowModelRows.forEach((row) => {
        const descriptor = rowGroupBy(row);
        const normalizedDescriptor = descriptor && typeof descriptor === "object"
          ? descriptor
          : { key: descriptor, label: descriptor };
        const key = String(normalizedDescriptor.key ?? normalizedDescriptor.label ?? "");
        if (!groups.has(key)) {
          groups.set(key, {
            ...normalizedDescriptor,
            key,
            label: normalizedDescriptor.label ?? key,
            rows: [],
          });
        }
        groups.get(key).rows.push(row);
      });
      const next = Array.from(groups.values());
      if (typeof rowGroupSort === "function") next.sort(rowGroupSort);
      return next;
    })()
    : null;

  useEffect(() => {
    if (typeof onVisibleRowsChange !== "function") return undefined;
    const currentRows = table.getRowModel().rows || [];
    if (typeof IntersectionObserver === "undefined") {
      onVisibleRowsChange(currentRows.map((row) => row.original));
      return undefined;
    }
    const visibleIds = new Set();
    const emit = () => {
      const visibleRows = currentRows
        .filter((row) => visibleIds.has(row.id))
        .map((row) => row.original);
      onVisibleRowsChange(visibleRows);
    };
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const rowId = entry.target.getAttribute("data-row-id");
        if (!rowId) return;
        if (entry.isIntersecting) visibleIds.add(rowId);
        else visibleIds.delete(rowId);
      });
      emit();
    }, { threshold: 0.01, rootMargin: "0px 0px 120px 0px" });
    rowRefs.current.forEach((element) => observer.observe(element));
    emit();
    return () => observer.disconnect();
  }, [onVisibleRowsChange, rowIdsSignature, table]);


  const renderDataRow = (row) => {
    const rowSymbol = row.original?.symbol || row.original?.code || "";
    return (
      <TableRow
        key={row.id}
        ref={(element) => {
          if (element) rowRefs.current.set(row.id, element);
          else rowRefs.current.delete(row.id);
        }}
        data-row-id={row.id}
        data-row-symbol={rowSymbol || undefined}
        data-testid={rowTestIdPrefix && rowSymbol ? rowTestIdPrefix + "-" + rowSymbol : undefined}
        data-state={row.getIsSelected() && "selected"}
        className={cn(
          "group transition-colors",
          row.original?.isHeld ? "bg-indigo-50/25 hover:bg-indigo-50/50" : "hover:bg-slate-50/80",
          onRowClick && "cursor-pointer"
        )}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell
            key={cell.id}
            className={cn(
              getColumnAlignClass(cell.column),
              cell.column.getIsPinned() && (row.original?.isHeld ? "bg-[#f8faff] group-hover:bg-[#f3f6ff]" : "bg-white group-hover:bg-slate-50")
            )}
            style={{
              ...getColumnPinningStyle({ column: cell.column }),
              zIndex: cell.column.getIsPinned() ? 10 : undefined,
              backgroundColor: cell.column.getIsPinned()
                ? (row.original?.isHeld ? '#f8faff' : '#ffffff')
                : undefined,
            }}
          >
            {flexRender(
              cell.column.columnDef.cell,
              cell.getContext()
            )}
          </TableCell>
        ))}
      </TableRow>
    );
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-2.5 overflow-auto",
        resizable && "md:min-h-[320px] md:min-w-[720px] md:max-h-[calc(100vh-160px)] md:max-w-[calc(100vw-48px)] md:resize",
        className
      )}
      {...props}
    >
      {children}
      <div className={cn("data-table-scroll-wrap relative flex min-h-0 min-w-0 max-w-full flex-col", scrollWrapperGrows && "flex-1")} data-scroll-left={edges.left ? "true" : undefined} data-scroll-right={edges.right ? "true" : undefined}>
      <div
        ref={setScrollNode}
        onScroll={(event) => { updateEdges(); onHorizontalScroll?.(event); }}
        role="region"
        aria-label={edges.left || edges.right ? "数据表格（可左右滑动查看更多列）" : "数据表格"}
        tabIndex={0}
        className={cn("max-w-full overflow-x-auto overscroll-x-contain rounded-2xl border border-slate-200 bg-white focus-visible:outline-2 focus-visible:outline-indigo-400", tableContainerClassName)}
      >
        {tableChrome ? (
          <div
            className={cn(
              "sticky top-0 z-30 min-h-[55px] border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85",
              tableChromeClassName
            )}
          >
            {tableChrome}
          </div>
        ) : null}
        <table className={cn("w-full caption-bottom text-sm border-separate border-spacing-0", tableClassName)}>
          <TableHeader className={cn("sticky top-0 z-20 bg-slate-50/95 backdrop-blur", tableChrome && "top-[55px]")}>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const pinStyle = getColumnPinningStyle({ column: header.column });
                  const minWidth = Math.max(Number(pinStyle.minWidth) || 0, HEADER_MIN_WIDTH);
                  return (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={header.column.getCanSort() ? describeSortState(header.column.getIsSorted()).ariaSort : undefined}
                    className={cn(
                      getColumnAlignClass(header.column),
                      "h-auto min-h-11 whitespace-normal bg-slate-50 text-slate-600 font-medium py-2.5 border-b border-slate-200 select-none",
                      header.column.getIsPinned() && "bg-slate-50"
                    )}
                    style={{
                      ...pinStyle,
                      minWidth,
                      width: Math.max(Number(pinStyle.width) || 0, minWidth),
                      maxWidth: Math.max(Number(pinStyle.maxWidth) || 0, minWidth),
                      position: 'sticky',
                      top: tableChrome ? 55 : 0,
                      zIndex: header.column.getIsPinned() ? 35 : 20,
                      backgroundColor: '#f8fafc',
                    }}
                  >
                    {header.isPlaceholder ? null : flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {groupedRows && groupedRows.length ? (
              groupedRows.map((group) => (
                <Fragment key={group.key}>
                  <TableRow className="bg-slate-50/90 hover:bg-slate-50">
                    <TableCell
                      colSpan={table.getVisibleLeafColumns().length}
                      className="border-b border-slate-200 px-3 py-2.5"
                    >
                      {typeof renderRowGroup === "function" ? renderRowGroup(group) : group.label}
                    </TableCell>
                  </TableRow>
                  {group.rows.map(renderDataRow)}
                </Fragment>
              ))
            ) : rowModelRows?.length ? (
              rowModelRows.map(renderDataRow)
            ) : (
              <TableRow>
                <TableCell
                  colSpan={table.getAllColumns().length}
                  className="h-32 text-center text-sm text-slate-500"
                >
                  暂无数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {footerRow ? (
            <TableFooter>
              <TableRow>
                {table.getVisibleLeafColumns().map((column) => (
                  <TableCell
                    key={column.id}
                    className={getColumnAlignClass(column)}
                    style={{
                      ...getColumnPinningStyle({ column })
                    }}
                  >
                    {footerRow[column.id] != null ? footerRow[column.id] : null}
                  </TableCell>
                ))}
              </TableRow>
            </TableFooter>
          ) : null}
        </table>
      </div>
      <span aria-hidden="true" className="data-table-scroll-shadow data-table-scroll-shadow--left" />
      <span aria-hidden="true" className="data-table-scroll-shadow data-table-scroll-shadow--right" />
      {edges.right && !edges.left ? <span className="data-table-scroll-hint" aria-hidden="true">左右滑动查看更多 →</span> : null}
      </div>
      <div className="flex flex-col gap-2.5">
        <DataTablePagination table={table} />
        {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
      </div>
    </div>
  );
}
export {
  DataTable
};
