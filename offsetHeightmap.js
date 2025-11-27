// ============================================
// Offset Heightmap Generation Module
// GPU-accelerated heightmap generation with tiling support
// ============================================

import * as THREE from 'three';

// ============================================
// Shader Definitions
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

bool found = false;
float foundZ = -100.0;

// Sphere kernel around a vertex (optimized)
void sphere(vec3 p) {
    vec2 delta = vPosition.xy - p.xy;
    float distSq = dot(delta, delta);
    float rSq = offset * offset;
    
    if (distSq > rSq) return;

    float deltaZ = sqrt(rSq - distSq);
    float z = p.z + deltaZ;
    
    if (z > foundZ) {
        foundZ = z;
        found = true;
    }
}

// Cylinder kernel along an edge (optimized)
void cyl(vec3 p1, vec3 p2) {
    vec2 delta = p2.xy - p1.xy;
    if (dot(delta, delta) < 0.0001) return;

    vec3 B = normalize(p2 - p1);
    vec3 C = vPosition - p1;
    float a = dot(B.xy, B.xy);
    float bHalf = -B.z * dot(B.xy, C.xy);
    float w = C.x * B.y - C.y * B.x;
    float BzSq = B.z * B.z;
    float rSq = offset * offset;
    float c = BzSq * (C.x * C.x + C.y * C.y) + w * w - rSq;
    
    float discriminant = bHalf * bHalf - a * c;
    if (discriminant < 0.0) return;

    C.z = (-bHalf + sqrt(discriminant)) / a;

    float l = dot(C, B);
    float edgeLen = distance(p1, p2);
    if (l < 0.0 || l > edgeLen) return;

    float z = p1.z + C.z;
    if (z > foundZ) {
        foundZ = z;
        found = true;
    }
}

void main() {
    vec3 p1 = vPosition1;
    vec3 p2 = vPosition2;
    vec3 p3 = vPosition3;

    if (vIsTriangle == 0.0) {
        sphere(p1);
        sphere(p2);
        sphere(p3);
        cyl(p1, p2);
        cyl(p1, p3);
        cyl(p2, p3);
    } else {
        foundZ = vPosition.z;
        found = true;
    }

    if (found) {
        foundZ = clamp(foundZ, -1.0, 1.0);
        gl_FragDepth = -foundZ * 0.5 + 0.5;

        float z = floor((foundZ + 1.0) * 32767.5 + 0.5);
        int high = int(floor(z * 0.00390625));
        int low  = int(z) - (high << 8);

        outColor = vec4(float(high) * 0.00392157, float(low) * 0.00392157, 0.0, 1.0);
    } else {
        discard;
    }
}
`;

// ============================================
// Renderer and Resource Management
// ============================================

let offsetRenderer = null;
let renderTargetCache = new Map();

function getOffsetRenderer() {
    if (!offsetRenderer) {
        offsetRenderer = new THREE.WebGLRenderer({ 
            antialias: false,
            powerPreference: 'high-performance'
        });
        offsetRenderer.setPixelRatio(1);
    }
    return offsetRenderer;
}

function getRenderTarget(resolution) {
    const key = resolution;
    
    if (!renderTargetCache.has(key)) {
        const target = new THREE.WebGLRenderTarget(resolution, resolution, {
            type: THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
            depthBuffer: true,
            stencilBuffer: false,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter
        });
        renderTargetCache.set(key, target);
    }
    
    return renderTargetCache.get(key);
}

export function cleanupOffscreenResources() {
    if (offsetRenderer) {
        offsetRenderer.dispose();
        offsetRenderer = null;
    }
    
    for (const target of renderTargetCache.values()) {
        target.dispose();
    }
    renderTargetCache.clear();
}

// ============================================
// IndexedDB Tile Storage
// ============================================

class HeightmapTileDB {
    constructor(dbName = 'HeightmapTileDB') {
        this.dbName = dbName;
        this.db = null;
        this.batchQueue = [];
        this.batchTimeout = null;
        this.batchSize = 10;
    }
    
    async init() {
        if (this.db) return;
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                this.db.onversionchange = () => {
                    this.db.close();
                };
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('tiles')) {
                    const store = db.createObjectStore('tiles', { keyPath: 'id' });
                    store.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };
        });
    }
    
    async saveTile(sessionId, tileX, tileY, data) {
        return new Promise((resolve, reject) => {
            this.batchQueue.push({ sessionId, tileX, tileY, data, resolve, reject });
            
            if (this.batchTimeout) {
                clearTimeout(this.batchTimeout);
            }
            
            if (this.batchQueue.length >= this.batchSize) {
                this.flushBatch();
            } else {
                this.batchTimeout = setTimeout(() => this.flushBatch(), 50);
            }
        });
    }
    
    async flushBatch() {
        if (this.batchQueue.length === 0) return;
        
        const batch = [...this.batchQueue];
        this.batchQueue = [];
        
        try {
            const transaction = this.db.transaction(['tiles'], 'readwrite');
            const store = transaction.objectStore('tiles');
            
            for (const { sessionId, tileX, tileY, data } of batch) {
                const id = `${sessionId}_${tileX}_${tileY}`;
                store.put({ id, sessionId, data });
            }
            
            await new Promise((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
            });
            
            batch.forEach(({ resolve }) => resolve());
        } catch (error) {
            batch.forEach(({ reject }) => reject(error));
        }
    }
    
    async loadTile(sessionId, tileX, tileY) {
        const id = `${sessionId}_${tileX}_${tileY}`;
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tiles'], 'readonly');
            const store = transaction.objectStore('tiles');
            const request = store.get(id);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                resolve(request.result ? request.result.data : null);
            };
        });
    }
    
    async clearSession(sessionId) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tiles'], 'readwrite');
            const store = transaction.objectStore('tiles');
            const index = store.index('sessionId');
            const request = index.openCursor(IDBKeyRange.only(sessionId));
            
            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    }
}

let tileDB = null;

async function getTileDB() {
    if (!tileDB) {
        tileDB = new HeightmapTileDB();
        await tileDB.init();
    }
    return tileDB;
}

// ============================================
// Morphological Operations
// ============================================

/**
 * Remove isolated outlier pixels that create cone artifacts
 * Only removes interior outliers, preserves boundary edges
 */
function removeIsolatedOutliers(heightMap, resolution, heightThreshold = 0.15) {
    const INVALID_VALUE = -0.99;
    const kernelSize = 5; // Check 5x5 neighborhood
    const halfKernel = Math.floor(kernelSize / 2);
    const removed = [];
    
    for (let y = halfKernel; y < resolution - halfKernel; y++) {
        for (let x = halfKernel; x < resolution - halfKernel; x++) {
            const idx = y * resolution + x;
            
            // Skip if already invalid
            if (heightMap[idx] <= INVALID_VALUE) continue;
            
            const currentHeight = heightMap[idx];
            
            // Collect valid neighbor heights and count invalid neighbors
            const neighborHeights = [];
            let invalidCount = 0;
            
            for (let ky = -halfKernel; ky <= halfKernel; ky++) {
                for (let kx = -halfKernel; kx <= halfKernel; kx++) {
                    if (kx === 0 && ky === 0) continue;
                    
                    const nx = x + kx;
                    const ny = y + ky;
                    const nIdx = ny * resolution + nx;
                    
                    if (heightMap[nIdx] > INVALID_VALUE) {
                        neighborHeights.push(heightMap[nIdx]);
                    } else {
                        invalidCount++;
                    }
                }
            }
            
            // Skip if near boundary (has many invalid neighbors)
            // Boundary pixels are legitimate features, not outliers
            if (invalidCount > 3) continue;
            
            // Need at least some valid neighbors to compare
            if (neighborHeights.length < 8) continue;
            
            // Calculate median neighbor height (more robust than mean)
            neighborHeights.sort((a, b) => a - b);
            const medianHeight = neighborHeights[Math.floor(neighborHeights.length / 2)];
            
            // Calculate how different this pixel is from neighbors
            const heightDiff = Math.abs(currentHeight - medianHeight);
            
            // Check if it's an extreme outlier compared to most neighbors
            let similarCount = 0;
            for (const h of neighborHeights) {
                if (Math.abs(currentHeight - h) < heightThreshold) {
                    similarCount++;
                }
            }
            
            // Only remove if different from median AND different from most neighbors
            // This preserves legitimate features while removing artifacts
            const similarRatio = similarCount / neighborHeights.length;
            if (heightDiff > heightThreshold && similarRatio < 0.3) {
                heightMap[idx] = -1.0; // Mark as invalid
                removed.push(idx);
            }
        }
    }
    
    if (removed.length > 0) {
        console.log(`Removed ${removed.length} interior outlier pixels`);
    }
}

/**
 * Apply morphological closing to fill interior holes only
 * Uses flood-fill from edges to identify exterior empty regions vs interior holes
 */
function applyMorphologicalClosing(heightMap, resolution, iterations = 5, kernelSize = 3) {
    const startTime = performance.now();
    
    const INVALID_VALUE = -0.99; // Empty pixels are at -1.0 (renderer clear value)
    const halfKernel = Math.floor(kernelSize / 2);
    
    // Step 0: Remove isolated outliers that create cone artifacts
    removeIsolatedOutliers(heightMap, resolution, 0.15);
    
    // Step 1: Mark exterior empty regions using flood-fill from edges
    const isExterior = new Uint8Array(heightMap.length); // 0 = unknown, 1 = exterior, 2 = interior hole
    const queue = [];
    
    // Start flood-fill from all edge empty pixels
    for (let x = 0; x < resolution; x++) {
        // Top edge
        if (heightMap[x] <= INVALID_VALUE) {
            queue.push(x);
            isExterior[x] = 1;
        }
        // Bottom edge
        const bottomIdx = (resolution - 1) * resolution + x;
        if (heightMap[bottomIdx] <= INVALID_VALUE) {
            queue.push(bottomIdx);
            isExterior[bottomIdx] = 1;
        }
    }
    for (let y = 1; y < resolution - 1; y++) {
        // Left edge
        const leftIdx = y * resolution;
        if (heightMap[leftIdx] <= INVALID_VALUE) {
            queue.push(leftIdx);
            isExterior[leftIdx] = 1;
        }
        // Right edge
        const rightIdx = y * resolution + (resolution - 1);
        if (heightMap[rightIdx] <= INVALID_VALUE) {
            queue.push(rightIdx);
            isExterior[rightIdx] = 1;
        }
    }
    
    // Flood-fill to mark all connected exterior regions
    while (queue.length > 0) {
        const idx = queue.shift();
        const x = idx % resolution;
        const y = Math.floor(idx / resolution);
        
        // Check 4-connected neighbors
        const neighbors = [
            [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]
        ];
        
        for (const [nx, ny] of neighbors) {
            if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
                const nIdx = ny * resolution + nx;
                if (isExterior[nIdx] === 0 && heightMap[nIdx] <= INVALID_VALUE) {
                    isExterior[nIdx] = 1;
                    queue.push(nIdx);
                }
            }
        }
    }
    
    // Mark interior holes (empty pixels not marked as exterior)
    for (let i = 0; i < heightMap.length; i++) {
        if (heightMap[i] <= INVALID_VALUE && isExterior[i] === 0) {
            isExterior[i] = 2; // Interior hole
        }
    }
    
    // Step 2: Fill only interior holes using dilation
    let current = new Float32Array(heightMap);
    let temp = new Float32Array(heightMap.length);
    
    for (let iter = 0; iter < iterations; iter++) {
        let changeCount = 0;
        
        for (let y = 0; y < resolution; y++) {
            for (let x = 0; x < resolution; x++) {
                const idx = y * resolution + x;
                
                // Only process interior holes
                if (isExterior[idx] === 2) {
                    // Find max valid neighbor
                    let maxVal = current[idx];
                    let foundValid = false;
                    
                    for (let ky = -halfKernel; ky <= halfKernel; ky++) {
                        for (let kx = -halfKernel; kx <= halfKernel; kx++) {
                            if (kx === 0 && ky === 0) continue;
                            
                            const nx = x + kx;
                            const ny = y + ky;
                            
                            if (nx >= 0 && nx < resolution && ny >= 0 && ny < resolution) {
                                const nIdx = ny * resolution + nx;
                                if (current[nIdx] > INVALID_VALUE) {
                                    maxVal = Math.max(maxVal, current[nIdx]);
                                    foundValid = true;
                                }
                            }
                        }
                    }
                    
                    if (foundValid && maxVal > INVALID_VALUE) {
                        temp[idx] = maxVal;
                        isExterior[idx] = 0; // No longer a hole
                        changeCount++;
                    } else {
                        temp[idx] = current[idx];
                    }
                } else {
                    // Keep valid pixels and exterior empty pixels unchanged
                    temp[idx] = current[idx];
                }
            }
        }
        
        // Swap buffers
        [current, temp] = [temp, current];
        
        // Early exit if no more changes
        if (changeCount === 0) {
            console.log(`Morphological closing converged after ${iter + 1} iterations`);
            break;
        }
    }
    
    // Copy result back to original array
    for (let i = 0; i < heightMap.length; i++) {
        heightMap[i] = current[i];
    }
    
    const endTime = performance.now();
    console.log(`Morphological closing applied in ${(endTime - startTime).toFixed(1)} ms`);
}

// ============================================
// Core Heightmap Generation Functions
// ============================================

function createSinglePassHeightMap(vertices, offset, resolution) {
    const renderer = getOffsetRenderer();
    const startTime = performance.now();

    const triCount = vertices.length / 9;
    const vertCount = triCount * 9;

    const position = new Float32Array(vertCount * 3);
    const position1 = new Float32Array(vertCount * 3);
    const position2 = new Float32Array(vertCount * 3);
    const position3 = new Float32Array(vertCount * 3);
    const vertexIndex = new Float32Array(vertCount);

    for (let tri = 0; tri < triCount; ++tri) {
        const baseIn = tri * 9;
        const baseOut = tri * 27;

        const p1x = vertices[baseIn + 0], p1y = vertices[baseIn + 1], p1z = vertices[baseIn + 2];
        const p2x = vertices[baseIn + 3], p2y = vertices[baseIn + 4], p2z = vertices[baseIn + 5];
        const p3x = vertices[baseIn + 6], p3y = vertices[baseIn + 7], p3z = vertices[baseIn + 8];

        for (let local = 0; local < 9; ++local) {
            const iOut = baseOut + local * 3;

            position[iOut + 0] = vertices[baseIn + (local % 3) * 3 + 0];
            position[iOut + 1] = vertices[baseIn + (local % 3) * 3 + 1];
            position[iOut + 2] = vertices[baseIn + (local % 3) * 3 + 2];

            position1[iOut + 0] = p1x; position1[iOut + 1] = p1y; position1[iOut + 2] = p1z;
            position2[iOut + 0] = p2x; position2[iOut + 1] = p2y; position2[iOut + 2] = p2z;
            position3[iOut + 0] = p3x; position3[iOut + 1] = p3y; position3[iOut + 2] = p3z;

            vertexIndex[tri * 9 + local] = local;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('position1', new THREE.BufferAttribute(position1, 3));
    geometry.setAttribute('position2', new THREE.BufferAttribute(position2, 3));
    geometry.setAttribute('position3', new THREE.BufferAttribute(position3, 3));
    geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertexIndex, 1));

    const box = new THREE.Box3();
    box.setFromArray(vertices);
    const size = new THREE.Vector3();
    box.getSize(size);

    const maxSize = Math.max(size.x, size.y, size.z);
    const padding = offset;
    const scale = 2 / (maxSize + 2 * padding);
    const center = new THREE.Vector3();
    box.getCenter(center).multiplyScalar(scale);

    const offsetMaterial = new THREE.RawShaderMaterial({
        uniforms: { offset: { value: offset * scale } },
        vertexShader: offsetVertexShader,
        fragmentShader: offsetFragmentShader,
        glslVersion: THREE.GLSL3,
    });

    offsetMaterial.extensions = { ...offsetMaterial.extensions, fragDepth: true };

    const object = new THREE.Mesh(geometry, offsetMaterial);

    const camera = new THREE.Camera();
    const e = camera.projectionMatrix.elements;
    e[0] = scale; e[4] = 0; e[8] = 0; e[12] = -center.x;
    e[1] = 0; e[5] = scale; e[9] = 0; e[13] = -center.y;
    e[2] = 0; e[6] = 0; e[10] = scale; e[14] = -center.z;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;

    const offsetScene = new THREE.Scene();
    offsetScene.add(object);

    const target = getRenderTarget(resolution);

    renderer.setSize(resolution, resolution, false);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(offsetScene, camera);
    renderer.setRenderTarget(null);

    const rawHeightMap = new Uint8Array(resolution * resolution * 4);
    renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, rawHeightMap);

    const heightMap = new Float32Array(resolution * resolution);
    for (let y = 0; y < resolution; ++y) {
        for (let x = 0; x < resolution; ++x) {
            const idx = (y * resolution + x) * 4;
            const r = rawHeightMap[idx];
            const g = rawHeightMap[idx + 1];
            const z16 = (r << 8) + g;
            const zNorm = z16 / 0xffff;
            const z = zNorm * 2.0 - 1.0;
            heightMap[y * resolution + x] = z;
        }
    }

    const endTime = performance.now();
    console.log(`Offset heightmap: ${triCount} triangles → ${resolution}x${resolution} in ${(endTime - startTime).toFixed(1)} ms`);
    
    // Apply morphological closing to fill enclosed holes
    applyMorphologicalClosing(heightMap, resolution);
    
    geometry.dispose();
    offsetMaterial.dispose();

    // Return both the scaling factor and the original bounding box size for visualization
    return { scale, center, size, rawHeightMap, heightMap, resolution };
}

function renderHeightMapTile(vertices, offset, scale, center, tileWidth, tileHeight, xStart, xEnd, yStart, yEnd) {
    const renderer = getOffsetRenderer();
    
    const triCount = vertices.length / 9;
    const vertCount = triCount * 9;
    
    const position = new Float32Array(vertCount * 3);
    const position1 = new Float32Array(vertCount * 3);
    const position2 = new Float32Array(vertCount * 3);
    const position3 = new Float32Array(vertCount * 3);
    const vertexIndex = new Float32Array(vertCount);
    
    for (let tri = 0; tri < triCount; ++tri) {
        const baseIn = tri * 9;
        const baseOut = tri * 27;
        
        const p1x = vertices[baseIn + 0], p1y = vertices[baseIn + 1], p1z = vertices[baseIn + 2];
        const p2x = vertices[baseIn + 3], p2y = vertices[baseIn + 4], p2z = vertices[baseIn + 5];
        const p3x = vertices[baseIn + 6], p3y = vertices[baseIn + 7], p3z = vertices[baseIn + 8];
        
        for (let local = 0; local < 9; ++local) {
            const iOut = baseOut + local * 3;
            
            position[iOut + 0] = vertices[baseIn + (local % 3) * 3 + 0];
            position[iOut + 1] = vertices[baseIn + (local % 3) * 3 + 1];
            position[iOut + 2] = vertices[baseIn + (local % 3) * 3 + 2];
            
            position1[iOut + 0] = p1x; position1[iOut + 1] = p1y; position1[iOut + 2] = p1z;
            position2[iOut + 0] = p2x; position2[iOut + 1] = p2y; position2[iOut + 2] = p2z;
            position3[iOut + 0] = p3x; position3[iOut + 1] = p3y; position3[iOut + 2] = p3z;
            
            vertexIndex[tri * 9 + local] = local;
        }
    }
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('position1', new THREE.BufferAttribute(position1, 3));
    geometry.setAttribute('position2', new THREE.BufferAttribute(position2, 3));
    geometry.setAttribute('position3', new THREE.BufferAttribute(position3, 3));
    geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertexIndex, 1));
    
    const offsetMaterial = new THREE.RawShaderMaterial({
        uniforms: { offset: { value: offset * scale } },
        vertexShader: offsetVertexShader,
        fragmentShader: offsetFragmentShader,
        glslVersion: THREE.GLSL3,
    });
    
    offsetMaterial.extensions = { ...offsetMaterial.extensions, fragDepth: true };
    
    const object = new THREE.Mesh(geometry, offsetMaterial);
    
    const camera = new THREE.Camera();
    const e = camera.projectionMatrix.elements;
    
    const ndcXStart = xStart * 2 - 1;
    const ndcXEnd = xEnd * 2 - 1;
    const ndcYStart = yStart * 2 - 1;
    const ndcYEnd = yEnd * 2 - 1;
    
    const tileScaleX = 2.0 / (ndcXEnd - ndcXStart);
    const tileScaleY = 2.0 / (ndcYEnd - ndcYStart);
    const tileOffsetX = -(ndcXStart + ndcXEnd) / (ndcXEnd - ndcXStart);
    const tileOffsetY = -(ndcYStart + ndcYEnd) / (ndcYEnd - ndcYStart);
    
    e[0] = scale * tileScaleX; e[4] = 0; e[8] = 0; e[12] = (-center.x * tileScaleX) + tileOffsetX;
    e[1] = 0; e[5] = scale * tileScaleY; e[9] = 0; e[13] = (-center.y * tileScaleY) + tileOffsetY;
    e[2] = 0; e[6] = 0; e[10] = scale; e[14] = -center.z;
    e[3] = 0; e[7] = 0; e[11] = 0; e[15] = 1;
    
    const offsetScene = new THREE.Scene();
    offsetScene.add(object);
    
    const target = getRenderTarget(Math.max(tileWidth, tileHeight));
    
    renderer.setSize(tileWidth, tileHeight, false);
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, tileWidth, tileHeight);
    renderer.clear();
    renderer.render(offsetScene, camera);
    renderer.setRenderTarget(null);
    
    const rawHeightMap = new Uint8Array(tileWidth * tileHeight * 4);
    renderer.readRenderTargetPixels(target, 0, 0, tileWidth, tileHeight, rawHeightMap);
    
    const heightMap = new Float32Array(tileWidth * tileHeight);
    for (let y = 0; y < tileHeight; ++y) {
        for (let x = 0; x < tileWidth; ++x) {
            const idx = (y * tileWidth + x) * 4;
            const r = rawHeightMap[idx];
            const g = rawHeightMap[idx + 1];
            const z16 = (r << 8) + g;
            const zNorm = z16 / 0xffff;
            const z = zNorm * 2.0 - 1.0;
            heightMap[y * tileWidth + x] = z;
        }
    }
    
    geometry.dispose();
    offsetMaterial.dispose();
    
    return { heightMap, resolution: tileWidth };
}

async function createTiledHeightMap(vertices, offset, resolution, tileSize, progressCallback = null) {
    const startTime = performance.now();
    
    const db = await getTileDB();
    const sessionId = `session_${Date.now()}`;
    
    const tilesPerSide = Math.ceil(resolution / tileSize);
    const totalTiles = tilesPerSide * tilesPerSide;
    
    console.log(`Tiled rendering: ${resolution}x${resolution} split into ${tilesPerSide}x${tilesPerSide} tiles`);
    
    const box = new THREE.Box3();
    box.setFromArray(vertices);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z);
    const padding = offset * 5.0;
    const scale = 2 / (maxSize + 2 * padding);
    const center = new THREE.Vector3();
    box.getCenter(center).multiplyScalar(scale);
    
    for (let tileY = 0; tileY < tilesPerSide; tileY++) {
        for (let tileX = 0; tileX < tilesPerSide; tileX++) {
            const tileIndex = tileY * tilesPerSide + tileX + 1;
            
            if (progressCallback) {
                progressCallback(tileIndex, totalTiles);
            }
            
            const xStart = (tileX * tileSize) / resolution;
            const xEnd = Math.min(((tileX + 1) * tileSize) / resolution, 1.0);
            const yStart = (tileY * tileSize) / resolution;
            const yEnd = Math.min(((tileY + 1) * tileSize) / resolution, 1.0);
            
            const tileWidth = Math.ceil((xEnd - xStart) * resolution);
            const tileHeight = Math.ceil((yEnd - yStart) * resolution);
            
            const tileResult = renderHeightMapTile(
                vertices, offset, scale, center,
                tileWidth, tileHeight,
                xStart, xEnd, yStart, yEnd
            );
            
            await db.saveTile(sessionId, tileX, tileY, {
                width: tileWidth,
                height: tileHeight,
                heightMap: tileResult.heightMap
            });
        }
    }
    
    await db.flushBatch();
    
    const endTime = performance.now();
    console.log(`Tiled heightmap complete: ${resolution}x${resolution} in ${(endTime - startTime).toFixed(1)} ms`);
    
    return {
        scale,
        center,
        rawHeightMap: null,
        heightMap: null,
        resolution,
        tileSize,
        tilesPerSide,
        sessionId,
        usesIndexedDB: true
    };
}

export async function loadHeightMapFromTiles(result, progressCallback = null) {
    if (!result.usesIndexedDB) {
        return result.heightMap;
    }
    
    const startTime = performance.now();
    
    const db = await getTileDB();
    const { resolution, tileSize, tilesPerSide, sessionId } = result;
    const heightMap = new Float32Array(resolution * resolution);
    heightMap.fill(-1.0);
    
    const totalTiles = tilesPerSide * tilesPerSide;
    let loadedTiles = 0;
    
    const BATCH_SIZE = 16;
    const tilesToLoad = [];
    
    for (let tileY = 0; tileY < tilesPerSide; tileY++) {
        for (let tileX = 0; tileX < tilesPerSide; tileX++) {
            tilesToLoad.push({ tileX, tileY });
        }
    }
    
    for (let i = 0; i < tilesToLoad.length; i += BATCH_SIZE) {
        const batch = tilesToLoad.slice(i, Math.min(i + BATCH_SIZE, tilesToLoad.length));
        
        const tilePromises = batch.map(({ tileX, tileY }) => 
            db.loadTile(sessionId, tileX, tileY).then(tileData => ({ tileX, tileY, tileData }))
        );
        
        const results = await Promise.all(tilePromises);
        
        for (const { tileX, tileY, tileData } of results) {
            if (!tileData) continue;
            
            loadedTiles++;
            if (progressCallback) {
                progressCallback(loadedTiles, totalTiles);
            }
            
            const { width: tileWidth, height: tileHeight, heightMap: tileHeightMap } = tileData;
            const destStartX = tileX * tileSize;
            const destStartY = tileY * tileSize;
            
            for (let y = 0; y < tileHeight; y++) {
                for (let x = 0; x < tileWidth; x++) {
                    const srcIdx = y * tileWidth + x;
                    const destX = destStartX + x;
                    const destY = destStartY + y;
                    
                    if (destX < resolution && destY < resolution) {
                        const destIdx = destY * resolution + destX;
                        heightMap[destIdx] = tileHeightMap[srcIdx];
                    }
                }
            }
        }
    }
    
    const endTime = performance.now();
    console.log(`Heightmap loaded from IndexedDB in ${(endTime - startTime).toFixed(1)} ms`);
    
    // Apply morphological closing to fill enclosed holes
    applyMorphologicalClosing(heightMap, resolution);
    
    return heightMap;
}

// ============================================
// Main API Function
// ============================================

export async function createOffsetHeightMap(vertices, offset, resolution = 1024, tileSize = 2048, progressCallback = null) {
    const needsTiling = resolution > tileSize;
    
    if (needsTiling) {
        return createTiledHeightMap(vertices, offset, resolution, tileSize, progressCallback);
    }
    
    return createSinglePassHeightMap(vertices, offset, resolution);
}
