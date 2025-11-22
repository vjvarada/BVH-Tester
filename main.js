import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

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
controls.target.set(0, 1.5, 0);
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
let sweepPreviewMesh = null;
let showSweepPreview = true;
let showBaseVolume = true;
let showCutterOnly = false;

const boxMaterial = new THREE.MeshStandardMaterial({
  color: 0x6da6f2,
  metalness: 0.05,
  roughness: 0.4,
  transparent: true,
  opacity: 0.75,
});
const boxGeometry = new THREE.BoxGeometry(3, 3, 3);
const boxPosition = new THREE.Vector3(0, 1.5, 0);

const cutterRadius = 0.9;
const cutterHeight = 1.5;
const cutterSegments = 64;
const cutterMaterial = new THREE.MeshStandardMaterial({
  color: 0xff784e,
  transparent: true,
  opacity: 0.35,
  roughness: 0.3,
  metalness: 0.1,
  side: THREE.DoubleSide,
});
const sweepPreviewMaterial = new THREE.MeshBasicMaterial({
  color: 0xff784e,
  wireframe: true,
  transparent: true,
  opacity: 0.2,
});

function createCutterGeometry() {
  const waistRadius = cutterRadius * 0.35;
  const topRadius = cutterRadius;
  const bottomRadius = cutterRadius * 0.9;
  const topHeight = cutterHeight * 0.7;
  const bottomHeight = cutterHeight * 0.7;

  const topCone = new THREE.CylinderGeometry(
    topRadius,
    waistRadius,
    topHeight,
    cutterSegments,
    1,
    true
  );
  // place waist at y=0, top extends upward
  topCone.translate(0, topHeight * 0.5, 0);
  topCone.clearGroups();

  const bottomCone = new THREE.CylinderGeometry(
    waistRadius,
    bottomRadius,
    bottomHeight,
    4, // diamond-like base
    1,
    true
  );
  // place waist at y=0, base extends downward
  bottomCone.translate(0, -bottomHeight * 0.5, 0);
  bottomCone.clearGroups();

  const merged = mergeGeometriesSimple([topCone.toNonIndexed(), bottomCone.toNonIndexed()]);
  const welded = BufferGeometryUtils.mergeVertices(merged, 1e-5);
  welded.computeVertexNormals();
  welded.clearGroups();
  return welded;
}

const cutterGeometry = createCutterGeometry();

const startPreview = new THREE.Mesh(cutterGeometry.clone(), cutterMaterial);
startPreview.visible = true;
scene.add(startPreview);
const endPreview = new THREE.Mesh(cutterGeometry.clone(), sweepPreviewMaterial);
endPreview.visible = true;
scene.add(endPreview);

function createBaseBrush() {
  const mesh = new Brush(boxGeometry.clone(), boxMaterial.clone());
  mesh.position.copy(boxPosition);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function ensureNonIndexedWithUV(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (!g.getAttribute('uv')) {
    const vertCount = g.getAttribute('position').count;
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(vertCount * 2), 2));
  }
  if (!g.getAttribute('normal')) {
    g.computeVertexNormals();
  }
  g.clearGroups();
  return g;
}

function mergeGeometriesSimple(geos) {
  const positions = [];
  const uvs = [];
  const indices = [];
  let offset = 0;

  geos.forEach((geom) => {
    const g = ensureNonIndexedWithUV(geom);
    const pos = g.getAttribute('position');
    const uv = g.getAttribute('uv');
    const count = pos.count;

    for (let i = 0; i < count; i += 1) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      uvs.push(uv.getX(i), uv.getY(i));
    }

    for (let i = 0; i < count; i += 3) {
      indices.push(offset + i, offset + i + 1, offset + i + 2);
    }

    offset += count;
  });

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  merged.clearGroups();
  return merged;
}

function removeDegenerateTriangles(geom, eps = 1e-8) {
  const pos = geom.getAttribute('position');
  const index = geom.getIndex();
  if (!index) return geom;
  const newIndices = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const cxp = aby * acz - abz * acy;
    const cyp = abz * acx - abx * acz;
    const czp = abx * acy - aby * acx;
    const area2 = cxp * cxp + cyp * cyp + czp * czp;
    if (area2 > eps) {
      newIndices.push(a, b, c);
    }
  }
  const cleaned = geom.clone();
  cleaned.setIndex(newIndices);
  cleaned.computeVertexNormals();
  cleaned.clearGroups();
  return cleaned;
}

function convexHull2D(points) {
  if (points.length < 3) return points.slice();
  const pts = points
    .map((p) => new THREE.Vector2(p.x, p.y))
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function resampleRing(points, segments) {
  if (points.length === 0) return [];
  const loop = points.slice();
  loop.push(points[0]);
  const lengths = [];
  let total = 0;
  for (let i = 0; i < loop.length - 1; i += 1) {
    const d = loop[i].distanceTo(loop[i + 1]);
    lengths.push(d);
    total += d;
  }
  const resampled = [];
  for (let i = 0; i < segments; i += 1) {
    const t = (total * i) / segments;
    let acc = 0;
    let idx = 0;
    while (idx < lengths.length && acc + lengths[idx] < t) {
      acc += lengths[idx];
      idx += 1;
    }
    const segT = lengths[idx] > 0 ? (t - acc) / lengths[idx] : 0;
    const p0 = loop[idx];
    const p1 = loop[idx + 1];
    resampled.push(new THREE.Vector2().lerpVectors(p0, p1, segT));
  }
  return resampled;
}

function buildCapFromRing(ringVerts) {
  if (ringVerts.length < 3) return null;
  // sort ring vertices by angle for consistent fan
  const center = new THREE.Vector3();
  ringVerts.forEach((v) => center.add(v));
  center.divideScalar(ringVerts.length);
  ringVerts.sort((a, b) => Math.atan2(a.z - center.z, a.x - center.x) - Math.atan2(b.z - center.z, b.x - center.x));

  const positions = [];
  const uvs = [];
  const indices = [];

  positions.push(center.x, center.y, center.z);
  uvs.push(0.5, 0.5);

  ringVerts.forEach((v) => {
    positions.push(v.x, v.y, v.z);
    uvs.push(0.5, 0.5);
  });

  for (let i = 1; i < ringVerts.length; i += 1) {
    indices.push(0, i, i + 1);
  }
  indices.push(0, ringVerts.length, 1);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  geom.clearGroups();
  return geom;
}

function extractCaps(geom) {
  const pos = geom.getAttribute('position');
  const verts = [];
  for (let i = 0; i < pos.count; i += 1) {
    verts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  let minY = Infinity;
  let maxY = -Infinity;
  verts.forEach((v) => {
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  });
  const eps = 1e-4;
  const topRing = verts.filter((v) => Math.abs(v.y - maxY) < eps);
  const bottomRing = verts.filter((v) => Math.abs(v.y - minY) < eps);
  return { topRing, bottomRing };
}

function buildLoftGeometry(startGeom, endGeom) {
  const a = ensureNonIndexedWithUV(startGeom);
  const b = ensureNonIndexedWithUV(endGeom);

  const posA = a.getAttribute('position');
  const posB = b.getAttribute('position');
  const uvA = a.getAttribute('uv');
  const uvB = b.getAttribute('uv');

  if (posA.count !== posB.count) {
    throw new Error('Start and end geometries must have matching vertex counts for loft.');
  }

  const vertCount = posA.count;
  const positions = [];
  const uvs = [];
  const indices = [];

  // copy start vertices
  for (let i = 0; i < vertCount; i += 1) {
    positions.push(posA.getX(i), posA.getY(i), posA.getZ(i));
    uvs.push(uvA.getX(i), uvA.getY(i));
  }
  // copy end vertices
  for (let i = 0; i < vertCount; i += 1) {
    positions.push(posB.getX(i), posB.getY(i), posB.getZ(i));
    uvs.push(uvB.getX(i), uvB.getY(i));
  }

  const triCount = vertCount / 3;
  for (let t = 0; t < triCount; t += 1) {
    const A0 = t * 3;
    const A1 = t * 3 + 1;
    const A2 = t * 3 + 2;
    const B0 = A0 + vertCount;
    const B1 = A1 + vertCount;
    const B2 = A2 + vertCount;

    // three quad strips split to triangles
    indices.push(A0, A1, B1);
    indices.push(A0, B1, B0);

    indices.push(A1, A2, B2);
    indices.push(A1, B2, B1);

    indices.push(A2, A0, B0);
    indices.push(A2, B0, B2);
  }

  const loft = new THREE.BufferGeometry();
  loft.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  loft.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  loft.setIndex(indices);
  loft.computeVertexNormals();
  loft.clearGroups();
  return ensureNonIndexedWithUV(loft);
}

function createSweptBrush(coneY, sweepDistance) {
  const clampedSweep = Math.max(sweepDistance, 0);

  const startGeo = ensureNonIndexedWithUV(cutterGeometry.clone());
  startGeo.translate(0, coneY, 0);

  const endGeo = ensureNonIndexedWithUV(cutterGeometry.clone());
  endGeo.translate(0, coneY + clampedSweep, 0);

  const loftGeo = buildLoftGeometry(startGeo, endGeo);
  const { bottomRing: startBottomRing } = extractCaps(startGeo);
  const { topRing: endTopRing } = extractCaps(endGeo);

  const parts = [startGeo, endGeo, loftGeo];
  const bottomCap = buildCapFromRing(startBottomRing);
  const topCap = buildCapFromRing(endTopRing);
  if (bottomCap) parts.push(bottomCap);
  if (topCap) parts.push(topCap);

  const merged = mergeGeometriesSimple(parts);
  const welded = BufferGeometryUtils.mergeVertices(merged, 1e-5);
  welded.computeVertexNormals();
  const cleaned = removeDegenerateTriangles(welded);

  const sweptBrush = new Brush(cleaned, cutterMaterial.clone());
  sweptBrush.updateMatrixWorld(true);
  return { sweptBrush, sweptGeometry: cleaned };
}

function updateCSG(coneY, sweepDistance) {
  const baseBrush = createBaseBrush();
  const { sweptBrush, sweptGeometry } = createSweptBrush(coneY, sweepDistance);

  const result = evaluator.evaluate(baseBrush, sweptBrush, SUBTRACTION);
  result.material = boxMaterial.clone();

  if (resultMesh) {
    resultMesh.geometry.dispose();
    scene.remove(resultMesh);
  }

  resultMesh = result;
  scene.add(resultMesh);
  resultMesh.visible = showBaseVolume && !showCutterOnly;

  startPreview.position.set(0, coneY, 0);
  endPreview.position.set(0, coneY + sweepDistance, 0);
  const showCutterVisuals = showCutterOnly || showSweepPreview;
  startPreview.visible = showCutterVisuals;
  endPreview.visible = showCutterVisuals;

  if (sweepPreviewMesh) {
    scene.remove(sweepPreviewMesh);
    sweepPreviewMesh.geometry.dispose();
  }
  sweepPreviewMesh = new THREE.Mesh(sweptGeometry, sweepPreviewMaterial);
  sweepPreviewMesh.visible = showCutterVisuals;
  scene.add(sweepPreviewMesh);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

animate();

const coneYInput = document.getElementById('coneY');
const sweepInput = document.getElementById('sweep');
const coneYVal = document.getElementById('coneYVal');
const sweepVal = document.getElementById('sweepVal');
const showSweepInput = document.getElementById('showSweep');
const showBaseInput = document.getElementById('showBase');
const showCutterOnlyInput = document.getElementById('showCutterOnly');

function handleUIChange() {
  const coneY = parseFloat(coneYInput.value);
  const sweep = parseFloat(sweepInput.value);
  showSweepPreview = showSweepInput.checked;
  showBaseVolume = showBaseInput.checked;
  showCutterOnly = showCutterOnlyInput.checked;
  coneYVal.textContent = coneY.toFixed(2);
  sweepVal.textContent = sweep.toFixed(2);
  updateCSG(coneY, sweep);
}

handleUIChange();
coneYInput.addEventListener('input', handleUIChange);
sweepInput.addEventListener('input', handleUIChange);
showSweepInput.addEventListener('change', handleUIChange);
showBaseInput.addEventListener('change', handleUIChange);
showCutterOnlyInput.addEventListener('change', handleUIChange);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
