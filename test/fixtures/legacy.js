import * as THREE from 'three';
import { OrbitControls } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WebGPURenderer } from 'three';

const renderer = new THREE.WebGLRenderer();
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio( window.devicePixelRatio );

const camera = new THREE.PerspectiveCamera( 75, 2, 0, 1000 );
const geo = new THREE.BoxBufferGeometry( 1, 1, 1 );
const geometry = new THREE.Geometry();
const m = new THREE.MeshStandardMaterial();
const mesh = new THREE.Mesh( geo, m );
mesh.castShadow = true;
const x = new THREE.WebGLRendrer();
const y = THREE.Math.degToRad( 10 );
texture.encoding = THREE.sRGBEncoding;

function animate() {
	requestAnimationFrame( animate );
	const v = new THREE.Vector3( 1, 2, 3 );
	const mat = new THREE.MeshBasicMaterial();
	scene.traverse( ( o ) => {} );
	mesh.geometry.applyMatrix( new THREE.Matrix4() );
	renderer.render( scene, camera );
}
animate();
