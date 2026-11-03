import { describe, expect, it } from "vitest";
import { buildIndex } from "../src/api/index-builder.js";
import { findThree } from "../src/api/install.js";
import { explain, formatExplanations, parseShaderErrors } from "../src/explain/explain.js";
import { locateCode } from "../src/explain/locate.js";
import { project } from "./helpers.js";

const index = buildIndex(findThree(process.cwd())!);
const ids = (t: string) => explain(t, index).map((e) => e.id);

describe("explain", () => {
  it("names the right import path for a missing export", () => {
    const r = explain("SyntaxError: The requested module 'three' does not provide an export named 'OrbitControls'", index);
    expect(r[0]?.id).toBe("export-not-found");
    expect(r[0]?.detail).toContain("three/addons/controls/OrbitControls.js");
  });
  it("knows removed classes", () => {
    const r = explain("TypeError: THREE.Geometry is not a constructor", index);
    expect(r[0]?.id).toBe("not-a-constructor");
    expect(r[0]?.detail).toContain("does not exist");
  });
  it("recognises the common runtime failures", () => {
    expect(ids("Failed to resolve module specifier \"three\". Relative references must start with")).toContain("bare-specifier");
    expect(ids("WARNING: Multiple instances of Three.js being imported.")).toContain("multiple-instances");
    expect(ids("TypeError: Cannot read properties of undefined (reading 'isBufferGeometry')")).toEqual(["undefined-geometry"]);
    expect(ids("TypeError: Cannot read properties of undefined (reading 'scene')")).toContain("used-before-load");
    expect(ids("SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")).toContain("html-instead-of-model");
    expect(ids("THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN.")).toContain("nan-geometry");
    expect(ids("THREE.WebGLRenderer: Context Lost.")).toContain("context-lost");
    expect(ids("WARNING: Too many active WebGL contexts. Oldest context will be lost.")).toContain("too-many-contexts");
    expect(ids("Access to image at 'x' from origin 'y' has been blocked by CORS policy")).toContain("cors");
    expect(ids("THREE.GLTFLoader: No DRACOLoader instance provided.")).toContain("decoder-path");
    expect(ids("hello world")).toEqual([]);
    expect(formatExplanations([])).toContain("No known");
  });
  it("reads shader errors and their failing line", () => {
    const msg = `THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false

Material Name:
Material Type: ShaderMaterial

Program Info Log: Fragment shader is not compiled.

FRAGMENT

ERROR: 0:120: 'colr' : undeclared identifier
ERROR: 0:120: 'assign' : cannot convert from 'const mediump float' to 'out highp 4-component vector of float'

  119: void main() {
> 120:   gl_FragColor = vec4(colr, 1.0);
  121: }`;
    const errs = parseShaderErrors(msg);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatchObject({ stage: "fragment", line: 120, message: "'colr' : undeclared identifier", code: "gl_FragColor = vec4(colr, 1.0);" });
    expect(ids(msg)).toContain("shader-error");
  });
  it("finds the user's own line for a shader line", () => {
    const dir = project({ "src/shader.js": "export const frag = `\nvoid main() {\n  gl_FragColor = vec4(colr, 1.0);\n}`;\n", "node_modules/x.js": "gl_FragColor = vec4(colr, 1.0);" });
    expect(locateCode(dir, "gl_FragColor = vec4(colr, 1.0);")).toBe("src/shader.js:3");
    expect(locateCode(dir, "x")).toBeUndefined();
  });
});
