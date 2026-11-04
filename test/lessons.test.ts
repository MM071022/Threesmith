import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { placeholderShare, scrubText } from "../src/lessons/anonymize.js";
import { formatLesson, formatLessonList } from "../src/lessons/format.js";
import { lessonHintsForMessages, lessonHintsForRules, MAX_HINTS } from "../src/lessons/hints.js";
import { bundledLessons, lessonsFile, parseLessons } from "../src/lessons/library.js";
import { addLocalLesson, errorTemplate, LessonError, listLocal, localFile, readLocal, recordLessonFeedback, removeLocalLesson } from "../src/lessons/local.js";
import { findLesson, lessonsForError, lessonsForRule, QUIET_AFTER_WRONG, searchLessons } from "../src/lessons/search.js";
import { LESSON_TOPICS } from "../src/lessons/types.js";
import { RULES } from "../src/review/rules.js";

const home = mkdtempSync(join(tmpdir(), "threesmith-lessons-"));
const previousHome = process.env["THREESMITH_HOME"];

beforeEach(() => {
  // Every test gets an empty local file in a temp dir; the real home is never touched.
  process.env["THREESMITH_HOME"] = mkdtempSync(join(home, "h-"));
});

afterAll(() => {
  if (previousHome === undefined) delete process.env["THREESMITH_HOME"];
  else process.env["THREESMITH_HOME"] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("bundled lessons", () => {
  const lessons = bundledLessons();

  it("load from the package's data folder", () => {
    expect(lessonsFile()).toMatch(/data[\\/]lessons\.json$/);
    const raw = JSON.parse(readFileSync(lessonsFile()!, "utf8")) as { lessons: unknown[] };
    // A lesson that does not parse would be dropped silently.
    expect(lessons.length).toBe(raw.lessons.length);
    expect(lessons.length).toBeGreaterThanOrEqual(60);
  });

  it("have unique ids that start with their topic", () => {
    expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
    for (const l of lessons) {
      expect(LESSON_TOPICS, l.id).toContain(l.topic);
      expect(l.id.startsWith(`${l.topic}/`), l.id).toBe(true);
      expect(l.tags.length, l.id).toBeGreaterThan(0);
    }
  });

  it("name only review rules that exist", () => {
    const ids = new Set(RULES.map((r) => r.id));
    for (const l of lessons) for (const r of l.rules ?? []) expect(ids.has(r), `${l.id}: ${r}`).toBe(true);
  });

  it("hold nothing the anonymizer would remove: no names, paths, codes or source code", () => {
    const changed: string[] = [];
    for (const l of lessons) {
      for (const field of [l.title, l.symptom, l.cause, l.fix, l.test ?? "", ...l.tags]) {
        const out = scrubText(field).text;
        if (out !== field.trim()) changed.push(`${l.id}: ${out}`);
      }
      for (const e of l.errors ?? []) expect(e, l.id).not.toMatch(/\\|@|<\w+>|\w\/\w+\//);
    }
    expect(changed).toEqual([]);
  });

  it("only mention releases that were checked (r1xx numbers in the text)", () => {
    // Releases verified in the migration guide or in the source of three; add one here only after checking it.
    const verified = new Set([124, 125, 133, 144, 148, 151, 152, 155, 161, 163, 171, 180, 181, 182, 183, 187]);
    for (const l of lessons) {
      for (const m of `${l.title} ${l.symptom} ${l.cause} ${l.fix}`.matchAll(/\br(\d{3})\b/g)) expect(verified.has(Number(m[1])), `${l.id}: r${m[1]}`).toBe(true);
    }
  });

  it("drop entries in the wrong shape instead of failing", () => {
    expect(parseLessons({ version: 1, lessons: [{ id: "Bad Id", topic: "color" }, lessons[0], lessons[0]] })).toHaveLength(1);
    expect(parseLessons({ version: 2, lessons: [] })).toEqual([]);
    expect(parseLessons(null)).toEqual([]);
  });
});

describe("error messages", () => {
  const top = (message: string) => lessonsForError(message)[0]?.lesson.id;

  it("find the lesson for real console and build messages", () => {
    expect(top("THREE.WebGLRenderer: Context Lost.")).toBe("rendering/context-lost");
    expect(top("WARNING: Too many active WebGL contexts. Oldest context will be lost.")).toBe("rendering/context-lost");
    expect(top("Uncaught SyntaxError: The requested module 'three' does not provide an export named 'OrbitControls'")).toBe("imports/addons-not-in-core");
    expect(top("THREE.WARNING: Multiple instances of Three.js being imported.")).toBe("imports/two-copies-of-three");
    expect(top(`SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`)).toBe("loading/html-instead-of-asset");
    expect(top("Error: THREE.GLTFLoader: No DRACOLoader instance provided.")).toBe("loading/draco-loader-missing");
    expect(top("THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures")).toBe("loading/ktx2-loader-setup");
    expect(top('Uncaught TypeError: Failed to resolve module specifier "three". Relative references must start with either "/", "./", or "../".')).toBe("imports/import-map-missing");
    expect(top("Uncaught TypeError: THREE.OrbitControls is not a constructor")).toBe("imports/examples-js-removed");
    expect(top("THREE.Object3D.add: object not an instance of THREE.Object3D. Object")).toBe("models/add-gltf-not-scene");
    expect(top('Error: THREE.Renderer: .render() called before the backend is initialized. Use "await renderer.init();" before rendering.')).toBe("webgpu/init-before-render");
    expect(top("THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The \"position\" attribute is likely to have NaN values.")).toBe("models/nan-positions");
    expect(top("ReferenceError: window is not defined")).toBe("build/ssr-window");
    expect(top("Uncaught Error: R3F: Hooks can only be used within the Canvas component!")).toBe("r3f/hooks-outside-canvas");
    expect(top("TypeError: Cannot read properties of undefined (reading 'ReactCurrentOwner')")).toBe("r3f/react-version");
  });

  it("find the lesson for the real texts of browsers, bundlers, Node and React", () => {
    // Captured in headless Chromium, Node 22 / Node 18, Vite 5.4, 6.4, 7.3 and 8.3, react-dom 18.3 and fiber 8.
    const real: [string, string][] = [
      ["WebGL: CONTEXT_LOST_WEBGL: loseContext: context lost", "rendering/context-lost"],
      ["[.WebGL-0x3d4c001a3200] GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture.", "rendering/feedback-loop"],
      ["CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f @+0", "loading/decoder-path-wrong"],
      ["TypeError: Failed to execute 'compile' on 'WebAssembly': Incorrect response MIME type. Expected 'application/wasm'.", "loading/decoder-path-wrong"],
      ["SyntaxError: Unexpected token < in JSON at position 0", "loading/html-instead-of-asset"],
      ["SyntaxError: JSON.parse: unexpected character at line 1 column 1 of the JSON data", "loading/html-instead-of-asset"],
      ["Access to fetch at 'file:///app/model.glb' from origin 'null' has been blocked by CORS policy: Cross origin requests are only supported for protocol schemes: chrome, chrome-extension, chrome-untrusted, data, http, https, isolated-app.", "loading/file-protocol"],
      ["Fetch API cannot load file:///app/model.glb. URL scheme \"file\" is not supported.", "loading/file-protocol"],
      ["THREE.FileLoader: HTTP Status 0 received.", "loading/file-protocol"],
      ["Failed to load resource: net::ERR_FILE_NOT_FOUND", "loading/file-protocol"],
      ["Access to image at 'http://localhost:5402/img.png' from origin 'http://localhost:5401' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.", "loading/cross-origin-texture"],
      ["SecurityError: Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.", "loading/cross-origin-texture"],
      ["SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D': The canvas has been tainted by cross-origin data.", "loading/cross-origin-texture"],
      ["THREE.WebGLState: SecurityError: Failed to execute 'texSubImage2D' on 'WebGL2RenderingContext': The image element contains cross-origin data, and may not be loaded.", "loading/cross-origin-texture"],
      ["THREE.GLTFLoader: Couldn't load texture blob:http://localhost/1", "loading/texture-load-error"],
      ['[commonjs--resolver] Missing "./examples/js/controls/OrbitControls.js" specifier in "three" package', "imports/examples-js-removed"],
      ['Error: "./examples/js/controls/OrbitControls.js" is not exported under the conditions ["module", "browser", "development", "import"] from package /app/node_modules/three (see exports field in /app/node_modules/three/package.json)', "imports/examples-js-removed"],
      ["Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './examples/js/controls/OrbitControls.js' is not defined by \"exports\" in /app/node_modules/three/package.json imported from /app/main.js", "imports/examples-js-removed"],
      ["SyntaxError: Cannot use import statement outside a module", "imports/script-not-module"],
      ["ReferenceError: THREE is not defined", "imports/examples-js-removed"],
      ["ReferenceError: OrbitControls is not defined", "imports/addons-not-in-core"],
      ["ReferenceError: document is not defined", "build/ssr-window"],
      ["ReferenceError: self is not defined", "build/ssr-window"],
      ["No available adapters.", "webgpu/fallback-webgl"],
      ["THREE.WebGPURenderer: WebGPU is not available, running under WebGL2 backend.", "webgpu/fallback-webgl"],
      ["Error: R3F: Div is not part of the THREE namespace! Did you forget to extend? See: https://docs.pmnd.rs/react-three-fiber/api/objects#using-3rd-party-objects-declaratively", "r3f/dom-in-canvas"],
      ["Error: A component suspended while responding to synchronous input. This will cause the UI to be replaced with a loading indicator. To fix, updates that suspend should be wrapped with startTransition.", "r3f/suspense-for-loaders"],
      ["Error: Minified React error #426; visit https://reactjs.org/docs/error-decoder.html?invariant=426 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.", "r3f/suspense-for-loaders"],
    ];
    for (const [msg, id] of real) expect(top(msg), msg).toBe(id);
    expect(top("Error: Minified React error #4260; visit")).toBeUndefined();
  });

  it("rank the more specific fragment first, and find nothing for unrelated messages", () => {
    const ids = lessonsForError("Uncaught TypeError: THREE.OrbitControls is not a constructor").map((h) => h.lesson.id);
    expect(ids).toEqual(["imports/examples-js-removed", "imports/addons-not-in-core"]);
    expect(lessonsForError("everything is fine")).toEqual([]);
    expect(lessonsForError("")).toEqual([]);
  });
});

describe("rules and ids", () => {
  it("map review rules to the lessons that explain them", () => {
    expect(lessonsForRule("texture-colorspace-missing")[0]?.lesson.id).toBe("color/srgb-color-textures");
    expect(lessonsForRule("no-lights")[0]?.lesson.id).toBe("rendering/lit-material-no-light");
    expect(lessonsForRule("no-such-rule")).toEqual([]);
  });

  it("find a lesson by id", () => {
    expect(findLesson("color/srgb-color-textures")?.lesson.topic).toBe("color");
    expect(findLesson("color/nope")).toBeUndefined();
  });
});

describe("search", () => {
  const ids = (q: string, topic?: (typeof LESSON_TOPICS)[number]) => searchLessons(q, topic ? { topic } : {}).map((h) => h.lesson.id);

  it("puts the lesson people mean first", () => {
    expect(ids("textures look washed out")[0]).toBe("color/srgb-color-textures");
    expect(ids("shadow cut off directional light")[0]).toBe("shadows/directional-shadow-frustum");
    expect(ids("raycaster mouse click picks wrong object")[0]).toBe("interaction/raycast-canvas-rect");
    expect(ids("draco decoder")).toContain("loading/draco-loader-missing");
    expect(ids("model too small invisible")[0]).toBe("models/wrong-scale");
    expect(ids("useFrame setState")[0]).toBe("r3f/setstate-in-useframe");
  });

  it("filters by topic, lists all for an empty query and finds nothing for nonsense", () => {
    expect(ids("", "webgpu").length).toBe(bundledLessons().filter((l) => l.topic === "webgpu").length);
    for (const id of ids("shadow", "lighting")) expect(id.startsWith("lighting/")).toBe(true);
    expect(ids("xyzzy plugh")).toEqual([]);
  });
});

describe("anonymizer", () => {
  it("scrubs paths, e-mail addresses, links, code and project names", () => {
    const out = scrubText(
      "In /home/alice/SpaceRacer/src/ShipController.ts the call `useShipStore()` failed; const speed = getSpeed(x) did it. Mail alice@example.com or see https://example.org/x and C:\\Users\\bob\\game\\main.js",
      { projectNames: ["SpaceRacer"] },
    ).text;
    expect(out).not.toMatch(/alice|bob|SpaceRacer|ShipController|useShipStore|getSpeed|example/i);
    expect(out).toContain("<path>");
    expect(out).toContain("<email>");
    expect(out).toContain("<url>");
    expect(out).toContain("<code>");
  });

  it("keeps three's own names, package paths and plain words", () => {
    const text = "Set renderer.outputColorSpace to THREE.SRGBColorSpace and import GLTFLoader from three/addons/loaders/GLTFLoader.js.";
    expect(scrubText(text).text).toBe(text);
    expect(placeholderShare("<name> <path> word")).toBeCloseTo(2 / 3);
  });

  it("turns a message into a template without paths, positions or project names", () => {
    const t = errorTemplate("Uncaught TypeError: Cannot read properties of undefined (reading 'scene') at loadShip (http://localhost:5173/src/ShipLoader.js:12:7)");
    expect(t).toBe("Uncaught TypeError: Cannot read properties of undefined (reading 'scene')");
    expect(errorTemplate('Failed to load "/home/alice/ship.glb" for SpaceRacer', { projectNames: ["SpaceRacer"] })).not.toMatch(/alice|SpaceRacer/);
  });
});

describe("local lessons", () => {
  it("keeps a lesson scrubbed, in a private file, and finds it again", () => {
    const { lesson, replaced, updated } = addLocalLesson({
      title: "Ship model from SpaceRacer stays black under the sun light",
      symptom: "The model in /home/alice/SpaceRacer/public/ship.glb renders black; bob@example.com saw it too.",
      cause: "The glTF uses a metallic material and `const env = makeEnv()` was never called, so there was nothing to reflect.",
      fix: "Set scene.environment from a RoomEnvironment through PMREMGenerator before the first render.",
      topic: "lighting",
      tags: ["metal", "black"],
      error: "THREE.WebGLRenderer: Texture marked for update but no image data found. at /home/alice/SpaceRacer/src/main.js:10:4",
    }, { projectNames: ["SpaceRacer"] });
    expect(updated).toBe(false);
    expect(lesson.id).toMatch(/^local\//);
    const all = JSON.stringify(lesson);
    expect(all).not.toMatch(/alice|bob|SpaceRacer|makeEnv|example\.com/);
    expect(replaced["path"]).toBeGreaterThan(0);
    expect(replaced["email"]).toBe(1);
    expect(replaced["code"]).toBeGreaterThan(0);

    const file = localFile();
    expect(file.startsWith(process.env["THREESMITH_HOME"]!)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(listLocal().map((l) => l.id)).toEqual([lesson.id]);

    const local = readLocal();
    expect(lessonsForError("THREE.WebGLRenderer: Texture marked for update but no image data found.", { local })[0]?.lesson.id).toBe(lesson.id);
    expect(searchLessons("black metal ship", { local }).map((h) => h.lesson.id)).toContain(lesson.id);

    // The same title updates the lesson instead of adding another.
    expect(addLocalLesson({ title: "Ship model from SpaceRacer stays black under the sun light", fix: "Give the scene an environment map from RoomEnvironment." }, { projectNames: ["SpaceRacer"] }).updated).toBe(true);
    expect(listLocal()).toHaveLength(1);
    expect(removeLocalLesson(lesson.id)).toBe(true);
    expect(listLocal()).toEqual([]);
  });

  it("refuses a lesson that is mostly names and code", () => {
    expect(() => addLocalLesson({ title: "SpaceRacerShip ShipController", fix: "`fixShip()` in /home/alice/x.js" })).toThrow(LessonError);
    expect(() => addLocalLesson({ title: "A real title here", fix: "Do the right thing every time", topic: "nope" })).toThrow(/unknown topic/);
    expect(existsSync(localFile())).toBe(false);
  });

  it("counts feedback, ranks by it and stops offering a lesson marked wrong", () => {
    expect(() => recordLessonFeedback("color/nope", "helped")).toThrow(LessonError);
    const msg = "Uncaught TypeError: THREE.OrbitControls is not a constructor";
    expect(lessonsForError(msg, { local: readLocal() })[0]?.lesson.id).toBe("imports/examples-js-removed");
    recordLessonFeedback("imports/addons-not-in-core", "helped");
    recordLessonFeedback("imports/addons-not-in-core", "helped");
    recordLessonFeedback("imports/addons-not-in-core", "helped");
    expect(lessonsForError(msg, { local: readLocal() })[0]?.lesson.id).toBe("imports/addons-not-in-core");
    for (let i = 0; i < QUIET_AFTER_WRONG; i++) recordLessonFeedback("imports/examples-js-removed", "wrong");
    expect(lessonsForError(msg, { local: readLocal() }).map((h) => h.lesson.id)).toEqual(["imports/addons-not-in-core"]);
    expect(readLocal().stats["imports/addons-not-in-core"]).toEqual({ helped: 3, wrong: 0 });
  });

  it("reads a broken file as empty", () => {
    writeFileSync(localFile(), "{ not json");
    expect(readLocal()).toEqual({ version: 1, lessons: [], stats: {} });
  });
});

describe("format and hints", () => {
  it("prints one lesson in at most 6 lines and a list as id, title and fix", () => {
    for (const l of bundledLessons()) expect(formatLesson({ lesson: l, local: false, helped: 0, wrong: 0 }).split("\n").length, l.id).toBeLessThanOrEqual(6);
    const list = formatLessonList(searchLessons("colorspace"));
    expect(list).toContain("color/srgb-color-textures: ");
    expect(list).toContain("  fix: ");
    expect(formatLessonList([], "zzz")).toMatch(/^no lessons for "zzz"/);
  });

  it("gives at most 3 deduplicated one-liners for messages and rules", () => {
    const hints = lessonHintsForMessages([
      "THREE.WebGLRenderer: Context Lost.",
      "THREE.WebGLRenderer: Context Lost.",
      "WARNING: Too many active WebGL contexts. Oldest context will be lost.",
      "THREE.GLTFLoader: No DRACOLoader instance provided.",
      "Multiple instances of Three.js being imported.",
      "window is not defined",
    ]);
    expect(hints).toHaveLength(MAX_HINTS);
    expect(new Set(hints).size).toBe(hints.length);
    expect(hints[0]).toBe("lesson rendering/context-lost: Every new renderer takes a WebGL context, and the browser drops the oldest (three_lessons id=rendering/context-lost)");
    expect(lessonHintsForRules(["no-lights", "no-lights", "pixel-ratio-uncapped"])).toEqual([
      expect.stringMatching(/^lesson rendering\/lit-material-no-light: .* \(three_lessons id=rendering\/lit-material-no-light\)$/),
      expect.stringMatching(/^lesson performance\/pixel-ratio: /),
    ]);
    expect(lessonHintsForMessages([])).toEqual([]);
    expect(lessonHintsForRules(["unknown"])).toEqual([]);
  });
});
