import { afterEach, describe, expect, it } from "vitest";
import { parseColor, resetParseColorCache } from "./parse-color";

describe("parseColor", () => {
  afterEach(() => {
    resetParseColorCache();
  });

  it("parses the library's default colors exactly", () => {
    expect(parseColor("#0b0d12")).toEqual([11 / 255, 13 / 255, 18 / 255, 1]); // engine bg
    expect(parseColor("#4fc3f7")).toEqual([79 / 255, 195 / 255, 247 / 255, 1]); // line
    expect(parseColor("rgba(255,255,255,0.08)")).toEqual([1, 1, 1, 0.08]); // grid
    expect(parseColor("rgba(255, 255, 255, 0.7)")).toEqual([1, 1, 1, 0.7]); // labels
    expect(parseColor("#666")).toEqual([0.4, 0.4, 0.4, 1]); // AxisStyle default
  });

  it("parses 4- and 8-digit hex with alpha", () => {
    expect(parseColor("#f00c")).toEqual([1, 0, 0, 0.8]);
    expect(parseColor("#ff000080")).toEqual([1, 0, 0, 128 / 255]);
  });

  it("parses rgb() without alpha as opaque", () => {
    expect(parseColor("rgb(0, 128, 255)")).toEqual([0, 128 / 255, 1, 1]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseColor("  #fff ")).toEqual([1, 1, 1, 1]);
  });

  it("returns null for unsupported or malformed strings", () => {
    expect(parseColor("tomato")).toBeNull(); // named colors unsupported
    expect(parseColor("#12345")).toBeNull(); // wrong hex length
    expect(parseColor("#12g")).toBeNull(); // non-hex digit
    expect(parseColor("rgba(300,0,0,1)")).toBeNull(); // channel out of range
    expect(parseColor("rgba(0,0,0,1.5)")).toBeNull(); // alpha out of range
    expect(parseColor("hsl(10, 50%, 50%)")).toBeNull();
  });

  it("memoizes per string (same array reference on repeat)", () => {
    const a = parseColor("#4fc3f7");
    const b = parseColor("#4fc3f7");
    expect(b).toBe(a);
  });

  it("caps the memo cache without breaking correctness", () => {
    for (let i = 0; i < 300; i++) parseColor(`rgb(${i % 255},${Math.floor(i / 255)},0)`);
    expect(parseColor("#fff")).toEqual([1, 1, 1, 1]);
  });
});
