import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fix } from "../src/review/fix.js";
import { isDisabled } from "../src/review/review.js";
import { ids, project, reviewFiles, THREE_DIR } from "./helpers.js";

const legacy = `import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio( window.devicePixelRatio );
renderer.outputEncoding = THREE.sRGBEncoding;
const g = new THREE.BoxBufferGeometry( 1, 1, 1 );
const a = THREE.Math.degToRad( 90 );
// THREE.PlaneBufferGeometry in a comment stays
mesh.geometry.applyMatrix( m );
texture.encoding = THREE.sRGBEncoding;
`;

describe("fix", () => {
  it("is a dry run unless --write", () => {
    const dir = project({ "a.js": legacy });
    const r = fix({ path: dir, three: THREE_DIR });
    expect(r.total).toBe(7);
    expect(readFileSync(join(dir, "a.js"), "utf8")).toBe(legacy);
  });

  it("rewrites only what means the same, leaves comments, and clears those findings", () => {
    const dir = project({ "a.js": legacy });
    fix({ path: dir, three: THREE_DIR, write: true });
    const out = readFileSync(join(dir, "a.js"), "utf8");
    expect(out).toContain("new THREE.BoxGeometry( 1, 1, 1 )");
    expect(out).toContain("THREE.MathUtils.degToRad( 90 )");
    expect(out).toContain("applyMatrix4( m )");
    expect(out).toContain("'three/addons/loaders/GLTFLoader.js'");
    expect(out).toContain("renderer.outputColorSpace = THREE.SRGBColorSpace");
    expect(out).toContain("texture.colorSpace = THREE.SRGBColorSpace");
    expect(out).toContain("setPixelRatio( Math.min( window.devicePixelRatio, 2 ) )");
    expect(out).toContain("// THREE.PlaneBufferGeometry in a comment stays");
    const after = ids(reviewFiles({ "a.js": out }));
    for (const id of ["buffer-geometry-alias", "three-math", "apply-matrix", "addons-path", "output-encoding", "texture-encoding", "pixel-ratio-uncapped"]) {
      expect(after).not.toContain(id);
    }
    expect(fix({ path: dir, three: THREE_DIR }).total).toBe(0);
  });

  it("does not duplicate a name that is already imported", () => {
    const src = "import { BoxGeometry, BoxBufferGeometry } from 'three';\nnew BoxBufferGeometry();\n";
    const dir = project({ "a.js": src });
    fix({ path: dir, three: THREE_DIR, write: true });
    expect(readFileSync(join(dir, "a.js"), "utf8")).toContain("import { BoxGeometry, BoxBufferGeometry } from 'three';");
  });
});

describe("inline disable comments", () => {
  const f = { rule: "alloc-in-loop", line: 3 } as never;
  it("covers next line, same line and file, by rule", () => {
    expect(isDisabled(f, ["", "// threesmith-disable-next-line alloc-in-loop", "x"])).toBe(true);
    expect(isDisabled(f, ["", "// threesmith-disable-next-line other-rule", "x"])).toBe(false);
    expect(isDisabled(f, ["", "", "x // threesmith-disable-line"])).toBe(true);
    expect(isDisabled(f, ["/* threesmith-disable-file alloc-in-loop */", "", ""])).toBe(true);
    expect(isDisabled(f, ["", "", ""])).toBe(false);
  });
  it("applies in a review", () => {
    const src = "import * as THREE from 'three';\n// threesmith-disable-next-line geometry-class\nnew THREE.Geometry();\nnew THREE.Face3();\n";
    const r = ids(reviewFiles({ "a.js": src }));
    expect(r).not.toContain("geometry-class");
    expect(r).toContain("face3");
  });
});
