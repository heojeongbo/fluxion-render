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

/**
 * Textured quad for label sprites: a unit quad (aUnit ∈ [0,1]²) placed by the
 * px-space rect uniform, then through the SAME affine as the line program.
 * Texcoords are the unit coords directly (sprite textures are not atlased).
 */
export const QUAD_VS = `
attribute vec2 aUnit;
uniform vec4 uRect;
uniform vec2 uOrigin;
uniform vec2 uScale;
uniform vec2 uOffset;
varying vec2 vTex;
void main() {
  vec2 pos = uRect.xy + aUnit * uRect.zw;
  gl_Position = vec4((pos - uOrigin) * uScale + uOffset, 0.0, 1.0);
  vTex = aUnit;
}
`;

export const QUAD_FS = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vTex;
void main() { gl_FragColor = texture2D(uTex, vTex); }
`;

export interface QuadProgram {
  program: WebGLProgram;
  aUnit: number;
  uRect: WebGLUniformLocation;
  uOrigin: WebGLUniformLocation;
  uScale: WebGLUniformLocation;
  uOffset: WebGLUniformLocation;
  uTex: WebGLUniformLocation;
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

/** Compile+link a program from sources; null (with a warn) on failure. */
function link(
  gl: WebGLRenderingContext,
  vsSrc: string,
  fsSrc: string,
): WebGLProgram | null {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
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
  return program;
}

/** Compile+link the affine line program; null (with a warn) on failure. */
export function buildLineProgram(gl: WebGLRenderingContext): LineProgram | null {
  const program = link(gl, LINE_VS, LINE_FS);
  if (!program) return null;
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

/** Compile+link the label-sprite quad program; null (with a warn) on failure. */
export function buildQuadProgram(gl: WebGLRenderingContext): QuadProgram | null {
  const program = link(gl, QUAD_VS, QUAD_FS);
  if (!program) return null;
  const uRect = gl.getUniformLocation(program, "uRect");
  const uOrigin = gl.getUniformLocation(program, "uOrigin");
  const uScale = gl.getUniformLocation(program, "uScale");
  const uOffset = gl.getUniformLocation(program, "uOffset");
  const uTex = gl.getUniformLocation(program, "uTex");
  /* v8 ignore start -- a linked program always exposes its active uniforms */
  if (!uRect || !uOrigin || !uScale || !uOffset || !uTex) return null;
  /* v8 ignore stop */
  return {
    program,
    aUnit: gl.getAttribLocation(program, "aUnit"),
    uRect,
    uOrigin,
    uScale,
    uOffset,
    uTex,
  };
}
