import { ACESFilmicToneMapping, Box3, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Vector3, WebGLRenderer, PMREMGenerator, SRGBColorSpace } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const stage = document.getElementById('model-stage');
const status = document.getElementById('viewer-status');
const controlsUI = [...document.querySelectorAll('[data-viewer]')];
let renderer, controls, environment, model, ground, observer, resizeObserver;
let stopped = false, visible = true, rotating = !matchMedia('(prefers-reduced-motion: reduce)').matches;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const canvas = document.createElement('canvas');
canvas.setAttribute('role', 'img');
canvas.setAttribute('aria-label', 'Interactive 3D robot built by Threesmith. Drag to rotate, or use the view buttons.');
canvas.tabIndex = -1;
const materials = new Set();
function release() {
  if(stopped) return;
  stopped = true; renderer?.setAnimationLoop(null); observer?.disconnect(); resizeObserver?.disconnect();
  controls?.dispose(); environment?.dispose();
  model?.traverse(node => {if(node.isMesh) {node.geometry.dispose(); for(const mat of (Array.isArray(node.material)?node.material:[node.material])) materials.add(mat);}});
  for(const mat of materials) {for(const value of Object.values(mat)) if(value?.isTexture) value.dispose(); mat.dispose();}
  ground?.geometry.dispose(); ground?.material.dispose(); renderer?.dispose();
}
function fallback() {
  release(); canvas.remove(); stage.dataset.state = 'fallback'; controlsUI.forEach(button => button.disabled = true);
  status.textContent = 'Static preview · 3D view unavailable in this browser';
}
async function start() {
  if(!('DecompressionStream' in window)) return fallback();
  renderer = new WebGLRenderer({canvas, antialias:true, alpha:true, powerPreference:'low-power'});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = SRGBColorSpace; renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer); const room = new RoomEnvironment();
  environment = pmrem.fromScene(room, .04); scene.environment = environment.texture;
  room.dispose(); pmrem.dispose();
  scene.add(new HemisphereLight(0xf0e8ff, 0x775d54, 2));
  const sun = new DirectionalLight(0xfff8ed, 3.5); sun.position.set(3,5,4); sun.castShadow = true; sun.shadow.mapSize.set(1024,1024);
  sun.shadow.normalBias = .02; sun.shadow.camera.left = sun.shadow.camera.bottom = -2; sun.shadow.camera.right = sun.shadow.camera.top = 2; sun.shadow.camera.far = 12;
  scene.add(sun);
  const rim = new DirectionalLight(0xaea0ff, 2); rim.position.set(-3,2,-3); scene.add(rim);
  const response = await fetch(new URL('./robot.glb.gz', import.meta.url));
  if(!response.ok) throw new Error('Model unavailable');
  const buffer = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const gltf = await new GLTFLoader().parseAsync(buffer, ''); model = gltf.scene;
  const box = new Box3().setFromObject(model); const size = box.getSize(new Vector3()); const center = box.getCenter(new Vector3());
  model.position.sub(center); model.position.y += size.y / 2;
  model.traverse(node => {if(node.isMesh) {node.castShadow = true;node.receiveShadow = true;}}); scene.add(model);
  ground = new Mesh(new PlaneGeometry(20,20), new ShadowMaterial({color:0x58406d,opacity:.16}));
  ground.rotation.x = -Math.PI/2; ground.receiveShadow = true; ground.position.y = -.004; scene.add(ground);
  const camera = new PerspectiveCamera(32,1,.01,50); const target = new Vector3(0,size.y*.5,0);
  const originalPosition = new Vector3(1.4,1.05,2.55).multiplyScalar(size.y / 1.4);
  camera.position.copy(originalPosition);
  controls = new OrbitControls(camera, canvas); canvas.style.touchAction = 'pan-y'; controls.target.copy(target); controls.enablePan = false; controls.enableZoom = false;
  controls.minPolarAngle = Math.PI*.23; controls.maxPolarAngle = Math.PI*.59; controls.autoRotate = rotating; controls.autoRotateSpeed = .65;
  controls.update();
  function render() {controls.update();renderer.render(scene,camera);}
  function resize() {const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();render();}
  stage.append(canvas); resize();
  resizeObserver = new ResizeObserver(resize); resizeObserver.observe(stage);
  function animate(time) {if(visible&&!document.hidden) {controls.update(); renderer.render(scene,camera);}}
  function updateLoop() {if(stopped)return; renderer.setAnimationLoop(rotating&&visible&&!document.hidden ? animate : null);render();}
  controls.addEventListener('change', () => {if(!rotating) renderer.render(scene,camera);});
  observer = new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;updateLoop();}); observer.observe(stage);
  document.addEventListener('visibilitychange',updateLoop);
  reducedMotion.addEventListener('change', event=>{if(event.matches) {rotating=false;controls.autoRotate=false;updateRotationButton();updateLoop();}});
  function updateRotationButton() {const button=document.querySelector('[data-viewer="rotation"]');button.setAttribute('aria-pressed',String(rotating));button.textContent=rotating?'Pause rotation':'Rotate model';}
  controlsUI.forEach(button=>{
    button.disabled=false;
    button.addEventListener('click',()=>{
      if(button.dataset.viewer==='wireframe') {const on=button.getAttribute('aria-pressed')!=='true';model.traverse(node=>{if(node.isMesh) for(const mat of (Array.isArray(node.material)?node.material:[node.material]))mat.wireframe=on;});button.setAttribute('aria-pressed',String(on));}
      if(button.dataset.viewer==='rotation') {rotating=!rotating;controls.autoRotate=rotating;updateRotationButton();updateLoop();}
      if(button.dataset.viewer==='left'||button.dataset.viewer==='right') {const offset=camera.position.clone().sub(target).applyAxisAngle(new Vector3(0,1,0),button.dataset.viewer==='left' ? Math.PI/6 : -Math.PI/6);camera.position.copy(target).add(offset);controls.update();}
      if(button.dataset.viewer==='reset') {camera.position.copy(originalPosition);controls.target.copy(target);controls.update();}
      render();
    });
  });
  updateRotationButton(); stage.dataset.state='ready';status.textContent='Live three.js preview · drag to explore'; updateLoop();
  canvas.addEventListener('webglcontextlost', event=>{event.preventDefault();fallback();},{once:true});
  window.addEventListener('pagehide',event=>{if(event.persisted) {renderer.setAnimationLoop(null);} else release();});
  window.addEventListener('pageshow',event=>{if(event.persisted)updateLoop();});
}
start().catch(fallback);
