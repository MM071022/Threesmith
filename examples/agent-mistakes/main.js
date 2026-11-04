// A small scene with the mistakes coding agents make most in three.js. Threesmith's site shows what it says about it.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer();
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setPixelRatio( window.devicePixelRatio );
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 3, 2, 5 );
const controls = new OrbitControls( camera );
controls.enableDamping = true;

const box = new THREE.Mesh( new THREE.BoxBufferGeometry( 1, 1, 1 ), new THREE.MeshStandardMaterial( { color: 0x44aa88 } ) );
box.rotation.y = 45;
scene.add( box );

const crate = new THREE.TextureLoader().load( '/textures/crate.jpg' );
box.material.map = crate;

let mixer;
new GLTFLoader().load( '/models/Robot.glb', ( gltf ) => {
	scene.add( gltf );
	mixer = new THREE.AnimationMixer( gltf.scene );
	mixer.clipAction( gltf.animations[ 0 ] );
} );

function animate() {
	requestAnimationFrame( animate );
	box.position.lerp( new THREE.Vector3( 0, Math.sin( Date.now() / 500 ), 0 ), 0.1 );
	renderer.render( scene, camera );
}
animate();
