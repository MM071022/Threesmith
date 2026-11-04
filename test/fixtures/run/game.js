// A tiny game for the play, scenario, perf and leaks tests: a player that jumps (Space) and walks (hold ArrowRight),
// a box that a click on #hide hides, and window.app with load()/unload() of a level (?leak=1 forgets to dispose).
import * as THREE from 'three';

const leak = new URLSearchParams(location.search).has('leak') || window.LEAK === true;
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x102030);
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.set(0, 2, 8);
scene.add(new THREE.AmbientLight(0xffffff, 2));
const player = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x44aa88 }));
player.name = 'player';
scene.add(player);
const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
box.name = 'box';
box.position.set(-2, 0, 0);
scene.add(box);

const btn = document.createElement('button');
btn.id = 'hide';
btn.textContent = 'hide';
btn.style.cssText = 'position:fixed;top:0;left:0';
btn.addEventListener('click', () => { box.visible = false; });
document.body.appendChild(btn);

let vy = 0;
const keys = new Set();
window.addEventListener('keydown', (e) => { keys.add(e.key); if (e.key === ' ' && player.position.y === 0) vy = 6; });
window.addEventListener('keyup', (e) => keys.delete(e.key));

let level = null;
window.app = {
  load() {
    level = new THREE.Group();
    level.name = 'level';
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      m.position.set(i - 1, 2, 0);
      level.add(m);
    }
    scene.add(level);
  },
  unload() {
    if (!level) return;
    scene.remove(level);
    if (!leak) level.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    level = null;
  },
};

const clock = new THREE.Timer();
renderer.setAnimationLoop((t) => {
  clock.update(t);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (keys.has('ArrowRight')) player.position.x += 3 * dt;
  vy -= 15 * dt;
  player.position.y = Math.max(0, player.position.y + vy * dt);
  if (player.position.y === 0) vy = 0;
  renderer.render(scene, camera);
});
