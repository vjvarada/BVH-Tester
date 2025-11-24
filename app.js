// ============================================
// Main Application Entry Point
// ============================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import Stats from 'three/addons/libs/stats.module.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Add BVH support to BufferGeometry
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ============================================
// Offset Heightmap Module
// ============================================

const offsetVertexShader = /* glsl */`
precision highp float;
precision highp int;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform float offset;

in vec3 position1;
in vec3 position2;
in vec3 position3;
in float vertexIndex;

out float vIsTriangle;
out vec3 vPosition;
out vec3 vPosition1;
out vec3 vPosition2;
out vec3 vPosition3;

vec3 projectPoint(vec3 p) {
    return (projectionMatrix * modelViewMatrix * vec4(p, 1.0)).xyz;
}

void main() {
    vec3 p1 = projectPoint(position1);
    vec3 p2 = projectPoint(position2);
    vec3 p3 = projectPoint(position3);

    vec4 result;
    int index = int(vertexIndex);

    // First 6 vertices = quad (expanded XY bounds)
    if (index < 6) {
        // 2D bounding box expanded by offset in projected space
        vec2 minBounds = min(min(
            vec2(p1.x - offset, p1.y - offset),
            vec2(p2.x - offset, p2.y - offset)),
            vec2(p3.x - offset, p3.y - offset)
        );
        vec2 maxBounds = max(max(
            vec2(p1.x + offset, p1.y + offset),
            vec2(p2.x + offset, p2.y + offset)),
            vec2(p3.x + offset, p3.y + offset)
        );

        if (index == 0)
            result = vec4(minBounds.x, minBounds.y, p1.z, 1.0);
        else if (index == 1 || index == 4)
            result = vec4(maxBounds.x, minBounds.y, p1.z, 1.0);
        else if (index == 2 || index == 3)
            result = vec4(minBounds.x, maxBounds.y, p1.z, 1.0);
        else
            result = vec4(maxBounds.x, maxBounds.y, p1.z, 1.0);
    } else {
        // 7,8,9 = triangle vertices offset along triangle normal
        vec3 triangleOffset = offset * normalize(cross(p2 - p1, p3 - p1));
        if (index == 7)
            result = vec4(p1 + triangleOffset, 1.0);
        else if (index == 8)
            result = vec4(p2 + triangleOffset, 1.0);
        else
            result = vec4(p3 + triangleOffset, 1.0);
    }

    gl_Position = result;

    vIsTriangle = float(index >= 6);
    vPosition = result.xyz;
    vPosition1 = p1;
    vPosition2 = p2;
    vPosition3 = p3;
}
`;

const offsetFragmentShader = /* glsl */`
#extension GL_EXT_frag_depth : enable

precision highp float;
precision highp int;

uniform float offset;

in float vIsTriangle;
in vec3 vPosition;
in vec3 vPosition1;
in vec3 vPosition2;
in vec3 vPosition3;

out vec4 outColor;

vec3 debugNormal;

bool found = false;
float foundZ = -100.0;

// Sphere kernel around a vertex
void sphere(vec3 p) {
    float r = offset;
    vec2 delta = vPosition.xy - p.xy;
    if (length(delta) > r) return;

    float deltaZ = sqrt(r * r - delta.x * delta.x - delta.y * delta.y);
    float z = p.z + deltaZ;
    if (z < foundZ) return;

    foundZ = z;
    found = true;
    debugNormal = normalize(vec3(delta.xy, deltaZ));
}

// Cylinder kernel along an edge
void cyl(vec3 p1, vec3 p2) {
    float r = offset;
    if (p1.xy == p2.xy) return;

    vec3 B = normalize(p2 - p1);
    vec3 C = vPosition - p1;
    float a = dot(B.xy, B.xy);
    float b = -2.0 * B.z * dot(B.xy, C.xy);
    float w = C.x * B.y - C.y * B.x;
    float c = C.y * C.y * B.z * B.z + B.z * B.z * C.x * C.x + w * w - r * r;
    float sq = b * b - 4.0 * a * c;
    if (sq < 0.0) return;

    C.z = (-b + sqrt(sq)) / (2.0 * a);

    float l = dot(C, B);
    if (l < 0.0 || l > distance(p1, p2)) return;

    float z = p1.z + C.z;
    if (z < foundZ) return;

    foundZ = z;
    found = true;
    debugNormal = normalize(vec3(1.0, 1.0, 1.0));
}

void main() {
    vec3 p1 = vPosition1;
    vec3 p2 = vPosition2;
    vec3 p3 = vPosition3;

    if (vIsTriangle == 0.0) {
        // Quad pass: accumulate sphere + cylinder contributions
        sphere(p1);
        sphere(p2);
        sphere(p3);
        cyl(p1, p2);
        cyl(p1, p3);
        cyl(p2, p3);
    } else {
        // Triangle pass: use the offset triangle itself
        foundZ = vPosition.z;
        found = true;
        debugNormal = normalize(cross(p2 - p1, p3 - p1));
    }

    if (found) {
        // Clamp to NDC-ish range [-1,1]
        foundZ = clamp(foundZ, -1.0, 1.0);
        gl_FragDepth = -foundZ / 2.0 + 0.5;

        // Encode foundZ into RG16 (2 bytes, packed into RG channels)
        float z = floor((foundZ + 1.0) * float(0xffff) / 2.0 + 0.5);
        int high = int(floor(z / 256.0));
        int low  = int(z) - (high * 256);

        outColor = vec4(float(high) / 255.0, float(low) / 255.0, 0.0, 1.0);

        // Debug shading version (optional):
        // float debugLight = dot(debugNormal, normalize(vec3(1.0, 1.0, 1.0))) / 2.0 + 0.5;
        // outColor = vec4(vec3(0.0, 1.0, 1.0) * debugLight, 1.0);
    } else {
        discard;
    }
}
`;

// ---------------------------------------------------------
// Create an offscreen renderer for the offset pass
// ---------------------------------------------------------

let offsetRenderer = null;

function getOffsetRenderer() {
    if (!offsetRenderer) {
        offsetRenderer = new THREE.WebGLRenderer({ antialias: false });
        // We keep this canvas off-DOM; you can attach if you want to debug
        offsetRenderer.setPixelRatio(1);
    }
    return offsetRenderer;
}

// ---------------------------------------------------------
// Core function: createOffsetHeightMap
//    vertices: Float32Array (triangle soup, xyz per vertex)
//    offset:   world-space offset distance
//    resolution: heightmap resolution (e.g., 512 or 1024)
// ---------------------------------------------------------

function createOffsetHeightMap(vertices, offset, resolution = 1024) {
    const renderer = getOffsetRenderer();

    const startTime = performance.now();

    // --- Build per-vertex attributes (position1/2/3 + vertexIndex) ---
    //
    // For each input triangle (3 vertices), we create *9* vertices:
    //  - 0..5 = bounding quad corners
    //  - 6..8 = offset triangle vertices

    const triCount = vertices.length / 9; // 9 floats per triangle
    const vertCount = triCount * 9;

    const position  = new Float32Array(vertCount * 3);
    const position1 = new Float32Array(vertCount * 3);
    const position2 = new Float32Array(vertCount * 3);
    const position3 = new Float32Array(vertCount * 3);
    const vertexIndex = new Float32Array(vertCount);

    for (let tri = 0; tri < triCount; ++tri) {
        const baseIn  = tri * 9;   // 3 vertices * 3 floats
        const baseOut = tri * 27;  // 9 vertices * 3 floats

        // Original triangle vertices in model space
        const p1x = vertices[baseIn + 0];
        const p1y = vertices[baseIn + 1];
        const p1z = vertices[baseIn + 2];

        const p2x = vertices[baseIn + 3];
        const p2y = vertices[baseIn + 4];
        const p2z = vertices[baseIn + 5];

        const p3x = vertices[baseIn + 6];
        const p3y = vertices[baseIn + 7];
        const p3z = vertices[baseIn + 8];

        // Fill 9 vertices; for each we store:
        // - position (just any of the triangle points; not really used in shader)
        // - position1/2/3 = the same triangle
        for (let local = 0; local < 9; ++local) {
            const iOut = baseOut + local * 3;

            // "position" attribute = entire packed triangle repeated
            // (kept for compatibility with original code)
            position[iOut + 0] = vertices[baseIn + (local % 3) * 3 + 0];
            position[iOut + 1] = vertices[baseIn + (local % 3) * 3 + 1];
            position[iOut + 2] = vertices[baseIn + (local % 3) * 3 + 2];

            // Triangle copies
            position1[iOut + 0] = p1x;
            position1[iOut + 1] = p1y;
            position1[iOut + 2] = p1z;

            position2[iOut + 0] = p2x;
            position2[iOut + 1] = p2y;
            position2[iOut + 2] = p2z;

            position3[iOut + 0] = p3x;
            position3[iOut + 1] = p3y;
            position3[iOut + 2] = p3z;

            vertexIndex[tri * 9 + local] = local;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position',   new THREE.BufferAttribute(position,   3));
    geometry.setAttribute('position1',  new THREE.BufferAttribute(position1,  3));
    geometry.setAttribute('position2',  new THREE.BufferAttribute(position2,  3));
    geometry.setAttribute('position3',  new THREE.BufferAttribute(position3,  3));
    geometry.setAttribute('vertexIndex',new THREE.BufferAttribute(vertexIndex,1));

    // --- Compute bounding box and scale to fit [-1, 1] cube with margin ---
    const box = new THREE.Box3();
    box.setFromArray(vertices);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxSize = Math.max(size.x, size.y, size.z);
    const scale = 2 / (maxSize + 2 * offset);

    const center = new THREE.Vector3();
    box.getCenter(center).multiplyScalar(scale);

    // --- Material & mesh for offset pass ---
    const offsetMaterial = new THREE.RawShaderMaterial({
        uniforms: {
            offset: { value: offset * scale }
        },
        vertexShader: offsetVertexShader,
        fragmentShader: offsetFragmentShader,
        glslVersion: THREE.GLSL3, // WebGL2 path (if you prefer WebGL1, drop this)
    });

    // Enable depth extension support flag (Three.js still exposes this)
    offsetMaterial.extensions = { ...offsetMaterial.extensions, fragDepth: true };

    const object = new THREE.Mesh(geometry, offsetMaterial);

    // --- Camera with custom “projectionMatrix as transform” trick ---
    const camera = new THREE.Camera();
    const e = camera.projectionMatrix.elements;

    // This sets up a sort of scale+translate matrix so the model maps to [-1,1]
    e[0]  = scale; e[4]  = 0;     e[8]  = 0;     e[12] = -center.x;
    e[1]  = 0;     e[5]  = scale; e[9]  = 0;     e[13] = -center.y;
    e[2]  = 0;     e[6]  = 0;     e[10] = scale; e[14] = -center.z;
    e[3]  = 0;     e[7]  = 0;     e[11] = 0;     e[15] = 1;

    const offsetScene = new THREE.Scene();
    offsetScene.add(object);

    const target = new THREE.WebGLRenderTarget(resolution, resolution, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        depthBuffer: true,
        stencilBuffer: false
    });

    renderer.setSize(resolution, resolution, false);
    renderer.setRenderTarget(target);
    renderer.render(offsetScene, camera);
    renderer.setRenderTarget(null);

    // --- Read back heightmap ---
    const rawHeightMap = new Uint8Array(resolution * resolution * 4);
    renderer.readRenderTargetPixels(
        target,
        0, 0,
        resolution, resolution,
        rawHeightMap
    );

    const heightMap = new Float32Array(resolution * resolution);
    for (let y = 0; y < resolution; ++y) {
        for (let x = 0; x < resolution; ++x) {
            const idx = (y * resolution + x) * 4;
            const r = rawHeightMap[idx];
            const g = rawHeightMap[idx + 1];

            // Decode back from RG16 → [-1, 1]
            const z16 = (r << 8) + g;
            const zNorm = z16 / 0xffff;      // [0,1]
            const z = zNorm * 2.0 - 1.0;     // [-1,1]

            heightMap[y * resolution + x] = z;
        }
    }

    const endTime = performance.now();
    console.log(
        `Offset heightmap: ${triCount} triangles → ${resolution}x${resolution} in ${(endTime - startTime).toFixed(1)} ms`
    );

    return {
        scale,
        center,          // in scaled space
        rawHeightMap,    // RGBA bytes if you want a texture
        heightMap,       // Float32 array in [-1,1] "normalized" space
        resolution
    };
}

// ============================================
// Main Application
// ============================================

class OffsetGeneratorApp {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.stats = null;
        
        this.originalMesh = null;
        this.offsetMesh = null;
        this.heightmapMesh = null;
        this.bboxHelper = null;
        this.axesHelper = null;
        this.rayHelpers = [];
        
        this.loadedGeometry = null;
        
        this.init();
        this.setupEventListeners();
        this.animate();
    }
    
    init() {
        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);
        
        // Camera
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(50, 50, 50);
        
        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        const canvasContainer = document.getElementById('canvas-container');
        if (!canvasContainer) {
            console.error('Canvas container not found in DOM');
            return;
        }
        canvasContainer.appendChild(this.renderer.domElement);
        
        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        
        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 10, 10);
        this.scene.add(directionalLight);
        
        // Axes Helper
        this.axesHelper = new THREE.AxesHelper(100);
        this.scene.add(this.axesHelper);
        
        // Stats
        this.stats = new Stats();
        this.stats.dom.style.position = 'absolute';
        this.stats.dom.style.top = '0px';
        this.stats.dom.style.right = '0px';
        const statsContainer = document.getElementById('stats-container');
        if (statsContainer) {
            statsContainer.appendChild(this.stats.dom);
        }
        
        // Resize handler
        window.addEventListener('resize', () => this.onWindowResize());
        
        this.logStatus('Application initialized. Ready to load STL file.', 'info');
    }
    
    setupEventListeners() {
        // File input
        document.getElementById('file-input').addEventListener('change', (e) => this.handleFileUpload(e));
        
        // Generate button
        document.getElementById('generate-btn').addEventListener('click', () => this.generateOffset());
        
        // View toggles
        document.getElementById('show-original').addEventListener('change', (e) => {
            if (this.originalMesh) this.originalMesh.visible = e.target.checked;
        });
        
        document.getElementById('show-offset').addEventListener('change', (e) => {
            if (this.offsetMesh) this.offsetMesh.visible = e.target.checked;
        });
        
        document.getElementById('show-heightmap').addEventListener('change', (e) => {
            if (this.heightmapMesh) this.heightmapMesh.visible = e.target.checked;
        });
        
        document.getElementById('show-bbox').addEventListener('change', (e) => {
            if (this.bboxHelper) this.bboxHelper.visible = e.target.checked;
        });
        
        document.getElementById('show-axes').addEventListener('change', (e) => {
            if (this.axesHelper) this.axesHelper.visible = e.target.checked;
        });
        
        document.getElementById('debug-rays').addEventListener('change', (e) => {
            this.rayHelpers.forEach(helper => helper.visible = e.target.checked);
        });
    }
    
    handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        this.logStatus(`Loading file: ${file.name}...`, 'info');
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const loader = new STLLoader();
            const geometry = loader.parse(e.target.result);
            
            // Compute BVH for acceleration
            geometry.computeBoundsTree();
            
            this.loadedGeometry = geometry;
            
            // Clear previous meshes
            this.clearScene();
            
            // Create original mesh
            const material = new THREE.MeshPhongMaterial({ 
                color: 0x4fc3f7,
                transparent: true,
                opacity: 0.7,
                side: THREE.DoubleSide
            });
            
            this.originalMesh = new THREE.Mesh(geometry, material);
            this.scene.add(this.originalMesh);
            
            // Add bounding box helper
            const box = new THREE.Box3().setFromObject(this.originalMesh);
            this.bboxHelper = new THREE.Box3Helper(box, 0xffff00);
            this.bboxHelper.visible = document.getElementById('show-bbox').checked;
            this.scene.add(this.bboxHelper);
            
            // Center camera on object
            const center = new THREE.Vector3();
            box.getCenter(center);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            const fov = this.camera.fov * (Math.PI / 180);
            let cameraZ = Math.abs(maxDim / 2 / Math.tan(fov / 2));
            cameraZ *= 2; // Offset multiplier
            
            this.camera.position.set(center.x + cameraZ, center.y + cameraZ, center.z + cameraZ);
            this.camera.lookAt(center);
            this.controls.target.copy(center);
            this.controls.update();
            
            const vertexCount = geometry.attributes.position.count;
            const triangleCount = vertexCount / 3;
            
            this.logStatus(
                `✓ Loaded: ${file.name} (${triangleCount.toLocaleString()} triangles)`,
                'success'
            );
            
            document.getElementById('generate-btn').disabled = false;
        };
        
        reader.onerror = () => {
            this.logStatus('✗ Error loading file', 'error');
        };
        
        reader.readAsArrayBuffer(file);
    }
    
    generateOffset() {
        if (!this.loadedGeometry) {
            this.logStatus('✗ No geometry loaded', 'error');
            return;
        }
        
        const offsetDistance = parseFloat(document.getElementById('offset-distance').value);
        const resolution = parseInt(document.getElementById('heightmap-resolution').value);
        
        this.logStatus(`Generating offset (distance: ${offsetDistance}, resolution: ${resolution})...`, 'info');
        
        // Get vertices as Float32Array
        const vertices = this.loadedGeometry.attributes.position.array;
        
        try {
            // Generate heightmap using the offset algorithm
            const result = createOffsetHeightMap(vertices, offsetDistance, resolution);
            
            this.logStatus(`✓ Heightmap generated (${result.resolution}x${result.resolution})`, 'success');
            
            // Create offset mesh visualization
            this.createOffsetMeshVisualization(result, offsetDistance);
            
            // Create heightmap mesh visualization
            this.createHeightmapVisualization(result);
            
        } catch (error) {
            this.logStatus(`✗ Error generating offset: ${error.message}`, 'error');
            console.error(error);
        }
    }
    
    createOffsetMeshVisualization(result, offsetDistance) {
        // Remove previous offset mesh
        if (this.offsetMesh) {
            this.scene.remove(this.offsetMesh);
            this.offsetMesh.geometry.dispose();
            this.offsetMesh.material.dispose();
        }
        
        // Create a simple offset by moving vertices along normals
        const originalGeometry = this.loadedGeometry;
        const offsetGeometry = originalGeometry.clone();
        
        // Compute normals if not present
        if (!offsetGeometry.attributes.normal) {
            offsetGeometry.computeVertexNormals();
        }
        
        const positions = offsetGeometry.attributes.position.array;
        const normals = offsetGeometry.attributes.normal.array;
        
        for (let i = 0; i < positions.length; i += 3) {
            positions[i] += normals[i] * offsetDistance;
            positions[i + 1] += normals[i + 1] * offsetDistance;
            positions[i + 2] += normals[i + 2] * offsetDistance;
        }
        
        offsetGeometry.attributes.position.needsUpdate = true;
        offsetGeometry.computeBoundingSphere();
        
        const material = new THREE.MeshPhongMaterial({ 
            color: 0x81c784,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            wireframe: false
        });
        
        this.offsetMesh = new THREE.Mesh(offsetGeometry, material);
        this.offsetMesh.visible = document.getElementById('show-offset').checked;
        this.scene.add(this.offsetMesh);
        
        this.logStatus('✓ Offset mesh created', 'success');
    }
    
    createHeightmapVisualization(result) {
        // Remove previous heightmap mesh
        if (this.heightmapMesh) {
            this.scene.remove(this.heightmapMesh);
            this.heightmapMesh.geometry.dispose();
            this.heightmapMesh.material.dispose();
        }
        
        const { heightMap, resolution, scale, center } = result;
        
        // Apply Gaussian smoothing to the heightmap
        const smoothedHeightMap = this.smoothHeightmap(heightMap, resolution, 2); // 2 passes
        
        // Create plane geometry from heightmap
        const geometry = new THREE.PlaneGeometry(2, 2, resolution - 1, resolution - 1);
        const positions = geometry.attributes.position.array;
        
        // Apply smoothed heightmap data
        for (let i = 0; i < positions.length; i += 3) {
            const vertexIndex = i / 3;
            const x = vertexIndex % resolution;
            const y = Math.floor(vertexIndex / resolution);
            
            // Flip Y coordinate to match rendered heightmap orientation
            const heightValue = smoothedHeightMap[(resolution - 1 - y) * resolution + x];
            positions[i + 2] = heightValue; // Set Z from heightmap
        }
        
        geometry.attributes.position.needsUpdate = true;
        geometry.computeVertexNormals();
        
        // Create texture from heightmap for visualization
        const canvas = document.createElement('canvas');
        canvas.width = resolution;
        canvas.height = resolution;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(resolution, resolution);
        
        // Flip the texture vertically to match the geometry
        for (let y = 0; y < resolution; y++) {
            for (let x = 0; x < resolution; x++) {
                const srcIdx = ((resolution - 1 - y) * resolution + x);
                const dstIdx = (y * resolution + x) * 4;
                const value = (smoothedHeightMap[srcIdx] + 1) * 127.5; // Map [-1,1] to [0,255]
                imageData.data[dstIdx] = value;
                imageData.data[dstIdx + 1] = value;
                imageData.data[dstIdx + 2] = value;
                imageData.data[dstIdx + 3] = 255;
            }
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.needsUpdate = true;
        
        const material = new THREE.MeshPhongMaterial({ 
            map: texture,
            side: THREE.DoubleSide,
            wireframe: false
        });
        
        this.heightmapMesh = new THREE.Mesh(geometry, material);
        
        // Scale back from normalized space
        this.heightmapMesh.scale.set(1 / scale, 1 / scale, 1 / scale);
        this.heightmapMesh.position.set(center.x / scale, center.y / scale, center.z / scale);
        
        this.heightmapMesh.visible = document.getElementById('show-heightmap').checked;
        this.scene.add(this.heightmapMesh);
        
        this.logStatus('✓ Heightmap visualization created (smoothed)', 'success');
    }
    
    smoothHeightmap(heightMap, resolution, passes = 1) {
        let current = new Float32Array(heightMap);
        let next = new Float32Array(resolution * resolution);
        
        // Gaussian kernel weights (3x3)
        const kernel = [
            [1, 2, 1],
            [2, 4, 2],
            [1, 2, 1]
        ];
        const kernelSum = 16;
        
        for (let pass = 0; pass < passes; pass++) {
            for (let y = 0; y < resolution; y++) {
                for (let x = 0; x < resolution; x++) {
                    let sum = 0;
                    let weightSum = 0;
                    
                    // Apply 3x3 kernel
                    for (let ky = -1; ky <= 1; ky++) {
                        for (let kx = -1; kx <= 1; kx++) {
                            const nx = x + kx;
                            const ny = y + ky;
                            
                            // Check bounds
                            if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
                                const idx = ny * resolution + nx;
                                const weight = kernel[ky + 1][kx + 1];
                                sum += current[idx] * weight;
                                weightSum += weight;
                            }
                        }
                    }
                    
                    next[y * resolution + x] = sum / weightSum;
                }
            }
            
            // Swap buffers
            [current, next] = [next, current];
        }
        
        return current;
    }
    
    clearScene() {
        if (this.originalMesh) {
            this.scene.remove(this.originalMesh);
            this.originalMesh = null;
        }
        if (this.offsetMesh) {
            this.scene.remove(this.offsetMesh);
            this.offsetMesh.geometry.dispose();
            this.offsetMesh.material.dispose();
            this.offsetMesh = null;
        }
        if (this.heightmapMesh) {
            this.scene.remove(this.heightmapMesh);
            this.heightmapMesh.geometry.dispose();
            this.heightmapMesh.material.dispose();
            this.heightmapMesh = null;
        }
        if (this.bboxHelper) {
            this.scene.remove(this.bboxHelper);
            this.bboxHelper = null;
        }
        this.rayHelpers.forEach(helper => this.scene.remove(helper));
        this.rayHelpers = [];
    }
    
    logStatus(message, type = 'info') {
        const statusDiv = document.getElementById('status');
        if (!statusDiv) {
            console.log(`[${type}] ${message}`);
            return;
        }
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        statusDiv.appendChild(entry);
        statusDiv.scrollTop = statusDiv.scrollHeight;
        
        // Keep only last 20 entries
        while (statusDiv.children.length > 20) {
            statusDiv.removeChild(statusDiv.firstChild);
        }
    }
    
    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        this.stats.update();
    }
}

// Initialize application when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new OffsetGeneratorApp();
    });
} else {
    // DOM is already loaded (module scripts are deferred)
    new OffsetGeneratorApp();
}
