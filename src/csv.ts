/**
 * CSV writer. Two protections:
 *  - formula injection: cells starting with = + - @ TAB CR are prefixed with a single quote;
 *  - Excel leading zeros: digit-string columns (codes, phones, accounts) are written as ="0123"
 *    when `excelSafe` is on, so spreadsheets keep them as text. Turn it off for raw machine use.
 */
export interface CsvColumn { header: string; value: (row: Record<string, unknown>) => unknown; text?: boolean }

const DANGEROUS = /^[=+\-@\t\r]/;

export function csvCell(raw: unknown, opts: { text?: boolean; excelSafe: boolean }): string {
  if (raw === null || raw === undefined) return "";
  let s = raw instanceof Date ? raw.toISOString() : String(raw);
  if (opts.text && opts.excelSafe && /^\+?\d+$/.test(s)) return `"=""${s}"""`;
  if (DANGEROUS.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: CsvColumn[], rows: Record<string, unknown>[], excelSafe: boolean): string {
  const lines = [columns.map((c) => csvCell(c.header, { excelSafe: false })).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row), { text: c.text, excelSafe })).join(","));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
