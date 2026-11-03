/**
 * Scene inspection inside the page. three.js announces every Scene and WebGLRenderer it creates to
 * `__THREE_DEVTOOLS__` (the hook of the three.js devtools extension). We provide that hook before the page loads,
 * wrap each renderer's render() to learn which scene and camera it draws, and then read the live objects: the graph,
 * the camera, renderer.info, and why something is not visible.
 */

/** Runs before any page script. Keeps the scenes and renderers three announces. */
export const INSPECT_INIT = `(() => {
  const w = window;
  const ts = (w.__tsScene = { scenes: [], renderers: [], last: null, renders: 0 });
  if (typeof w.__THREE_DEVTOOLS__ === 'undefined') w.__THREE_DEVTOOLS__ = new EventTarget();
  w.__THREE_DEVTOOLS__.addEventListener('observe', (e) => {
    const o = e.detail;
    if (!o) return;
    if (o.isScene) ts.scenes.push(o);
    else if (o.isWebGLRenderer || o.isRenderer) {
      ts.renderers.push(o);
      const render = o.render;
      if (typeof render === 'function') {
        o.render = function (scene, camera) {
          ts.last = { scene, camera, renderer: o };
          ts.renders++;
          return render.apply(this, arguments);
        };
      }
    }
  });
})();`;

export interface SceneNode {
  depth: number;
  type: string;
  name: string;
  visible: boolean;
  position: [number, number, number];
  scale: [number, number, number];
  children: number;
  geometry?: string;
  vertices?: number;
  material?: string;
  light?: string;
}

export interface SceneDiagnosis {
  severity: "error" | "warn" | "info";
  kind: string;
  /** Path of the object, like Scene > car > wheel_fl. */
  object?: string;
  message: string;
  fix: string;
}

export interface SceneReport {
  found: boolean;
  renderer: null | {
    type: string;
    canvas: [number, number];
    pixelRatio: number;
    outputColorSpace?: string;
    toneMapping?: number;
    shadows?: boolean;
    calls: number;
    triangles: number;
    geometries: number;
    textures: number;
    programs: number;
  };
  camera: null | {
    type: string;
    name: string;
    position: [number, number, number];
    near: number;
    far: number;
    fov?: number;
    aspect?: number;
  };
  counts: { objects: number; meshes: number; lights: number; nodesShown: number };
  nodes: SceneNode[];
  diagnoses: SceneDiagnosis[];
  /** renderer.info.memory sampled twice, to see if it keeps growing. */
  memory?: { before: { geometries: number; textures: number }; after: { geometries: number; textures: number }; ms: number };
}

/** Evaluated in the page; returns a SceneReport. */
export const INSPECT_EVAL = `(() => {
  const ts = window.__tsScene;
  const r3 = (v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000);
  const report = { found: false, renderer: null, camera: null, counts: { objects: 0, meshes: 0, lights: 0, nodesShown: 0 }, nodes: [], diagnoses: [] };
  if (!ts) return report;
  const last = ts.last;
  const scene = (last && last.scene) || ts.scenes[0];
  if (!scene) return report;
  report.found = true;
  const renderer = (last && last.renderer) || ts.renderers[0] || null;
  let camera = last && last.camera;
  if (!camera) scene.traverse((o) => { if (!camera && o.isCamera) camera = o; });
  const diag = (severity, kind, object, message, fix) => report.diagnoses.push({ severity, kind, object, message, fix });

  if (renderer) {
    const info = renderer.info || {};
    const c = renderer.domElement || {};
    report.renderer = {
      type: renderer.isWebGLRenderer ? 'WebGLRenderer' : (renderer.constructor && renderer.constructor.name) || 'Renderer',
      canvas: [c.width || 0, c.height || 0],
      pixelRatio: renderer.getPixelRatio ? renderer.getPixelRatio() : 1,
      outputColorSpace: renderer.outputColorSpace,
      toneMapping: renderer.toneMapping,
      shadows: renderer.shadowMap ? !!renderer.shadowMap.enabled : undefined,
      calls: (info.render && info.render.calls) || 0,
      triangles: (info.render && info.render.triangles) || 0,
      geometries: (info.memory && info.memory.geometries) || 0,
      textures: (info.memory && info.memory.textures) || 0,
      programs: (info.programs && info.programs.length) || 0,
    };
    if (!c.width || !c.height) diag('error', 'canvas-zero', null, 'The renderer canvas is ' + c.width + 'x' + c.height + ' pixels.', 'Call renderer.setSize(width, height) with the size of its container (and make sure the container has a height in CSS).');
    if (!ts.renders && renderer.isWebGLRenderer) diag('error', 'never-rendered', null, 'The renderer exists but render() was never called.', 'Call renderer.render(scene, camera) every frame, for example in renderer.setAnimationLoop(...).');
    if (report.renderer.calls > 1000) diag('warn', 'draw-calls', null, report.renderer.calls + ' draw calls per frame.', 'Merge static meshes (BufferGeometryUtils.mergeGeometries) or use InstancedMesh / BatchedMesh for repeated objects.');
    if (report.renderer.triangles > 5e6) diag('warn', 'triangles', null, (report.renderer.triangles / 1e6).toFixed(1) + 'M triangles per frame.', 'Use LOD, simplify meshes (SimplifyModifier, meshopt) or cull what is far away.');
  }

  if (camera) {
    report.camera = { type: camera.type, name: camera.name || '', position: r3(camera.getWorldPosition ? camera.getWorldPosition(camera.position.clone()) : camera.position), near: camera.near, far: camera.far, fov: camera.fov, aspect: camera.aspect };
    if (camera.isPerspectiveCamera) {
      if (!(camera.near > 0)) diag('error', 'camera-near', null, 'camera.near is ' + camera.near + '.', 'Use a small positive near such as 0.1.');
      if (camera.far / camera.near > 1e6) diag('warn', 'depth-range', null, 'far/near is ' + Math.round(camera.far / camera.near) + '; distant surfaces will flicker (z-fighting).', 'Raise near (0.1 or more) or lower far, or use logarithmicDepthBuffer: true.');
      const c = renderer && renderer.domElement;
      if (c && c.clientWidth && c.clientHeight) {
        const real = c.clientWidth / c.clientHeight;
        if (Math.abs(real - camera.aspect) / real > 0.02) diag('warn', 'aspect', null, 'camera.aspect is ' + camera.aspect.toFixed(3) + ' but the canvas is ' + real.toFixed(3) + ': the picture is stretched.', 'Set camera.aspect = width / height and call camera.updateProjectionMatrix() after every resize.');
      }
    }
  } else diag('error', 'no-camera', null, 'No camera was found for the scene.', 'Create a PerspectiveCamera and pass it to renderer.render(scene, camera).');

  const pathOf = (o) => { const p = []; let x = o; while (x) { p.unshift(x.name || x.type); x = x.parent; } return p.join(' > '); };
  const effectiveVisible = (o) => { let x = o; while (x) { if (!x.visible) return false; x = x.parent; } return true; };
  let lights = 0, env = !!scene.environment, lit = 0;
  const camPos = camera && camera.getWorldPosition ? camera.getWorldPosition(camera.position.clone()) : null;
  if (camera && camera.updateMatrixWorld) camera.updateMatrixWorld();
  scene.updateMatrixWorld && scene.updateMatrixWorld();
  const LIMIT = 400;
  let drawables = 0, visibleDrawables = 0;
  const walk = (o, depth) => {
    report.counts.objects++;
    if (o.isLight) { lights++; report.counts.lights++; }
    const isDrawable = o.isMesh || o.isPoints || o.isLine || o.isSprite;
    if (report.nodes.length < LIMIT) {
      const n = { depth, type: o.type, name: o.name || '', visible: o.visible, position: r3(o.position), scale: r3(o.scale), children: o.children.length };
      if (o.geometry) { n.geometry = o.geometry.type; const p = o.geometry.attributes && o.geometry.attributes.position; n.vertices = p ? p.count : 0; }
      if (o.material) { const m = Array.isArray(o.material) ? o.material[0] : o.material; n.material = (Array.isArray(o.material) ? o.material.length + 'x ' : '') + (m ? m.type : '?'); }
      if (o.isLight) n.light = 'intensity ' + o.intensity + (o.castShadow ? ' shadows' : '');
      report.nodes.push(n);
    }
    if (isDrawable) {
      drawables++;
      if (o.isMesh) report.counts.meshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m && /Standard|Physical|Lambert|Phong|Toon/.test(m.type))) lit++;
      const path = pathOf(o);
      let seen = true;
      if (!effectiveVisible(o)) seen = false;
      else if (camera && o.layers && camera.layers && !o.layers.test(camera.layers)) { seen = false; diag('warn', 'layers', path, 'The object is on a layer the camera does not render.', 'object.layers.enable(0) or camera.layers.enable(<layer>).'); }
      else if (mats.every((m) => m && (m.visible === false || (m.transparent && m.opacity === 0)))) { seen = false; diag('warn', 'invisible-material', path, 'Its material is invisible (visible = false or opacity 0).', 'Set material.opacity > 0 / material.visible = true.'); }
      else if (o.geometry) {
        const pos = o.geometry.attributes && o.geometry.attributes.position;
        if (!pos || pos.count === 0) { seen = false; diag('warn', 'empty-geometry', path, 'Its geometry has no vertices.', 'Fill the position attribute (setAttribute(\\'position\\', ...)) or check the loader result.'); }
        else if (camera && camPos) {
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const bs = o.geometry.boundingSphere;
          if (!bs || !isFinite(bs.radius)) { seen = false; diag('error', 'nan-geometry', path, 'Its vertex positions contain NaN.', 'Check the code that fills the position attribute.'); }
          else {
            // read the scale from the world matrix columns: decompose() resets a degenerate (zero) scale to 1
            const e = o.matrixWorld.elements;
            const maxScale = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
            const center = bs.center.clone().applyMatrix4(o.matrixWorld);
            const radius = bs.radius * maxScale;
            if (maxScale === 0) { seen = false; diag('warn', 'zero-scale', path, 'Its scale is 0.', 'Set a non-zero scale.'); }
            else if (!isFinite(center.x + center.y + center.z)) { seen = false; diag('error', 'nan-transform', path, 'Its world position is NaN.', 'A NaN reached position/rotation/scale: check the values you set every frame.'); }
            else if (camera.isPerspectiveCamera) {
              const v = center.clone().applyMatrix4(camera.matrixWorldInverse);
              const depthToCenter = -v.z;
              const dist = center.distanceTo(camPos);
              if (dist < radius * 0.9 && radius > 0) diag('warn', 'camera-inside', path, 'The camera is inside this object (distance ' + dist.toFixed(2) + ', radius ' + radius.toFixed(2) + '); with FrontSide you see nothing of it.', 'Move the camera back: camera.position.set(...) and camera.lookAt(object.position).');
              else if (depthToCenter + radius < camera.near) { seen = false; diag('warn', 'behind-camera', path, 'The object is behind the camera (or closer than near).', 'Point the camera at it: camera.lookAt(' + r3(center).join(', ') + ').'); }
              else if (depthToCenter - radius > camera.far) { seen = false; diag('warn', 'beyond-far', path, 'The object is farther than camera.far (' + camera.far + ').', 'Raise camera.far (and call updateProjectionMatrix) or move the object closer.'); }
              else {
                const t = Math.tan((camera.fov * Math.PI) / 360);
                const ndc = center.clone().project(camera);
                const ry = radius / (Math.max(depthToCenter, 1e-6) * t);
                const rx = ry / (camera.aspect || 1);
                if (ndc.x - rx > 1 || ndc.x + rx < -1 || ndc.y - ry > 1 || ndc.y + ry < -1) { seen = false; diag('warn', 'off-screen', path, 'The object is outside the camera view (at ' + r3(center).join(', ') + ').', 'Aim the camera at it with camera.lookAt(...) or move it into view.'); }
                else {
                  const h = renderer && renderer.domElement ? renderer.domElement.clientHeight || renderer.domElement.height : 600;
                  const px = ry * h;
                  if (px < 1.5) diag('info', 'tiny', path, 'The object is about ' + px.toFixed(1) + ' px tall on screen.', 'Move the camera closer or scale the object (units: three.js uses meters by convention).');
                }
              }
            }
          }
        }
      }
      if (seen) visibleDrawables++;
    }
    for (const c of o.children) walk(c, depth + 1);
  };
  walk(scene, 0);
  report.counts.nodesShown = report.nodes.length;
  if (lit && !lights && !env) diag('error', 'no-light', null, lit + ' object(s) use a lit material but the scene has no light and no environment: they render black.', 'Add new THREE.AmbientLight(0xffffff, 1) and a DirectionalLight, or set scene.environment (RoomEnvironment + PMREMGenerator).');
  if (drawables === 0) diag('error', 'empty-scene', null, 'The rendered scene has no meshes, points, lines or sprites.', 'Add your objects with scene.add(object) (for loaded models: scene.add(gltf.scene) inside the load callback).');
  else if (visibleDrawables === 0) diag('error', 'nothing-visible', null, 'None of the ' + drawables + ' drawable objects can be seen from the camera.', 'See the reasons per object above.');
  const shadowCasters = []; scene.traverse((o) => { if (o.castShadow && (o.isMesh)) shadowCasters.push(o); });
  if (renderer && renderer.shadowMap && !renderer.shadowMap.enabled && shadowCasters.length) diag('warn', 'shadows-off', null, shadowCasters.length + ' mesh(es) cast shadows but renderer.shadowMap.enabled is false.', 'renderer.shadowMap.enabled = true.');
  if (renderer && renderer.shadowMap && renderer.shadowMap.enabled && shadowCasters.length) {
    let lightCasts = false; scene.traverse((o) => { if (o.isLight && o.castShadow) lightCasts = true; });
    if (!lightCasts) diag('warn', 'no-shadow-light', null, 'Meshes cast shadows but no light has castShadow = true.', 'Set castShadow = true on a DirectionalLight, SpotLight or PointLight.');
  }
  return report;
})()`;

export const MEMORY_EVAL = `(() => {
  const ts = window.__tsScene;
  const r = ts && ((ts.last && ts.last.renderer) || ts.renderers[0]);
  const m = r && r.info && r.info.memory;
  return m ? { geometries: m.geometries || 0, textures: m.textures || 0 } : null;
})()`;

export function formatScene(r: SceneReport, opts: { maxNodes?: number } = {}): string {
  if (!r.found) {
    return "No three.js scene was found on the page (three announces scenes to the devtools hook; this needs three r1xx or newer, loaded as a module on this page).";
  }
  const out: string[] = [];
  if (r.diagnoses.length) {
    out.push("Why it may not look right:");
    for (const d of r.diagnoses) out.push(`${d.severity === "error" ? "✖" : d.severity === "warn" ? "▲" : "·"} [${d.kind}]${d.object ? ` ${d.object}:` : ""} ${d.message}\n    fix: ${d.fix}`);
  } else out.push("No visibility problems found.");
  if (r.renderer) {
    const x = r.renderer;
    out.push("", `${x.type}: canvas ${x.canvas[0]}x${x.canvas[1]} @${x.pixelRatio}, ${x.calls} draw calls, ${x.triangles} triangles, ${x.geometries} geometries, ${x.textures} textures, ${x.programs} shader programs${x.shadows ? ", shadows on" : ""}`);
  }
  if (r.memory) {
    const g = r.memory.after.geometries - r.memory.before.geometries;
    const t = r.memory.after.textures - r.memory.before.textures;
    out.push(`GPU memory over ${r.memory.ms} ms: geometries ${r.memory.before.geometries} -> ${r.memory.after.geometries}, textures ${r.memory.before.textures} -> ${r.memory.after.textures}${g > 0 || t > 0 ? "  (growing: see leak)" : ""}`);
  }
  if (r.camera) {
    const c = r.camera;
    out.push(`${c.type}${c.name ? ` "${c.name}"` : ""} at (${c.position.join(", ")}), near ${c.near}, far ${c.far}${c.fov ? `, fov ${c.fov}` : ""}${c.aspect ? `, aspect ${c.aspect.toFixed(3)}` : ""}`);
  }
  out.push("", `Scene graph (${r.counts.objects} objects, ${r.counts.meshes} meshes, ${r.counts.lights} lights):`);
  const max = opts.maxNodes ?? 80;
  for (const n of r.nodes.slice(0, max)) {
    const bits = [n.type + (n.name ? ` "${n.name}"` : "")];
    if (n.geometry) bits.push(`${n.geometry} ${n.vertices}v`);
    if (n.material) bits.push(n.material);
    if (n.light) bits.push(n.light);
    if (n.position.some((v) => v !== 0)) bits.push(`at (${n.position.join(", ")})`);
    if (n.scale.some((v) => v !== 1)) bits.push(`scale (${n.scale.join(", ")})`);
    if (!n.visible) bits.push("HIDDEN");
    out.push(`${"  ".repeat(n.depth)}${bits.join(" · ")}`);
  }
  if (r.nodes.length > max) out.push(`… ${r.nodes.length - max} more nodes${r.counts.objects > r.nodes.length ? ` (${r.counts.objects} in total)` : ""}`);
  return out.join("\n");
}
