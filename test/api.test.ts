import { describe, expect, it } from "vitest";
import { findThree } from "../src/api/install.js";
import { buildIndex } from "../src/api/index-builder.js";
import { formatSearch, lookup, search, suggest } from "../src/api/lookup.js";

const install = findThree(process.cwd());
const index = install ? buildIndex(install) : undefined;

describe("api index (needs three in node_modules)", () => {
  it("finds the installed three", () => {
    expect(install?.release).toBeGreaterThan(150);
  });
  it("indexes core, webgpu and addon exports", () => {
    expect(index?.exports.has("Mesh")).toBe(true);
    expect(index?.exports.has("WebGLRenderer")).toBe(true);
    expect(index?.exports.get("SRGBColorSpace")?.importPath).toBe("three");
    expect(index?.exports.get("WebGPURenderer")?.importPath).toBe("three/webgpu");
    expect(index?.exports.get("OrbitControls")?.importPath).toBe("three/addons/controls/OrbitControls.js");
  });
  it("looks up a class with constructor and inheritance", () => {
    const r = lookup(index!, "Mesh");
    expect(r.found).toBe(true);
    expect(r.text).toContain("import { Mesh } from 'three';");
    expect(r.text).toContain("Extends: Object3D");
    expect(r.text).toContain("geometry");
  });
  it("looks up a member, also inherited", () => {
    const r = lookup(index!, "THREE.Mesh.add");
    expect(r.found).toBe(true);
    expect(r.text).toContain("inherited from Object3D");
  });
  it("reads deprecation from the source", () => {
    expect(lookup(index!, "Clock").text).toContain("Deprecated");
  });
  it("looks up a constant", () => {
    expect(lookup(index!, "SRGBColorSpace").text).toContain("Constant");
  });
  it("suggests near names for a typo", () => {
    expect(suggest(index!, "WebGLRendrer")).toContain("WebGLRenderer");
    const r = lookup(index!, "Geometry");
    expect(r.found).toBe(false);
  });
  it("searches names and members", () => {
    expect(search(index!, "orbitcontrols")[0]?.name).toBe("OrbitControls");
    const hits = search(index!, "raycast", { members: true });
    expect(hits.some((h) => h.member === "raycast")).toBe(true);
    expect(formatSearch(index!, hits)).toContain("raycast");
  });
});
