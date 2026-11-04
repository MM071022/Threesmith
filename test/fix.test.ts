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

describe("fixes for the newer rules", () => {
  const T = "import * as THREE from 'three';\n";
  const cases: { rule: string; files: Record<string, string>; file?: string; want: string[]; keep?: string[] }[] = [
    {
      rule: "shader-include-unknown",
      files: { "a.js": `${T}const f = \`\nvoid main() {\n  gl_FragColor = vec4(1.0);\n  #include <encodings_fragment>\n}\`;\n` },
      want: ["#include <colorspace_fragment>"],
    },
    {
      rule: "shader-patch-target-missing",
      files: { "a.js": `${T}m.onBeforeCompile = (s) => { s.fragmentShader = s.fragmentShader.replace('#include <output_fragment>', 'x'); };\n` },
      want: ["replace('#include <opaque_fragment>', 'x')"],
    },
    {
      rule: "shader-depth-define-renamed",
      files: { "a.js": `${T}const f = \`void main() {\n#ifdef USE_LOGDEPTHBUF\n#endif\n}\`;\n` },
      want: ["#ifdef USE_LOGARITHMIC_DEPTH_BUFFER"],
    },
    {
      rule: "shader-inverse-transform-direction",
      files: { "a.js": `${T}const f = \`void main() { vec3 d = inverseTransformDirection(n, viewMatrix); gl_FragColor = vec4(d, 1.0); }\`;\n` },
      want: ["transformDirectionByInverseViewMatrix(n, viewMatrix)"],
    },
    {
      rule: "rgbe-loader-deprecated",
      files: { "a.js": `${T}import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';\nconsole.log('RGBELoader');\nnew RGBELoader().load('a.hdr');\n` },
      want: ["import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';", "new HDRLoader().load", "console.log('RGBELoader');"],
    },
    {
      rule: "pcf-soft-shadow",
      files: { "a.js": `${T}renderer.shadowMap.type = THREE.PCFSoftShadowMap;\n` },
      want: ["THREE.PCFShadowMap;"],
    },
    {
      rule: "post-processing-renamed",
      files: { "a.js": "import { WebGPURenderer, PostProcessing } from 'three/webgpu';\nconst p = new PostProcessing(renderer);\n" },
      want: ["import { WebGPURenderer, RenderPipeline } from 'three/webgpu';", "new RenderPipeline(renderer)"],
    },
    {
      rule: "reverse-depth-buffer-option",
      files: { "a.js": `${T}new THREE.WebGLRenderer({ reverseDepthBuffer: true });\n` },
      want: ["reversedDepthBuffer: true"],
    },
    {
      rule: "color-buffer-type-option",
      files: { "a.js": "import * as THREE from 'three/webgpu';\nnew THREE.WebGPURenderer({ colorBufferType: THREE.HalfFloatType });\n" },
      want: ["outputBufferType: THREE.HalfFloatType"],
    },
    {
      rule: "text-geometry-height",
      files: { "a.js": `${T}const g = new TextGeometry('Hi', { font, size: 1, height: 0.2 });\nconst box = { height: 1 };\n` },
      want: ["{ font, size: 1, depth: 0.2 }", "const box = { height: 1 };"],
    },
    {
      rule: "transform-controls-add",
      files: { "a.js": `${T}const gizmo = new TransformControls(camera, renderer.domElement);\nscene.add(gizmo);\nscene.add(mesh);\n` },
      want: ["scene.add(gizmo.getHelper());", "scene.add(mesh);"],
    },
    {
      rule: "addon-path-extension",
      files: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls';\n` },
      want: ["'three/addons/controls/OrbitControls.js'"],
    },
    {
      rule: "render-args-swapped",
      files: { "a.js": `${T}renderer.render(camera, scene);\n` },
      want: ["renderer.render(scene, camera);"],
    },
    {
      rule: "color-assign-number",
      files: { "a.js": `${T}material.color = 0xff0000;\nlabel.style.color = '#fff';\n` },
      want: ["material.color.set( 0xff0000 );", "label.style.color = '#fff';"],
    },
    {
      rule: "tsl-renamed",
      files: { "a.js": "import { WebGPURenderer } from 'three/webgpu';\nimport { directionToColor, PI2 } from 'three/tsl';\nconst c = directionToColor(n).mul(PI2);\n" },
      want: ["import { packNormalToRGB, TWO_PI } from 'three/tsl';", "packNormalToRGB(n).mul(TWO_PI)"],
    },
    {
      rule: "shader-include-unknown",
      // a shader module without a three import is fixed too
      files: { "shader.js": "export const frag = `void main() {\n  gl_FragColor = vec4(1.0);\n  #include <encodings_fragment>\n}`;\n", "a.js": `${T}new THREE.Scene();\n` },
      file: "shader.js",
      want: ["#include <colorspace_fragment>"],
    },
  ];
  for (const c of cases) {
    it(c.rule, () => {
      const dir = project(c.files);
      const before = ids(reviewFiles(c.files));
      expect(before, "the rule fires first").toContain(c.rule);
      fix({ path: dir, three: THREE_DIR, write: true, only: [c.rule] });
      const out = readFileSync(join(dir, c.file ?? "a.js"), "utf8");
      for (const w of c.want) expect(out).toContain(w);
      const after: Record<string, string> = {};
      for (const name of Object.keys(c.files)) after[name] = readFileSync(join(dir, name), "utf8");
      expect(ids(reviewFiles(after))).not.toContain(c.rule);
    });
  }

  it("leaves a chunk the project registers itself alone", () => {
    const src = `import * as THREE from 'three';\nTHREE.ShaderChunk.output_fragment = 'gl_FragColor = vec4(1.0);';\nconst f = \`void main() {\n  gl_FragColor = vec4(1.0);\n  #include <output_fragment>\n}\`;\n`;
    expect(fix({ path: project({ "a.js": src }), three: THREE_DIR }).total).toBe(0);
  });
});
