/**
 * The page side of play, perf and leaks. Runs before any page script, after INSPECT_INIT (it reads the scenes and
 * renderers that hook keeps), and installs:
 *
 * - `window.__threesmith`: the live `scene`, `renderer`, `camera` and `info`, `$(name)` (getObjectByName over the
 *   scenes) and `$$(nameOrTest)` (all matching objects), so watch expressions and claims stay short;
 * - a frame recorder: requestAnimationFrame is wrapped, each frame's interval (wall time between frame starts), script time inside the callbacks,
 *   draw calls and triangles of its render() calls, and the program/geometry/texture counts are recorded while on;
 * - a dispose tracker: three registers a 'dispose' listener on a geometry, texture, material or render target when it
 *   first reaches the GPU. Those objects are kept by WeakRef with their type until they dispatch 'dispose', so a
 *   leak can be named by type ("BoxGeometry", "Texture robot.png") without keeping anything alive.
 */
export const RUN_INIT = `(() => {
  const w = window;
  const run = (w.__tsRun = { frame: 0, lastT: -1, lastNow: -1, cpu: 0, calls: 0, tris: 0, rec: null, tick: null, tickErr: null, nextId: 1, tracked: new Map(), ids: new WeakMap(), patched: false });
  const ts = () => w.__tsScene || { scenes: [], renderers: [], last: null };
  const deref = (list) => { for (const r of list) { const o = r && (r.deref ? r.deref() : r); if (o) return o; } return null; };
  const api = {
    get scene() { const t = ts(); return (t.last && t.last.scene) || deref(t.scenes); },
    get renderer() { const t = ts(); return (t.last && t.last.renderer) || deref(t.renderers); },
    get camera() {
      const t = ts();
      if (t.last && t.last.camera) return t.last.camera;
      let cam = null; const s = api.scene; if (s) s.traverse((o) => { if (!cam && o.isCamera) cam = o; });
      return cam;
    },
    get info() { const r = api.renderer; return r ? r.info : null; },
    scenes() { const out = []; const t = ts(); const cur = api.scene; if (cur) out.push(cur); for (const r of t.scenes) { const s = r && (r.deref ? r.deref() : r); if (s && s !== cur) out.push(s); } return out; },
    $(name) { for (const s of api.scenes()) { const o = s.getObjectByName(name); if (o) return o; } return undefined; },
    $$(test) {
      const out = []; const s = api.scene; if (!s) return out;
      const f = typeof test === 'function' ? test : typeof test === 'string' ? (o) => o.name === test || o.type === test : () => true;
      s.traverse((o) => { if (f(o)) out.push(o); });
      return out;
    },
    fns: new Map(),
    /** Compiles a watch expression or a step's code once: an expression, else a function body. */
    fn(js) {
      let f = api.fns.get(js);
      if (f) return f;
      const params = ['scene', 'renderer', 'camera', '$', '$$', 'info', '__threesmith'];
      try { f = new Function(...params, 'return (' + js + '\\n);'); }
      catch (e) { f = new Function(...params, js); }
      api.fns.set(js, f);
      return f;
    },
    call(js) { return api.fn(js)(api.scene, api.renderer, api.camera, api.$, api.$$, api.info, api); },
    /** A value as JSON for the report: numbers to 3 decimals, vectors as arrays, objects by type and name. */
    value(v, depth) {
      depth = depth || 0;
      const r = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n === null ? null : String(n));
      if (v === undefined) return 'undefined';
      if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
      if (typeof v === 'number') return r(v);
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'function') return 'function';
      if (typeof v !== 'object') return String(v);
      if (v.isColor) return '#' + v.getHexString();
      if (v.isVector2) return [r(v.x), r(v.y)];
      if (v.isVector3 || v.isEuler) return [r(v.x), r(v.y), r(v.z)];
      if (v.isVector4 || v.isQuaternion) return [r(v.x), r(v.y), r(v.z), r(v.w)];
      if (v.isMatrix4 || v.isMatrix3) return Array.from(v.elements, r);
      if (v.isObject3D) return v.type + (v.name ? ' "' + v.name + '"' : '');
      if (v.isMaterial || v.isBufferGeometry) return v.type + (v.name ? ' "' + v.name + '"' : '');
      if (v.isTexture) return 'Texture' + (v.name ? ' "' + v.name + '"' : '');
      if (ArrayBuffer.isView(v)) return Array.from(v.slice(0, 16), r);
      if (depth > 2) return Array.isArray(v) ? 'Array(' + v.length + ')' : 'Object';
      if (Array.isArray(v)) return v.slice(0, 20).map((x) => api.value(x, depth + 1)).concat(v.length > 20 ? ['+' + (v.length - 20) + ' more'] : []);
      const out = {}; let n = 0;
      for (const k of Object.keys(v)) { if (n++ >= 20) { out['…'] = '+' + (Object.keys(v).length - 20) + ' keys'; break; } out[k] = api.value(v[k], depth + 1); }
      return out;
    },
    /** Evaluates one expression: its value, or the error it threw. */
    read(js) { try { return { v: api.value(api.call(js)) }; } catch (e) { return { e: String((e && e.message) || e) }; } },
  };
  w.__threesmith = api;

  // The interval is wall time between the starts of two frames: rAF timestamps in headless Chromium stay on the
  // 60 Hz grid even when a frame ran long, so they would hide the slow frames.
  const frameEnd = (now) => {
    const rec = run.rec;
    if (rec && run.lastNow >= 0) {
      const r = api.renderer;
      const info = r && r.info;
      const manual = info && info.autoReset === false;
      rec.push([
        Math.round((now - run.lastNow) * 100) / 100,
        Math.round(run.cpu * 100) / 100,
        manual ? (info.render.calls || 0) : run.calls,
        manual ? (info.render.triangles || 0) : run.tris,
        info && info.programs ? info.programs.length : 0,
        info && info.memory ? info.memory.geometries : 0,
        info && info.memory ? info.memory.textures : 0,
      ]);
    }
    run.cpu = 0; run.calls = 0; run.tris = 0;
  };
  const raf = w.requestAnimationFrame.bind(w);
  w.requestAnimationFrame = (cb) => raf((t) => {
    if (t !== run.lastT) {
      const now = performance.now();
      frameEnd(now);
      run.lastT = t;
      run.lastNow = now;
      run.frame++;
      if (run.tick) { try { run.tick(); } catch (e) { run.tickErr = String(e); } }
    }
    const s = performance.now();
    try { return cb(t); } finally { run.cpu += performance.now() - s; }
  });

  const kindOf = (o) => o.isBufferGeometry ? 'geometry' : o.isTexture ? 'texture' : (o.isWebGLRenderTarget || o.isRenderTarget) ? 'target' : o.isMaterial ? 'material' : null;
  const texType = (o) => {
    const t = o.isVideoTexture ? 'VideoTexture' : o.isCanvasTexture ? 'CanvasTexture' : o.isCubeTexture ? 'CubeTexture' : o.isCompressedTexture ? 'CompressedTexture' : o.isDataTexture ? 'DataTexture' : o.isDepthTexture ? 'DepthTexture' : o.isFramebufferTexture ? 'FramebufferTexture' : 'Texture';
    const img = o.image;
    const src = img && (img.currentSrc || img.src);
    const file = typeof src === 'string' && !src.startsWith('data:') ? src.split(/[?#]/)[0].split('/').pop() : '';
    return t + (o.name ? ' "' + o.name + '"' : file ? ' ' + file : '');
  };
  const typeOf = (o, kind) => kind === 'texture' ? texType(o) : kind === 'target' ? 'RenderTarget ' + o.width + 'x' + o.height : (o.type || kind) + (o.name ? ' "' + o.name + '"' : '');
  const patch = (obj) => {
    if (run.patched) return;
    let p = Object.getPrototypeOf(obj);
    while (p && !Object.prototype.hasOwnProperty.call(p, 'addEventListener')) p = Object.getPrototypeOf(p);
    if (!p || !Object.prototype.hasOwnProperty.call(p, 'dispatchEvent')) return;
    run.patched = true;
    const add = p.addEventListener;
    const dispatch = p.dispatchEvent;
    p.addEventListener = function (type, listener) {
      if (type === 'dispose' && !run.ids.has(this)) {
        const kind = kindOf(this);
        if (kind) {
          const id = run.nextId++;
          run.ids.set(this, id);
          run.tracked.set(id, { kind, type: typeOf(this, kind), ref: new WeakRef(this) });
        }
      }
      return add.apply(this, arguments);
    };
    p.dispatchEvent = function (event) {
      if (event && event.type === 'dispose') {
        const id = run.ids.get(this);
        if (id !== undefined) { run.tracked.delete(id); run.ids.delete(this); }
      }
      return dispatch.apply(this, arguments);
    };
  };
  if (typeof w.__THREE_DEVTOOLS__ === 'undefined') w.__THREE_DEVTOOLS__ = new EventTarget();
  w.__THREE_DEVTOOLS__.addEventListener('observe', (e) => {
    const o = e.detail;
    if (!o) return;
    if (o.isScene) patch(o);
    else if (o.isWebGLRenderer || o.isRenderer) {
      const render = o.render;
      if (typeof render !== 'function') return;
      o.render = function () {
        const out = render.apply(this, arguments);
        const i = o.info && o.info.render;
        if (i && o.info.autoReset !== false) { run.calls += i.calls || 0; run.tris += i.triangles || 0; }
        return out;
      };
    }
  });
})();`;

/** One recorded frame: interval ms, script ms, draw calls, triangles, programs, geometries, textures. */
export type FrameRecord = [dt: number, cpu: number, calls: number, triangles: number, programs: number, geometries: number, textures: number];

/** What the page holds right now: GPU resource counts, scene objects by type, resources uploaded and never disposed. */
export interface MemorySnapshot {
  geometries: number;
  textures: number;
  programs: number;
  /** Objects in the scene being rendered. */
  objects: number;
  /** Scenes still reachable (after a garbage collection they are the ones something keeps). */
  scenes: number;
  /** Scene objects by type ("Mesh", "Group"). */
  byType: Record<string, number>;
  /** Geometries, textures, materials and render targets that reached the GPU and were never disposed, by type. */
  undisposed: Record<string, number>;
  /** How many of those are no longer reachable from JS: their GPU memory can never be freed. */
  unreachable: number;
  /** JS heap in use, bytes (CDP), when known. */
  heap?: number;
}

/** Evaluated in the page; returns a MemorySnapshot without heap. */
export const SNAPSHOT_EVAL = `(() => {
  const api = window.__threesmith, run = window.__tsRun;
  const r = api && api.renderer;
  const info = r && r.info;
  const out = { geometries: 0, textures: 0, programs: 0, objects: 0, scenes: 0, byType: {}, undisposed: {}, unreachable: 0 };
  if (info) { out.geometries = info.memory.geometries || 0; out.textures = info.memory.textures || 0; out.programs = info.programs ? info.programs.length : 0; }
  if (api) {
    out.scenes = api.scenes().length;
    const s = api.scene;
    if (s) s.traverse((o) => { out.objects++; out.byType[o.type] = (out.byType[o.type] || 0) + 1; });
  }
  if (run) for (const t of run.tracked.values()) {
    const key = t.kind === 'material' || t.kind === 'geometry' || t.kind === 'texture' || t.kind === 'target' ? t.type : t.kind;
    out.undisposed[key] = (out.undisposed[key] || 0) + 1;
    if (!t.ref.deref()) out.unreachable++;
  }
  return out;
})()`;
