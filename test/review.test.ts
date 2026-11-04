import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatMarkdown, formatText } from "../src/review/format.js";
import { gradeOf, penaltyOf, score } from "../src/review/review.js";
import { stripComments } from "../src/review/source.js";
import { ids, reviewFiles } from "./helpers.js";
import { CASES } from "./rules.cases.js";
import { RULES } from "../src/review/rules.js";

const modern = readFileSync("test/fixtures/modern.js", "utf8");
const legacy = readFileSync("test/fixtures/legacy.js", "utf8");

describe("review", () => {
  it("passes modern code cleanly", () => {
    const r = reviewFiles({ "main.js": modern });
    expect(r.findings.map((f) => `${f.rule}:${f.line}`)).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.grade).toBe("A+");
  });

  it("catches outdated and broken code", () => {
    const r = reviewFiles({ "main.js": legacy });
    const got = new Set(ids(r));
    for (const id of [
      "output-encoding",
      "texture-encoding",
      "buffer-geometry-alias",
      "geometry-class",
      "three-math",
      "camera-near-zero",
      "shadows-not-enabled",
      "pixel-ratio-uncapped",
      "alloc-in-loop",
      "create-heavy-in-loop",
      "traverse-in-loop",
      "apply-matrix",
      "addons-path",
      "unknown-symbol",
      "no-resize-handling",
      "animation-loop",
    ]) {
      expect(got, `missing ${id}`).toContain(id);
    }
    expect(r.score!).toBeLessThan(60);
    expect(r.counts.error).toBeGreaterThan(3);
  });

  it("reports renderer.outputEncoding = sRGBEncoding once, not also as a texture encoding", () => {
    const r = reviewFiles({ "a.js": "import * as THREE from 'three';\nrenderer.outputEncoding = THREE.sRGBEncoding;\ntex.encoding = THREE.sRGBEncoding;\n" });
    expect(r.findings.filter((f) => f.line === 2).map((f) => f.rule)).toEqual(["output-encoding"]);
    expect(r.findings.filter((f) => f.line === 3).map((f) => f.rule)).toEqual(["texture-encoding"]);
  });

  it("explains unknown symbols with a suggestion and the right import path", () => {
    const r = reviewFiles({ "main.js": legacy });
    const msgs = r.findings.filter((f) => f.rule === "unknown-symbol").map((f) => f.message + (f.fix ?? ""));
    expect(msgs.join("\n")).toContain("WebGLRenderer");
    expect(msgs.join("\n")).toContain("three/addons/controls/OrbitControls.js");
    expect(msgs.join("\n")).toContain("three/webgpu");
  });

  it("knows a typo'd addon path does not exist", () => {
    const r = reviewFiles({ "a.js": "import * as THREE from 'three';\nimport { X } from 'three/addons/controls/NoSuchControls.js';\nnew THREE.Scene();\n" });
    expect(ids(r)).toContain("unknown-symbol");
  });

  it("gates rules by the pinned version", () => {
    const src = "import * as THREE from 'three';\nconst r = new THREE.WebGLRenderer();\nr.outputEncoding = THREE.sRGBEncoding;\n";
    const pinned = reviewFiles({ "a.js": src });
    expect(pinned.findings.find((f) => f.rule === "output-encoding")?.severity).toBe("error");
  });

  it("ignores comments", () => {
    const r = reviewFiles({ "a.js": "import * as THREE from 'three';\n// renderer.outputEncoding = THREE.sRGBEncoding\n/* new THREE.Geometry() */\nnew THREE.Scene();\n" });
    expect(ids(r)).not.toContain("output-encoding");
    expect(ids(r)).not.toContain("geometry-class");
  });

  it("flags code in html script tags and unpinned CDN", () => {
    const html = `<script type="importmap">{"imports":{"three":"https://unpkg.com/three/build/three.module.js"}}</script>\n<script type="module">import * as THREE from 'three'; const s = new THREE.Scene();</script>`;
    expect(ids(reviewFiles({ "index.html": html }))).toContain("cdn-unpinned");
  });

  it("does not run on projects without three", () => {
    const r = reviewFiles({ "a.js": "console.log(1)" });
    expect(r.score).toBeNull();
    expect(formatText(r)).toContain("No three.js code");
  });

  it("disables rules", () => {
    const r = reviewFiles({ "main.js": legacy }, { disable: ["apply-matrix"] });
    expect(ids(r)).not.toContain("apply-matrix");
  });

  it("flags mismatched @types/three", () => {
    const r = reviewFiles({ "package.json": JSON.stringify({ dependencies: { three: "^0.187.0", "@types/three": "^0.170.0" } }), "a.js": modern });
    expect(ids(r)).toContain("types-mismatch");
  });

  it("formats text and markdown", () => {
    const r = reviewFiles({ "main.js": legacy });
    expect(formatText(r)).toContain("/100");
    expect(formatMarkdown(r)).toContain("### Threesmith review");
  });
});

describe("rules: each fires and has a quiet twin", () => {
  for (const c of CASES) {
    it(c.id, () => {
      expect(ids(reviewFiles(c.fire)), "fires").toContain(c.id);
      expect(ids(reviewFiles(c.quiet)), "stays quiet").not.toContain(c.id);
    });
  }
  it("every case names a real rule, ids are unique", () => {
    const known = new Set(RULES.map((r) => r.id));
    expect(known.size).toBe(RULES.length);
    for (const c of CASES) expect(known, c.id).toContain(c.id);
  });
});

describe("scoring", () => {
  it("is monotonic and bounded", () => {
    expect(penaltyOf("error", 1)).toBeLessThan(penaltyOf("error", 3));
    expect(penaltyOf("error", 50)).toBe(penaltyOf("error", 5));
    expect(score([]).total).toBe(100);
    expect(gradeOf(100)).toBe("A+");
    expect(gradeOf(40)).toBe("F");
  });
  it("strips comments but keeps offsets", () => {
    const s = "a // x\nb /* y\nz */ c";
    expect(stripComments(s)).toHaveLength(s.length);
    expect(stripComments(s)).not.toContain("x");
  });
});

describe("no false alarms on three's own addons", () => {
  it("finds no unknown symbols across examples/jsm", async () => {
    const { review } = await import("../src/review/review.js");
    const r = review({ path: "node_modules/three/examples/jsm" });
    expect(r.threeFiles).toBeGreaterThan(100);
    expect(r.findings.filter((f) => f.rule === "unknown-symbol")).toEqual([]);
  });
});

describe("html scripts", () => {
  it("reads a module script whose end tag has other capitals or a space", () => {
    const r = reviewFiles({ "index.html": `<script type="module">import * as THREE from 'three';</SCRIPT >` });
    expect(ids(r)).toContain("importmap-missing");
  });
});
