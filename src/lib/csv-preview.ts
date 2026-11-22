export type DelimitedPreviewOptions = {
  maxRows?: number;
  maxColumns?: number;
};

export type DelimitedPreview = {
  rows: string[][];
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

/**
 * RFC 4180 delimited text parser for preview tables.
 * Handles quoted fields, doubled quotes, quoted newlines, CR/LF/CRLF,
 * leading UTF-8 BOM, and trailing empty lines.
 */
export function parseDelimitedPreview(
  text: string,
  delimiter: string,
  { maxRows = 1000, maxColumns = 50 }: DelimitedPreviewOptions = {},
): DelimitedPreview {
  // Strip physical trailing line breaks, not a quoted empty field (a valid record).
  let end = text.length;
  while (end && (text[end - 1] === "\r" || text[end - 1] === "\n")) end--;
  const input = text.slice(text.startsWith("\uFEFF") ? 1 : 0, end);
  if (input.length === 0) {
    return { rows: [], truncatedRows: false, truncatedColumns: false };
  }
  if (maxRows <= 0) {
    return {
      rows: [],
      truncatedRows: true,
      truncatedColumns: false,
    };
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let atFieldStart = true;
  let truncatedRows = false;
  let truncatedColumns = false;
  let stoppedAtRowLimit = false;

  const pushField = () => {
    if (row.length < maxColumns) {
      row.push(field);
    } else {
      truncatedColumns = true;
    }
    field = "";
    atFieldStart = true;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          if (row.length < maxColumns) field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (row.length < maxColumns) {
        field += ch;
      }
      continue;
    }

    if (atFieldStart && ch === '"') {
      inQuotes = true;
      atFieldStart = false;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      pushField();
      rows.push(row);
      row = [];
      if (rows.length >= maxRows) {
        stoppedAtRowLimit = true;
        truncatedRows = i + 1 < input.length;
        break;
      }
    } else {
      if (row.length < maxColumns) field += ch;
      atFieldStart = false;
    }
  }

  if (
    !stoppedAtRowLimit &&
    (row.length > 0 || !atFieldStart || field.length > 0)
  ) {
    pushField();
    rows.push(row);
  }

  return { rows, truncatedRows, truncatedColumns };
}
