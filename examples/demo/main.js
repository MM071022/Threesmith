import * as THREE from 'three';

// A deterministic scene (no time-based motion) so the screenshot baseline is stable.
const renderer = new THREE.WebGLRenderer( { antialias: false } );
renderer.setPixelRatio( 1 );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.shadowMap.enabled = true;
document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
scene.background = new THREE.Color( 0x101820 );

const camera = new THREE.PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 3, 2.5, 4 );
camera.lookAt( 0, 0.5, 0 );

const sun = new THREE.DirectionalLight( 0xffffff, 3 );
sun.position.set( 3, 5, 2 );
sun.castShadow = true;
scene.add( sun, new THREE.HemisphereLight( 0x8899ff, 0x223322, 0.6 ) );

const cube = new THREE.Mesh( new THREE.BoxGeometry( 1.2, 1.2, 1.2 ), new THREE.MeshStandardMaterial( { color: 0x44aa88, roughness: 0.4 } ) );
cube.position.y = 0.6;
cube.rotation.y = 0.6;
cube.castShadow = true;

const floor = new THREE.Mesh( new THREE.PlaneGeometry( 8, 8 ), new THREE.MeshStandardMaterial( { color: 0x667788 } ) );
floor.rotation.x = - Math.PI / 2;
floor.receiveShadow = true;
scene.add( cube, floor );

window.addEventListener( 'resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
} );

renderer.setAnimationLoop( () => renderer.render( scene, camera ) );
