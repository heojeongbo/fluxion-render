/**
 * Shader sources + compile/link helpers for the WebGL backend. One affine
 * position program serves BOTH data-space polylines and px-space grid/tick
 * lines — only the uniform values differ (see `gl-transform.ts`).
 */

export const LINE_VS = `
attribute vec2 aPos;
uniform vec2 uOrigin;
uniform vec2 uScale;
uniform vec2 uOffset;
void main() {
  gl_Position = vec4((aPos - uOrigin) * uScale + uOffset, 0.0, 1.0);
}
`;

export const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }
`;

export interface LineProgram {
  program: WebGLProgram;
  aPos: number;
  uOrigin: WebGLUniformLocation;
  uScale: WebGLUniformLocation;
  uOffset: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
}

function compile(
  gl: WebGLRenderingContext,
  type: number,
  src: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  /* v8 ignore start -- createShader returns null only on a lost context */
  if (!shader) return null;
  /* v8 ignore stop */
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[fluxion] webgl shader compile failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Compile+link the affine line program; null (with a warn) on failure. */
export function buildLineProgram(gl: WebGLRenderingContext): LineProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, LINE_VS);
  const fs = compile(gl, gl.FRAGMENT_SHADER, LINE_FS);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  /* v8 ignore start -- createProgram returns null only on a lost context */
  if (!program) return null;
  /* v8 ignore stop */
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // The shaders are owned by the program after linking.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[fluxion] webgl program link failed:", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  const uOrigin = gl.getUniformLocation(program, "uOrigin");
  const uScale = gl.getUniformLocation(program, "uScale");
  const uOffset = gl.getUniformLocation(program, "uOffset");
  const uColor = gl.getUniformLocation(program, "uColor");
  /* v8 ignore start -- a linked program always exposes its active uniforms */
  if (!uOrigin || !uScale || !uOffset || !uColor) return null;
  /* v8 ignore stop */
  return {
    program,
    aPos: gl.getAttribLocation(program, "aPos"),
    uOrigin,
    uScale,
    uOffset,
    uColor,
  };
}
