import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Brush, Evaluator } from 'three-bvh-csg';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf1f3f7);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(5, 4, 7);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.75, 0);
controls.update();

const ambientLight = new THREE.HemisphereLight(0xffffff, 0x888888, 0.65);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.75);
dirLight.position.set(4, 6, 4);
scene.add(dirLight);

const grid = new THREE.GridHelper(12, 24, 0x222222, 0xcccccc);
grid.position.y = 0;
scene.add(grid);

const evaluator = new Evaluator();
let resultMesh = null;

const boxMaterial = new THREE.MeshStandardMaterial({
  color: 0x6da6f2,
  metalness: 0.05,
  roughness: 0.4,
});
const boxGeometry = new THREE.BoxGeometry(3, 1.5, 3);
const boxPosition = new THREE.Vector3(0, 0.75, 0);

const cutterRadius = 0.45;
const cutterHeight = 1.2;
const cutterSegments = 48;
const cutterMaterial = new THREE.MeshStandardMaterial({
  color: 0xff784e,
  transparent: true,
  opacity: 0.35,
  roughness: 0.3,
  metalness: 0.1,
  side: THREE.DoubleSide,
});
const cutterStart = new THREE.Vector3(0, 0.75, 0);

const startPreview = new THREE.Mesh(
  new THREE.CylinderGeometry(cutterRadius, cutterRadius, cutterHeight, cutterSegments),
  cutterMaterial
);
scene.add(startPreview);
const startEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(startPreview.geometry),
  new THREE.LineBasicMaterial({ color: 0xff8a65 })
);
startPreview.add(startEdges);

const endPreview = startPreview.clone();
scene.add(endPreview);

function meshGeoToWorld(mesh) {
  const geo = mesh.geometry.clone();
  mesh.updateMatrixWorld(true);
  geo.applyMatrix4(mesh.matrixWorld);
  return geo;
}

function createBaseBrush() {
  const mesh = new Brush(boxGeometry.clone(), boxMaterial.clone());
  mesh.position.copy(boxPosition);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function createSweptBrush(distance) {
  const clampedDistance = Math.max(distance, 0);

  const startMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(cutterRadius, cutterRadius, cutterHeight, cutterSegments),
    cutterMaterial
  );
  startMesh.position.copy(cutterStart);

  const endMesh = startMesh.clone();
  endMesh.position.copy(cutterStart).add(new THREE.Vector3(0, clampedDistance, 0));

  const wallHeight = Math.max(clampedDistance, 0.0001);
  const wallMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(cutterRadius, cutterRadius, wallHeight, cutterSegments, 1, true),
    cutterMaterial
  );
  wallMesh.position.copy(cutterStart);
  wallMesh.position.y += cutterHeight / 2 + wallHeight / 2;

  const worldGeometries = [startMesh, endMesh, wallMesh].map(meshGeoToWorld);
  const mergedGeometry = BufferGeometryUtils.mergeGeometries(worldGeometries, true);

  const sweptBrush = new Brush(mergedGeometry, cutterMaterial.clone());
  sweptBrush.updateMatrixWorld(true);
  return sweptBrush;
}

function updateCSG(distance) {
  const baseBrush = createBaseBrush();
  const sweptBrush = createSweptBrush(distance);

  const result = evaluator.evaluate(baseBrush, sweptBrush, Evaluator.SUBTRACTION);
  result.material = boxMaterial.clone();

  if (resultMesh) {
    resultMesh.geometry.dispose();
    scene.remove(resultMesh);
  }

  resultMesh = result;
  scene.add(resultMesh);

  startPreview.position.copy(cutterStart);
  endPreview.position.copy(cutterStart).add(new THREE.Vector3(0, distance, 0));
  startPreview.visible = true;
  endPreview.visible = true;
  endPreview.material.opacity = cutterMaterial.opacity;
  endPreview.material.transparent = true;
  endPreview.material = cutterMaterial;
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();

const distanceInput = document.getElementById('distance');
const distanceValue = document.getElementById('value');

function handleDistanceChange(event) {
  const value = parseFloat(event.target.value);
  distanceValue.textContent = value.toFixed(2);
  updateCSG(value);
}

updateCSG(parseFloat(distanceInput.value));
distanceInput.addEventListener('input', handleDistanceChange);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
