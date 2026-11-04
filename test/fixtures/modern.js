import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.shadowMap.enabled = true;
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 60, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 2, 5 );
const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;

const light = new THREE.DirectionalLight( 0xffffff, 3 );
light.castShadow = true;
scene.add( light, new THREE.AmbientLight( 0x404040 ) );

const geometry = new THREE.BoxGeometry();
const material = new THREE.MeshStandardMaterial( { color: 0x44aa88 } );
const mesh = new THREE.Mesh( geometry, material );
mesh.castShadow = true;
scene.add( mesh );

const ground = new THREE.Mesh( new THREE.PlaneGeometry( 10, 10 ), material );
ground.rotation.x = - Math.PI / 2;
ground.receiveShadow = true;
scene.add( ground );

const timer = new THREE.Timer();
const _v = new THREE.Vector3();

window.addEventListener( 'resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
} );

renderer.setAnimationLoop( ( time ) => {
	timer.update( time );
	mesh.rotation.y += timer.getDelta();
	_v.set( 0, 1, 0 );
	controls.update();
	renderer.render( scene, camera );
} );

function dispose() {
	scene.remove( mesh );
	geometry.dispose();
	material.dispose();
	renderer.dispose();
}
export { dispose };
