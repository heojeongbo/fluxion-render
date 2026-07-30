import { describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/setup";
import { buildLineProgram } from "./gl-programs";

describe("buildLineProgram", () => {
  it("links the affine program and resolves its locations", () => {
    const gl = createFakeGl({ width: 100, height: 100 });
    const prog = buildLineProgram(gl as unknown as WebGLRenderingContext);
    expect(prog).not.toBeNull();
    expect(prog!.aPos).toBe(0);
    // Shaders are deleted after linking (owned by the program).
    expect(gl.calls.filter((c) => c.name === "deleteShader")).toHaveLength(2);
  });

  it("warns and returns null when a shader fails to compile", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gl = createFakeGl({ width: 100, height: 100 });
    gl.failCompile = true;
    expect(buildLineProgram(gl as unknown as WebGLRenderingContext)).toBeNull();
    expect(String(warnSpy.mock.calls[0]![0])).toContain("shader compile failed");
    warnSpy.mockRestore();
  });

  it("warns, deletes the program, and returns null when linking fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gl = createFakeGl({ width: 100, height: 100 });
    gl.failLink = true;
    expect(buildLineProgram(gl as unknown as WebGLRenderingContext)).toBeNull();
    expect(String(warnSpy.mock.calls[0]![0])).toContain("program link failed");
    expect(gl.calls.some((c) => c.name === "deleteProgram")).toBe(true);
    warnSpy.mockRestore();
  });
});
