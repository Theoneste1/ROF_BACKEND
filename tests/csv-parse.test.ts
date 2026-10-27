import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/csvParse.js";

describe("CSV parser", () => {
  it("handles quotes, embedded commas/newlines, CRLF and BOM", () => {
    expect(parseCsv('\uFEFFa,b\r\n"x,1","he said ""hi""\nthere"\r\n')).toEqual([["a", "b"], ["x,1", 'he said "hi"\nthere']]);
  });
  it("keeps leading zeros (everything is text) and drops blank lines", () => {
    expect(parseCsv("code,name\n000123,A\n\n,\n")).toEqual([["code", "name"], ["000123", "A"]]);
  });
  it("handles a file without a trailing newline and empty input", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("")).toEqual([]);
  });
});
