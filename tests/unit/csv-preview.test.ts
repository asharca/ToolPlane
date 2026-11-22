import { describe, expect, it } from "vitest";
import { parseDelimitedPreview } from "@/lib/csv-preview";
import {
  mimeTypeForFilename,
  previewType,
  tableDelimiter,
} from "@/lib/file-preview";

describe("parseDelimitedPreview", () => {
  it("parses RFC 4180 quoted fields, doubled quotes, embedded newlines, and CRLF", () => {
    const result = parseDelimitedPreview('a,"b,1"\r\n1,"x""y\nz"\n', ",");
    expect(result).toEqual({
      rows: [
        ["a", "b,1"],
        ["1", 'x"y\nz'],
      ],
      truncatedRows: false,
      truncatedColumns: false,
    });
  });

  it("truncates rows wider than maxColumns and flags truncatedColumns", () => {
    const headers = Array.from({ length: 60 }, (_, i) => `col_${i + 1}`);
    const values = Array.from({ length: 60 }, (_, i) => String(i + 1));
    const input = `${headers.join(",")}\n${values.join(",")}\n`;

    const result = parseDelimitedPreview(input, ",");
    expect(result.truncatedColumns).toBe(true);
    expect(result.truncatedRows).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toHaveLength(50);
    expect(result.rows[0][0]).toBe("col_1");
    expect(result.rows[0][49]).toBe("col_50");
    expect(result.rows[1]).toHaveLength(50);
  });

  it("strips leading BOM and ignores trailing empty lines", () => {
    expect(parseDelimitedPreview('""\n\n', ",").rows).toEqual([[""]]);
    const result = parseDelimitedPreview(
      '\uFEFF"name",value\nalpha,1\n\n\r\n',
      ",",
    );
    expect(result).toEqual({
      rows: [
        ["name", "value"],
        ["alpha", "1"],
      ],
      truncatedRows: false,
      truncatedColumns: false,
    });
  });

  it("supports CR-only line endings and tab delimiters", () => {
    const result = parseDelimitedPreview("k\tv\r1\t2\r3\t4\r", "\t");
    expect(result).toEqual({
      rows: [
        ["k", "v"],
        ["1", "2"],
        ["3", "4"],
      ],
      truncatedRows: false,
      truncatedColumns: false,
    });
  });

  it("flags truncatedRows only when non-empty rows remain beyond maxRows", () => {
    const exact = parseDelimitedPreview("a,b\n1,2\n\n", ",", { maxRows: 2 });
    expect(exact).toEqual({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      truncatedRows: false,
      truncatedColumns: false,
    });

    const over = parseDelimitedPreview("a,b\n1,2\n3,4\n", ",", { maxRows: 2 });
    expect(over).toEqual({
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
      truncatedRows: true,
      truncatedColumns: false,
    });
  });

  it("returns empty rows for empty or newline-only input", () => {
    expect(parseDelimitedPreview("", ",")).toEqual({
      rows: [],
      truncatedRows: false,
      truncatedColumns: false,
    });
    expect(parseDelimitedPreview("\r\n\n", ",")).toEqual({
      rows: [],
      truncatedRows: false,
      truncatedColumns: false,
    });
  });
});

describe("file-preview table and mime helpers", () => {
  it("classifies CSV and TSV as table previews ahead of text", () => {
    expect(previewType("sales.csv")).toEqual({ kind: "table" });
    expect(previewType("sales.csv", "text/plain")).toEqual({ kind: "table" });
    expect(previewType("metrics.tsv")).toEqual({ kind: "table" });
    expect(previewType("export", "text/csv; charset=utf-8")).toEqual({
      kind: "table",
    });
    expect(previewType("export", "text/tab-separated-values")).toEqual({
      kind: "table",
    });
  });

  it("selects delimiter from filename or mime type", () => {
    expect(tableDelimiter("data.csv")).toBe(",");
    expect(tableDelimiter("data.tsv")).toBe("\t");
    expect(
      tableDelimiter("export", "text/tab-separated-values; charset=utf-8"),
    ).toBe("\t");
    expect(tableDelimiter("export", "text/csv")).toBe(",");
  });

  it("maps known filename extensions to MIME types and defaults to octet-stream", () => {
    expect(mimeTypeForFilename("chart.png")).toBe("image/png");
    expect(mimeTypeForFilename("report.pdf")).toBe("application/pdf");
    expect(mimeTypeForFilename("sales.csv")).toBe("text/csv");
    expect(mimeTypeForFilename("data.tsv")).toBe("text/tab-separated-values");
    expect(mimeTypeForFilename("summary.md")).toBe("text/markdown");
    expect(mimeTypeForFilename("notes.txt")).toBe("text/plain");
    expect(mimeTypeForFilename("config.yml")).toBe("application/yaml");
    expect(mimeTypeForFilename("book.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeTypeForFilename("archive.bin")).toBe("application/octet-stream");
    expect(mimeTypeForFilename("weird.toString")).toBe(
      "application/octet-stream",
    );
  });
});
