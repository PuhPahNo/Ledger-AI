export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0] ?? {});
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => quote(row[header])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function quote(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
