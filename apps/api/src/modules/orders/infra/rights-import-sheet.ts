// B1-09g: reading the first sheet of an uploaded xlsx (read-excel-file, B1-09fa / D10-178) for the
// admin Excel imports. Row 1 is the header; data rows keep their number in the file. A row whose
// cells are all empty is no data row (not counted, not processed). Anything that is not a readable
// xlsx (not a zip, a zip without a workbook, a truncated file) is `null`: the caller decides.
// Never logs: callers log ids and counts only, never a cell.
import { readSheet } from 'read-excel-file/node';
import type { RightsImportCell } from '../application/rights-import-ports.ts';

export interface RightsImportSheetRow {
  /** The row's number in the file (the header is row 1). */
  readonly row_no: number;
  readonly cells: readonly RightsImportCell[];
}

export interface RightsImportSheet {
  /** The first row's cells (empty when the sheet has no row). */
  readonly header: readonly RightsImportCell[];
  readonly rows: readonly RightsImportSheetRow[];
}

const isEmpty = (cell: unknown): boolean =>
  cell === null || cell === undefined || (typeof cell === 'string' && cell.trim() === '');

function cellOf(value: unknown): RightsImportCell {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  ) {
    return value;
  }
  return null;
}

/** The first sheet, or null when the bytes are not a readable xlsx. */
export async function readRightsImportSheet(bytes: Uint8Array): Promise<RightsImportSheet | null> {
  let data: readonly (readonly unknown[])[];
  try {
    data = (await readSheet(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    )) as unknown as readonly (readonly unknown[])[];
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const [first, ...rest] = data;
  const header = (first ?? []).map(cellOf);
  const rows: RightsImportSheetRow[] = [];
  rest.forEach((cells, index) => {
    if (!Array.isArray(cells) || cells.every(isEmpty)) return;
    rows.push({ row_no: index + 2, cells: cells.map(cellOf) });
  });
  return { header, rows };
}
