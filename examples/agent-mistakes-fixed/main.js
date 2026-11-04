// The agent-mistakes scene after threesmith fix and the hand fixes threesmith doctor listed: review 100/100, check PASS.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer( { antialias: true } );
renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
renderer.setSize( window.innerWidth, window.innerHeight );
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x101820 );
scene.add( new THREE.HemisphereLight( 0xcfe3ff, 0x2a2018, 1.2 ) );
const sun = new THREE.DirectionalLight( 0xffffff, 2.5 );
sun.position.set( 3, 5, 4 );
scene.add( sun );

const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 2.2, 1.6, 3.6 );
const controls = new OrbitControls( camera, renderer.domElement );
controls.enableDamping = true;
controls.target.set( 0, 0.9, 0 );

const crate = new THREE.TextureLoader().load( '/textures/crate.jpg' );
crate.colorSpace = THREE.SRGBColorSpace;
const box = new THREE.Mesh( new THREE.BoxGeometry( 1, 1, 1 ), new THREE.MeshStandardMaterial( { map: crate } ) );
box.position.x = - 1.2;
box.rotation.y = THREE.MathUtils.degToRad( 45 );
scene.add( box );

let mixer;
new GLTFLoader().load( '/models/robot.glb', ( gltf ) => {
	gltf.scene.position.x = 1;
	scene.add( gltf.scene );
	mixer = new THREE.AnimationMixer( gltf.scene );
	if ( gltf.animations[ 0 ] ) mixer.clipAction( gltf.animations[ 0 ] ).play();
} );

window.addEventListener( 'resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
} );

const timer = new THREE.Timer();

renderer.setAnimationLoop( ( time ) => {
	timer.update( time );
	box.position.y = THREE.MathUtils.lerp( box.position.y, 0.5 + Math.sin( time / 500 ) * 0.2, 0.1 );
	if ( mixer ) mixer.update( timer.getDelta() );
	controls.update();
	renderer.render( scene, camera );
} );

