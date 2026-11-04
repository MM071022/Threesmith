/**
 * One case per review rule added for shaders, loaders, modules, animation, buffers, cameras, color, deprecations and
 * React Three Fiber: files where the rule must fire, and close variants where it must stay quiet.
 */
export interface RuleCase {
  id: string;
  fire: Record<string, string>;
  quiet: Record<string, string>;
}

const T = "import * as THREE from 'three';\n";
const GL = `${T}const renderer = new THREE.WebGLRenderer();\n`;
const GPU = "import * as THREE from 'three/webgpu';\nconst renderer = new THREE.WebGPURenderer();\n";
const R3F = "import { Canvas, useFrame } from '@react-three/fiber';\nimport * as THREE from 'three';\nimport { useState, useMemo } from 'react';\n";

export const CASES: RuleCase[] = [
  // ---- shaders ----
  {
    id: "shader-include-unknown",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ fragmentShader: \`\nvoid main() {\n  gl_FragColor = vec4(1.0);\n  #include <encodings_fragment>\n}\` });\n` },
    quiet: { "a.js": `${T}THREE.ShaderChunk.my_chunk = 'float x;';\nconst m = new THREE.ShaderMaterial({ fragmentShader: \`\n#include <my_chunk>\nvoid main() {\n  gl_FragColor = vec4(1.0);\n  #include <colorspace_fragment>\n}\` });\n` },
  },
  {
    id: "shader-patch-target-missing",
    fire: { "a.js": `${T}const m = new THREE.MeshStandardMaterial();\nm.onBeforeCompile = (shader) => {\n  shader.fragmentShader = shader.fragmentShader.replace('#include <output_fragment>', 'gl_FragColor = vec4(1.0);');\n};\n` },
    quiet: { "a.js": `${T}const m = new THREE.MeshStandardMaterial();\nm.onBeforeCompile = (shader) => {\n  shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', 'gl_FragColor = vec4(1.0);');\n};\n` },
  },
  {
    id: "shader-glsl3-legacy",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, fragmentShader: \`void main() { gl_FragColor = vec4(1.0); }\` });\n` },
    quiet: { "a.js": `${T}const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, fragmentShader: \`out vec4 fragColor;\nvoid main() { fragColor = texture2D(map, vUv); }\` });\nconst n = new THREE.ShaderMaterial({ fragmentShader: \`void main() { gl_FragColor = vec4(1.0); }\` });\n` },
  },
  {
    id: "shader-version-directive",
    fire: { "a.js": `${T}const fragmentShader = \`#version 300 es\nout vec4 c;\nvoid main() { c = vec4(1.0); }\`;\nconst m = new THREE.ShaderMaterial({ fragmentShader });\n` },
    quiet: { "a.js": `${T}const fragmentShader = \`#version 300 es\nprecision highp float;\nout vec4 c;\nvoid main() { c = vec4(1.0); }\`;\nconst m = new THREE.RawShaderMaterial({ fragmentShader });\n` },
  },
  {
    id: "shader-builtin-redeclared",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ vertexShader: \`\nuniform mat4 projectionMatrix;\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\` });\n` },
    quiet: { "a.js": `${T}const m = new THREE.RawShaderMaterial({ vertexShader: \`\nuniform mat4 projectionMatrix;\nuniform mat4 modelViewMatrix;\nattribute vec3 position;\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\` });\n` },
  },
  {
    id: "shader-raw-undeclared",
    fire: { "a.js": `${T}const m = new THREE.RawShaderMaterial({ vertexShader: \`\nattribute vec3 position;\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\` });\n` },
    quiet: { "a.js": `${T}const m = new THREE.ShaderMaterial({ vertexShader: \`\nvoid main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }\` });\n` },
  },
  {
    id: "shader-raw-precision",
    fire: { "index.html": `<script id="fs" type="x-shader/x-fragment">\nvoid main() { gl_FragColor = vec4(1.0); }\n</script>\n<script type="module">\nimport * as THREE from 'three';\nconst m = new THREE.RawShaderMaterial({ fragmentShader: document.getElementById('fs').textContent });\n</script>\n` },
    quiet: { "a.js": `${T}const m = new THREE.RawShaderMaterial({ fragmentShader: \`precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }\` });\n` },
  },
  {
    id: "shader-lights-no-uniforms",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ lights: true, uniforms: { uColor: { value: new THREE.Color() } } });\n` },
    quiet: { "a.js": `${T}const m = new THREE.ShaderMaterial({ lights: true, uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.lights, { uColor: { value: new THREE.Color() } }]) });\n` },
  },
  {
    id: "shader-uniform-not-object",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ uniforms: { uTime: 0.0, uColor: { value: new THREE.Color() } } });\n` },
    quiet: { "a.js": `${T}const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0.0 }, uTex: new THREE.Uniform(null), ...THREE.UniformsLib.fog } });\n` },
  },
  {
    id: "shader-uniform-assign",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } } });\nm.uniforms.uTime = performance.now();\n` },
    quiet: { "a.js": `${T}const shared = { uTime: { value: 0 } };\nconst m = new THREE.MeshBasicMaterial();\nm.onBeforeCompile = (s) => { s.uniforms.uTime = shared.uTime; };\nm.userData.uniforms = 1;\n` },
  },
  {
    id: "shader-defines-no-update",
    fire: { "a.js": `${T}const m = new THREE.ShaderMaterial({ defines: { FANCY: 1 } });\nwindow.addEventListener('keydown', () => { m.defines.FANCY = 0; });\n` },
    quiet: { "a.js": `${T}const m = new THREE.ShaderMaterial({ defines: { FANCY: 1 } });\nm.defines.EXTRA = '';\nwindow.addEventListener('keydown', () => { m.defines.FANCY = 0; m.needsUpdate = true; });\n` },
  },
  {
    id: "shader-depth-define-renamed",
    fire: { "a.js": `${T}const s = \`\nvoid main() {\n#ifdef USE_LOGDEPTHBUF\n  gl_FragColor = vec4(1.0);\n#endif\n}\`;\n` },
    quiet: { "a.js": `${T}const s = \`\nvoid main() {\n#ifdef USE_LOGARITHMIC_DEPTH_BUFFER\n  gl_FragColor = vec4(1.0);\n#endif\n}\`;\n` },
  },
  {
    id: "shader-inverse-transform-direction",
    fire: { "a.js": `${T}const s = \`void main() { vec3 d = inverseTransformDirection(n, viewMatrix); gl_FragColor = vec4(d, 1.0); }\`;\n` },
    quiet: { "a.js": `${T}const s = \`vec3 inverseTransformDirection(vec3 d, mat4 m) { return d; }\nvoid main() { vec3 d = inverseTransformDirection(n, viewMatrix); gl_FragColor = vec4(d, 1.0); }\`;\n` },
  },
  {
    id: "webgpu-glsl-material",
    fire: { "a.js": `${GPU}const m = new THREE.ShaderMaterial({ fragmentShader: 'void main() {}' });\nrenderer.setAnimationLoop(() => renderer.render(scene, camera));\n` },
    quiet: { "a.js": `${GL}const m = new THREE.ShaderMaterial({ fragmentShader: 'void main() {}' });\nrenderer.setAnimationLoop(() => renderer.render(scene, camera));\n` },
  },
  {
    id: "node-material-webgl",
    fire: { "a.js": `import { WebGLRenderer } from 'three';\nimport { MeshStandardNodeMaterial } from 'three/webgpu';\nconst r = new WebGLRenderer();\nconst m = new MeshStandardNodeMaterial();\n` },
    quiet: { "a.js": "import { WebGLRenderer } from 'three';\nimport { MeshStandardNodeMaterial } from 'three/webgpu';\nimport { WebGLNodesHandler } from 'three/addons/tsl/WebGLNodesHandler.js';\nconst r = new WebGLRenderer();\nr.setNodesHandler(new WebGLNodesHandler());\nconst m = new MeshStandardNodeMaterial();\n" },
  },

  // ---- modules ----
  {
    id: "tsl-import-path",
    fire: { "a.js": "import { WebGPURenderer, uniform } from 'three/webgpu';\nimport { MeshStandardNodeMaterial } from 'three/tsl';\nconst t = uniform(0);\n" },
    quiet: { "a.js": "import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';\nimport { uniform, Fn, vec3 } from 'three/tsl';\nconst t = uniform(0);\n" },
  },
  {
    id: "three-src-import",
    fire: { "a.js": `${T}import { Vector3 } from 'three/src/math/Vector3.js';\nconst v = new Vector3();\n` },
    quiet: { "a.js": "import { Vector3 } from 'three';\nconst v = new Vector3();\n" },
  },
  {
    id: "importmap-missing",
    fire: { "index.html": '<script type="module" src="./main.js"></script>\n', "main.js": `${T}new THREE.Scene();\n` },
    quiet: { "index.html": '<script type="module" src="./main.js"></script>\n', "main.js": `${T}new THREE.Scene();\n`, "package.json": JSON.stringify({ devDependencies: { vite: "^7.0.0" } }) },
  },
  {
    id: "addon-path-extension",
    fire: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls';\n` },
    quiet: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n` },
  },
  {
    id: "rgbe-loader-deprecated",
    fire: { "a.js": `${T}import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';\nnew RGBELoader().load('a.hdr', (t) => {});\n` },
    quiet: { "a.js": `${T}import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';\nconsole.log('RGBELoader was renamed');\nnew HDRLoader().load('a.hdr', (t) => {});\n` },
  },
  {
    id: "deprecated-loader",
    fire: { "a.js": `${T}import { VTKLoader } from 'three/addons/loaders/VTKLoader.js';\n` },
    quiet: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\n` },
  },

  // ---- loaders ----
  {
    id: "ktx2-no-detect-support",
    fire: { "a.js": `${T}import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\nconst ktx2 = new KTX2Loader().setTranscoderPath('/basis/');\n` },
    quiet: { "a.js": `${T}import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\nconst ktx2 = new KTX2Loader().detectSupport(renderer);\n` },
  },
  {
    id: "decoder-not-attached",
    fire: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nimport { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';\nconst draco = new DRACOLoader();\nconst loader = new GLTFLoader();\nloader.load('a.glb', (gltf) => scene.add(gltf.scene));\n` },
    quiet: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nimport { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';\nconst draco = new DRACOLoader();\nconst loader = new GLTFLoader().setDRACOLoader(draco);\nloader.load('a.glb', (gltf) => scene.add(gltf.scene));\n` },
  },
  {
    id: "file-loader-no-return",
    fire: { "a.js": `${T}const loader = new THREE.FileLoader();\nconst data = loader.load('a.json');\n` },
    quiet: { "a.js": `${T}const loader = new THREE.FileLoader();\nloader.load('a.json', (data) => {});\nconst tex = new THREE.TextureLoader().load('a.png');\n` },
  },

  // ---- controls ----
  {
    id: "transform-controls-add",
    fire: { "a.js": `${T}import { TransformControls } from 'three/addons/controls/TransformControls.js';\nconst gizmo = new TransformControls(camera, renderer.domElement);\nscene.add(gizmo);\n` },
    quiet: { "a.js": `${T}import { TransformControls } from 'three/addons/controls/TransformControls.js';\nconst gizmo = new TransformControls(camera, renderer.domElement);\nscene.add(gizmo.getHelper());\n` },
  },
  {
    id: "controls-document",
    fire: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconst c = new OrbitControls(camera, document);\n` },
    quiet: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconst c = new OrbitControls(camera, document.body);\n` },
  },
  {
    id: "controls-no-element",
    fire: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconst c = new OrbitControls(camera);\n` },
    quiet: { "a.js": `${T}import { OrbitControls } from 'three/addons/controls/OrbitControls.js';\nconst c = new OrbitControls(camera);\nc.connect(renderer.domElement);\n` },
  },

  // ---- animation ----
  {
    id: "mixer-never-updated",
    fire: { "a.js": `${T}const mixer = new THREE.AnimationMixer(model);\nmixer.clipAction(clip).play();\n` },
    quiet: { "a.js": `${T}const mixer = new THREE.AnimationMixer(model);\nmixer.clipAction(clip).play();\nconst other = new THREE.AnimationMixer(model);\nmixers.push(other);\nrenderer.setAnimationLoop(() => { mixer.update(0.016); });\n` },
  },
  {
    id: "clip-action-unused",
    fire: { "a.js": `${T}const mixer = new THREE.AnimationMixer(model);\nclips.forEach((clip) => { mixer.clipAction(clip); });\nconst walk = mixer.clipAction(clips[0]);\nmixer.update(0);\n` },
    quiet: { "a.js": `${T}const mixer = new THREE.AnimationMixer(model);\nclips.forEach((clip) => mixer.clipAction(clip).play());\nconst walk = mixer.clipAction(clips[0]);\nwalk.play();\nmixer.update(0);\n` },
  },
  {
    id: "clock-elapsed-and-delta",
    fire: { "a.js": `${T}const clock = new THREE.Clock();\nfunction animate() { const t = clock.getElapsedTime(); const dt = clock.getDelta(); }\n` },
    quiet: { "a.js": `${T}const clock = new THREE.Clock();\nconst clock2 = new THREE.Clock();\nfunction animate() { const dt = clock.getDelta(); const t = clock2.getElapsedTime(); }\n` },
  },

  // ---- buffers ----
  {
    id: "instanced-no-needs-update",
    fire: { "a.js": `${T}const mesh = new THREE.InstancedMesh(g, m, 100);\nrenderer.setAnimationLoop(() => {\n  for (let i = 0; i < 100; i++) mesh.setMatrixAt(i, matrix);\n});\n` },
    quiet: { "a.js": `${T}const mesh = new THREE.InstancedMesh(g, m, 100);\nfor (let i = 0; i < 100; i++) mesh.setMatrixAt(i, matrix);\nrenderer.setAnimationLoop(() => {\n  for (let i = 0; i < 100; i++) mesh.setMatrixAt(i, matrix);\n  mesh.instanceMatrix.needsUpdate = true;\n});\n` },
  },
  {
    id: "attribute-no-needs-update",
    fire: { "a.js": `${T}const pos = geometry.attributes.position;\nfunction animate() {\n  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, 0, Math.sin(i), 0);\n}\n` },
    quiet: { "a.js": `${T}const pos = geometry.attributes.position;\nfunction animate() {\n  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, 0, Math.sin(i), 0);\n  pos.needsUpdate = true;\n}\n` },
  },
  {
    id: "update-range-removed",
    fire: { "a.js": `${T}attr.updateRange.offset = 0;\n` },
    quiet: { "a.js": `${T}attr.addUpdateRange(0, 3);\n` },
  },

  // ---- camera ----
  {
    id: "camera-aspect-fixed",
    fire: { "a.js": `${GL}renderer.setSize(window.innerWidth, window.innerHeight);\nconst camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);\nrenderer.render(scene, camera);\n` },
    quiet: { "a.js": `${GL}renderer.setSize(512, 512);\nconst camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);\nconst cam2 = new THREE.PerspectiveCamera(75, 1, 0.1, 100);\nrenderer.render(scene, camera);\nrenderer.render(scene, cam2);\nfunction resize() { cam2.aspect = innerWidth / innerHeight; }\n` },
  },
  {
    id: "raycast-mouse-window",
    fire: { "a.js": `${GL}renderer.setSize(container.clientWidth, container.clientHeight);\nwindow.addEventListener('pointermove', (e) => { pointer.x = (e.clientX / window.innerWidth) * 2 - 1; });\n` },
    quiet: { "a.js": `${GL}renderer.setSize(window.innerWidth, window.innerHeight);\nwindow.addEventListener('pointermove', (e) => { pointer.x = (e.clientX / window.innerWidth) * 2 - 1; });\n` },
  },
  {
    id: "render-args-swapped",
    fire: { "a.js": `${GL}renderer.render(camera, scene);\n` },
    quiet: { "a.js": `${GL}renderer.render(scene, camera);\ncomposer.render(delta);\n` },
  },

  // ---- shadows, textures, loops ----
  {
    id: "cast-shadow-no-receiver",
    fire: { "a.js": `${GL}renderer.shadowMap.enabled = true;\nlight.castShadow = true;\nmesh.castShadow = true;\n` },
    quiet: { "a.js": `${GL}renderer.shadowMap.enabled = true;\nlight.castShadow = true;\nmesh.castShadow = true;\nground.receiveShadow = true;\n`, "b.js": `${T}sunLight.castShadow = true;\n` },
  },
  {
    id: "gltf-texture-flipy",
    fire: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst tex = new THREE.TextureLoader().load('skin.png');\nnew GLTFLoader().load('a.glb', (gltf) => { gltf.scene.traverse((o) => { if (o.isMesh) o.material.map = tex; }); scene.add(gltf.scene); });\n` },
    quiet: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst tex = new THREE.TextureLoader().load('skin.png');\ntex.flipY = false;\nnew GLTFLoader().load('a.glb', (gltf) => { gltf.scene.traverse((o) => { if (o.isMesh) o.material.map = tex; }); scene.add(gltf.scene); });\n` },
  },
  {
    id: "double-animation-loop",
    fire: { "a.js": `${GL}function animate() {\n  requestAnimationFrame(animate);\n  renderer.render(scene, camera);\n}\nrenderer.setAnimationLoop(animate);\n` },
    quiet: { "a.js": `${GL}function animate() {\n  renderer.render(scene, camera);\n}\nrenderer.setAnimationLoop(animate);\n` },
  },
  {
    id: "stencil-not-enabled",
    fire: { "a.js": `${GL}const m = new THREE.MeshBasicMaterial({ stencilWrite: true, stencilRef: 1 });\n` },
    quiet: { "a.js": `${T}const renderer = new THREE.WebGLRenderer({ stencil: true });\nconst m = new THREE.MeshBasicMaterial({ stencilWrite: true, stencilRef: 1 });\n` },
  },
  {
    id: "add-gltf-result",
    fire: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nconst loader = new GLTFLoader();\nloader.load('a.glb', (gltf) => { scene.add(gltf); });\nconst model = await loader.loadAsync('b.glb');\nscene.add(model);\n` },
    quiet: { "a.js": `${T}import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nimport { FBXLoader } from 'three/addons/loaders/FBXLoader.js';\nconst loader = new GLTFLoader();\nloader.load('a.glb', (gltf) => { scene.add(gltf.scene); });\nnew FBXLoader().load('a.fbx', (fbx) => scene.add(fbx));\n` },
  },
  {
    id: "color-assign-number",
    fire: { "a.js": `${T}const material = new THREE.MeshStandardMaterial();\nmaterial.color = 0xff0000;\nlight.color = '#ffffff';\n` },
    quiet: { "a.js": `${T}const material = new THREE.MeshStandardMaterial();\nmaterial.color.set(0xff0000);\nlabel.style.color = '#ffffff';\n` },
  },
  {
    id: "rotation-degrees",
    fire: { "a.js": `${T}mesh.rotation.x = 90;\ncube.rotation.set(0, 180, 0);\n` },
    quiet: { "a.js": `${T}mesh.rotation.x = Math.PI / 2;\ncube.rotation.set(0, 1.5, 0);\nmesh.rotation.y = 0.90;\n` },
  },
  {
    id: "linewidth-ignored",
    fire: { "a.js": `${T}const m = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 3 });\n` },
    quiet: { "a.js": `${T}import { LineMaterial } from 'three/addons/lines/LineMaterial.js';\nconst m = new LineMaterial({ linewidth: 3 });\nconst b = new THREE.LineBasicMaterial({ linewidth: 1 });\n` },
  },

  // ---- color ----
  {
    id: "composer-no-output-pass",
    fire: { "a.js": `${T}import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\nconst composer = new EffectComposer(renderer);\n` },
    quiet: { "a.js": `${T}import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\nimport { OutputPass } from 'three/addons/postprocessing/OutputPass.js';\nconst composer = new EffectComposer(renderer);\ncomposer.addPass(new OutputPass());\n` },
  },
  {
    id: "composer-double-gamma",
    fire: { "a.js": `${T}const composer = new EffectComposer(renderer);\ncomposer.addPass(new ShaderPass(GammaCorrectionShader));\ncomposer.addPass(new OutputPass());\n` },
    quiet: { "a.js": `${T}const composer = new EffectComposer(renderer);\ncomposer.addPass(new ShaderPass(FXAAShader));\ncomposer.addPass(new OutputPass());\n` },
  },
  {
    id: "env-map-intensity-ignored",
    fire: { "a.js": `${T}scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;\nconst m = new THREE.MeshStandardMaterial({ envMapIntensity: 0.5 });\n` },
    quiet: { "a.js": `${T}scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;\nscene.environmentIntensity = 0.5;\nconst m = new THREE.MeshStandardMaterial({ envMapIntensity: 0.5 });\n` },
  },

  // ---- renamed options and deprecations ----
  {
    id: "text-geometry-height",
    fire: { "a.js": `${T}const g = new TextGeometry('Hi', { font, size: 1, height: 0.2 });\n` },
    quiet: { "a.js": `${T}const g = new TextGeometry('Hi', { font, size: 1, depth: 0.2 });\nconst p = new THREE.PlaneGeometry(1, 1);\nconst o = { height: 2 };\n` },
  },
  {
    id: "reverse-depth-buffer-option",
    fire: { "a.js": `${T}const r = new THREE.WebGLRenderer({ reverseDepthBuffer: true });\n` },
    quiet: { "a.js": `${T}const r = new THREE.WebGLRenderer({ reversedDepthBuffer: true });\n` },
  },
  {
    id: "color-buffer-type-option",
    fire: { "a.js": `${GPU.split("\n")[0]}\nconst r = new THREE.WebGPURenderer({ colorBufferType: THREE.HalfFloatType });\n` },
    quiet: { "a.js": `${GPU.split("\n")[0]}\nconst r = new THREE.WebGPURenderer({ outputBufferType: THREE.HalfFloatType });\n` },
  },
  {
    id: "pcf-soft-shadow",
    fire: { "a.js": `${GL}renderer.shadowMap.type = THREE.PCFSoftShadowMap;\n` },
    quiet: { "a.js": `${GL}renderer.shadowMap.type = THREE.PCFShadowMap;\n` },
  },
  {
    id: "post-processing-renamed",
    fire: { "a.js": `${GPU}const post = new THREE.PostProcessing(renderer);\n` },
    quiet: { "a.js": `${GPU}const post = new THREE.RenderPipeline(renderer);\n` },
  },
  {
    id: "deprecated-api",
    fire: { "a.js": `${GPU}await renderer.renderAsync(scene, camera);\nconst m = new THREE.MeshPhysicalMaterial({ iridescenceThicknessRange: [100, 400] });\n` },
    quiet: { "a.js": `${GPU}await renderer.init();\nrenderer.render(scene, camera);\nconst m = new THREE.MeshPhysicalMaterial({ iridescenceThicknessMinimum: 100 });\nconst s = new AudioSource();\n` },
  },
  {
    id: "tsl-renamed",
    fire: { "a.js": "import { WebGPURenderer } from 'three/webgpu';\nimport { directionToColor, normalView } from 'three/tsl';\nconst c = directionToColor(normalView);\n" },
    quiet: { "a.js": "import { WebGPURenderer } from 'three/webgpu';\nimport { packNormalToRGB, normalView } from 'three/tsl';\nconst c = packNormalToRGB(normalView);\nconst directionToColor = 1;\n" },
  },
  {
    id: "dispose-without-super",
    fire: { "a.js": "import { InstancedMesh } from 'three';\nclass Trees extends InstancedMesh {\n  dispose() {\n    this.geometry.dispose();\n  }\n}\n" },
    quiet: { "a.js": "import { InstancedMesh, Mesh } from 'three';\nclass Trees extends InstancedMesh {\n  dispose() {\n    super.dispose();\n    this.geometry.dispose();\n  }\n}\nclass Box extends Mesh {\n  dispose() {\n    this.geometry.dispose();\n  }\n}\n" },
  },

  // ---- React Three Fiber ----
  {
    id: "r3f-set-state-in-frame",
    fire: { "a.jsx": `${R3F}function Box() {\n  const [x, setX] = useState(0);\n  useFrame((state, delta) => { setX(x + delta); });\n  return <mesh position-x={x} />;\n}\n` },
    quiet: { "a.jsx": `${R3F}function Box() {\n  const [hovered, setHovered] = useState(false);\n  const ref = useRef();\n  useFrame((state, delta) => { ref.current.rotation.x += delta; });\n  return <mesh ref={ref} onPointerOver={() => setHovered(true)} />;\n}\n` },
  },
  {
    id: "r3f-render-without-priority",
    fire: { "a.jsx": `${R3F}function Render() {\n  useFrame(({ gl, scene, camera }) => { gl.render(scene, camera); });\n  return null;\n}\n` },
    quiet: { "a.jsx": `${R3F}function Render() {\n  useFrame(({ gl, scene, camera }) => { gl.render(scene, camera); }, 1);\n  return null;\n}\n` },
  },
  {
    id: "r3f-new-in-render",
    fire: { "a.jsx": `${R3F}function Box() {\n  const geometry = new THREE.BoxGeometry();\n  return <mesh geometry={geometry} />;\n}\n` },
    quiet: { "a.jsx": `${R3F}function Box() {\n  const geometry = useMemo(() => new THREE.BoxGeometry(), []);\n  const onClick = () => { const m = new THREE.MeshBasicMaterial(); };\n  return <mesh geometry={geometry} onClick={onClick} />;\n}\n` },
  },
];
