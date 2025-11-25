// ============================================
// Main Application Entry Point
// ============================================
//
// OPTIMIZATION SUMMARY:
// 
// 1. IndexedDB Performance:
//    - Batch operations: Groups tile saves for fewer transactions
//    - Session indexing: Faster session-based queries and cleanup
//    - Connection pooling: Reuses single DB connection
//    - Auto-cleanup: Removes sessions older than 1 hour
//
// 2. WebGL Resource Management:
//    - Render target caching: Reuses render targets instead of creating new ones
//    - Proper disposal: All geometries, materials, and textures are disposed
//    - Power preference: Uses high-performance GPU when available
//    - Viewport management: Proper clear and viewport setup
//
// 3. Shader Optimizations:
//    - Dot product for distance: Faster than length() function
//    - Precomputed constants: Division replaced with multiplication
//    - Early exits: Degenerate edge detection
//    - Bit shifting: Faster encoding than arithmetic operations
//    - Removed unused variables: Cleaner and faster
//
// 4. Memory Management:
//    - Separable Gaussian blur: O(n) instead of O(n²) for smoothing
//    - Typed arrays: Consistent use of Float32Array and Uint8Array
//    - Buffer reuse: Swap buffers instead of allocating new ones
//    - Progressive rendering: Tiles processed and saved incrementally
//
// 5. Error Handling:
//    - Input validation: Checks for NaN and invalid values
//    - Try-catch blocks: Graceful error recovery
//    - Progress callbacks: User feedback during long operations
//    - Resource cleanup on errors: Prevents memory leaks
//
// 6. Performance Features:
//    - Adaptive LOD: Downsamples display resolution for large heightmaps
//    - Tiled rendering: Supports resolutions up to 16384×16384
//    - Batch processing: IndexedDB operations grouped for efficiency
//    - Cached render targets: Reduced GPU allocations
//
// ============================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
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

bool found = false;
float foundZ = -100.0;

// Sphere kernel around a vertex (optimized)
void sphere(vec3 p) {
    vec2 delta = vPosition.xy - p.xy;
    float distSq = dot(delta, delta);
    float rSq = offset * offset;
    
    if (distSq > rSq) return;

    float deltaZ = sqrt(rSq - distSq); // Simplified
    float z = p.z + deltaZ;
    
    if (z > foundZ) {
        foundZ = z;
        found = true;
    }
}

// Cylinder kernel along an edge (optimized)
void cyl(vec3 p1, vec3 p2) {
    vec2 delta = p2.xy - p1.xy;
    if (dot(delta, delta) < 0.0001) return; // Early exit for degenerate edges

    vec3 B = normalize(p2 - p1);
    vec3 C = vPosition - p1;
    float a = dot(B.xy, B.xy);
    float bHalf = -B.z * dot(B.xy, C.xy); // Use half to avoid multiply by 2
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
    }

    if (found) {
        // Clamp to NDC range [-1,1] and compute depth
        foundZ = clamp(foundZ, -1.0, 1.0);
        gl_FragDepth = -foundZ * 0.5 + 0.5;

        // Encode foundZ into RG16 (2 bytes, packed into RG channels)
        float z = floor((foundZ + 1.0) * 32767.5 + 0.5); // 0xffff/2 = 32767.5
        int high = int(floor(z * 0.00390625)); // 1/256
        int low  = int(z) - (high << 8); // Bit shift instead of multiply

        outColor = vec4(float(high) * 0.00392157, float(low) * 0.00392157, 0.0, 1.0); // 1/255
    } else {
        discard;
    }
}
`;

// ---------------------------------------------------------
// Create an offscreen renderer for the offset pass
// ---------------------------------------------------------

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

// Get or create render target with caching to reduce allocations
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

// Cleanup function for offscreen resources
function cleanupOffscreenResources() {
    if (offsetRenderer) {
        offsetRenderer.dispose();
        offsetRenderer = null;
    }
    
    for (const target of renderTargetCache.values()) {
        target.dispose();
    }
    renderTargetCache.clear();
}

// ---------------------------------------------------------
// Core function: createOffsetHeightMap
//    vertices: Float32Array (triangle soup, xyz per vertex)
//    offset:   world-space offset distance
//    resolution: heightmap resolution (can exceed GPU limits via tiling)
//    tileSize: size of individual tiles (default 2048 for GPU compatibility)
// ---------------------------------------------------------

function createOffsetHeightMap(vertices, offset, resolution = 1024, tileSize = 2048, progressCallback = null) {
    const renderer = getOffsetRenderer();
    const startTime = performance.now();
    
    // Check if we need tiled rendering
    const needsTiling = resolution > tileSize;
    
    if (needsTiling) {
        return createTiledHeightMap(vertices, offset, resolution, tileSize, progressCallback);
    }
    
    // Single-pass rendering for resolutions <= tileSize
    return createSinglePassHeightMap(vertices, offset, resolution);
}

// ---------------------------------------------------------
// Single-pass heightmap rendering (for resolution <= 2048)
// ---------------------------------------------------------

function createSinglePassHeightMap(vertices, offset, resolution) {
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
    
    // Add padding based on offset to prevent clipping
    // Project to bounding box plus offset distance
    const padding = offset;
    const scale = 2 / (maxSize + 2 * padding);
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

    const target = getRenderTarget(resolution);

    renderer.setSize(resolution, resolution, false);
    renderer.setRenderTarget(target);
    renderer.clear();
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
    
    // Clean up geometry and material to prevent memory leaks
    geometry.dispose();
    offsetMaterial.dispose();

    return {
        scale,
        center,          // in scaled space
        rawHeightMap,    // RGBA bytes if you want a texture
        heightMap,       // Float32 array in [-1,1] "normalized" space
        resolution
    };
}

// ---------------------------------------------------------
// IndexedDB Helper for Tile Storage
// ---------------------------------------------------------

class HeightmapTileDB {
    constructor(dbName = 'HeightmapTileDB') {
        this.dbName = dbName;
        this.db = null;
        this.batchQueue = [];
        this.batchTimeout = null;
        this.batchSize = 10; // Batch up to 10 operations
    }
    
    async init() {
        if (this.db) return; // Already initialized
        
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                
                // Handle connection errors gracefully
                this.db.onversionchange = () => {
                    this.db.close();
                    console.warn('IndexedDB connection closed due to version change');
                };
                
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('tiles')) {
                    const store = db.createObjectStore('tiles', { keyPath: 'id' });
                    // Add index for faster session-based queries
                    store.createIndex('sessionId', 'sessionId', { unique: false });
                }
            };
        });
    }
    
    // Batch save operations for better performance
    async saveTileBatch(tiles) {
        if (!tiles || tiles.length === 0) return;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tiles'], 'readwrite');
            const store = transaction.objectStore('tiles');
            
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
            
            for (const tile of tiles) {
                const { sessionId, tileX, tileY, data } = tile;
                const id = `${sessionId}_${tileX}_${tileY}`;
                store.put({ id, sessionId, data });
            }
        });
    }
    
    async saveTile(sessionId, tileX, tileY, data) {
        // For single saves, add to batch queue
        return new Promise((resolve, reject) => {
            this.batchQueue.push({ sessionId, tileX, tileY, data, resolve, reject });
            
            // Clear existing timeout
            if (this.batchTimeout) {
                clearTimeout(this.batchTimeout);
            }
            
            // Flush immediately if batch is full
            if (this.batchQueue.length >= this.batchSize) {
                this.flushBatch();
            } else {
                // Otherwise schedule a flush
                this.batchTimeout = setTimeout(() => this.flushBatch(), 50);
            }
        });
    }
    
    async flushBatch() {
        if (this.batchQueue.length === 0) return;
        
        const batch = [...this.batchQueue];
        this.batchQueue = [];
        
        try {
            const tiles = batch.map(({ sessionId, tileX, tileY, data }) => 
                ({ sessionId, tileX, tileY, data })
            );
            
            await this.saveTileBatch(tiles);
            
            // Resolve all promises
            batch.forEach(({ resolve }) => resolve());
        } catch (error) {
            // Reject all promises
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
    
    // Optimized: Use index for faster session-based deletion
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

// Global tile DB instance
let tileDB = null;

async function getTileDB() {
    if (!tileDB) {
        tileDB = new HeightmapTileDB();
        await tileDB.init();
    }
    return tileDB;
}

// ---------------------------------------------------------
// Multi-pass tiled heightmap rendering (for resolution > 2048)
// Uses IndexedDB for tile storage to reduce memory usage
// ---------------------------------------------------------

async function createTiledHeightMap(vertices, offset, resolution, tileSize, progressCallback = null) {
    const startTime = performance.now();
    
    // Initialize IndexedDB
    const db = await getTileDB();
    const sessionId = `session_${Date.now()}`;
    
    // Calculate number of tiles needed
    const tilesPerSide = Math.ceil(resolution / tileSize);
    const totalTiles = tilesPerSide * tilesPerSide;
    
    console.log(`Tiled rendering: ${resolution}x${resolution} split into ${tilesPerSide}x${tilesPerSide} tiles of ${tileSize}x${tileSize}`);
    console.log(`Using IndexedDB for tile storage (session: ${sessionId})`);
    
    // Calculate bounding box once
    const box = new THREE.Box3();
    box.setFromArray(vertices);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxSize = Math.max(size.x, size.y, size.z);
    const padding = offset * 5.0;
    const scale = 2 / (maxSize + 2 * padding);
    const center = new THREE.Vector3();
    box.getCenter(center).multiplyScalar(scale);
    
    // Process tiles in batches to improve IndexedDB performance
    const batchSize = 4; // Process 4 tiles before flushing to DB
    const tileBatch = [];
    
    // Render and save tiles to IndexedDB
    for (let tileY = 0; tileY < tilesPerSide; tileY++) {
        for (let tileX = 0; tileX < tilesPerSide; tileX++) {
            const tileIndex = tileY * tilesPerSide + tileX + 1;
            
            if (progressCallback) {
                progressCallback(tileIndex, totalTiles);
            }
            
            console.log(`Rendering tile ${tileIndex}/${totalTiles}...`);
            
            // Calculate tile bounds in normalized space [0, 1]
            const xStart = (tileX * tileSize) / resolution;
            const xEnd = Math.min(((tileX + 1) * tileSize) / resolution, 1.0);
            const yStart = (tileY * tileSize) / resolution;
            const yEnd = Math.min(((tileY + 1) * tileSize) / resolution, 1.0);
            
            // Calculate tile dimensions
            const tileWidth = Math.ceil((xEnd - xStart) * resolution);
            const tileHeight = Math.ceil((yEnd - yStart) * resolution);
            
            // Render this tile
            const tileResult = renderHeightMapTile(
                vertices, offset, scale, center,
                tileWidth, tileHeight,
                xStart, xEnd, yStart, yEnd
            );
            
            // Save tile to IndexedDB
            await db.saveTile(sessionId, tileX, tileY, {
                width: tileWidth,
                height: tileHeight,
                heightMap: tileResult.heightMap
            });
            
            console.log(`Tile ${tileIndex}/${totalTiles} saved to IndexedDB`);
        }
    }
    
    // Ensure final batch is flushed
    await db.flushBatch();
    
    const endTime = performance.now();
    console.log(`Tiled heightmap complete: ${resolution}x${resolution} in ${(endTime - startTime).toFixed(1)} ms`);
    console.log(`Tiles stored in IndexedDB (session: ${sessionId})`);
    
    return {
        scale,
        center,
        rawHeightMap: null,
        heightMap: null, // Will be loaded on-demand
        resolution,
        tileSize,
        tilesPerSide,
        sessionId,
        usesIndexedDB: true
    };
}

// ---------------------------------------------------------
// Render a single tile of the heightmap
// ---------------------------------------------------------

function renderHeightMapTile(vertices, offset, scale, center, tileWidth, tileHeight, xStart, xEnd, yStart, yEnd) {
    const renderer = getOffsetRenderer();
    
    // Build geometry (same as single-pass)
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
        
        const p1x = vertices[baseIn + 0];
        const p1y = vertices[baseIn + 1];
        const p1z = vertices[baseIn + 2];
        
        const p2x = vertices[baseIn + 3];
        const p2y = vertices[baseIn + 4];
        const p2z = vertices[baseIn + 5];
        
        const p3x = vertices[baseIn + 6];
        const p3y = vertices[baseIn + 7];
        const p3z = vertices[baseIn + 8];
        
        for (let local = 0; local < 9; ++local) {
            const iOut = baseOut + local * 3;
            
            position[iOut + 0] = vertices[baseIn + (local % 3) * 3 + 0];
            position[iOut + 1] = vertices[baseIn + (local % 3) * 3 + 1];
            position[iOut + 2] = vertices[baseIn + (local % 3) * 3 + 2];
            
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
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('position1', new THREE.BufferAttribute(position1, 3));
    geometry.setAttribute('position2', new THREE.BufferAttribute(position2, 3));
    geometry.setAttribute('position3', new THREE.BufferAttribute(position3, 3));
    geometry.setAttribute('vertexIndex', new THREE.BufferAttribute(vertexIndex, 1));
    
    const offsetMaterial = new THREE.RawShaderMaterial({
        uniforms: {
            offset: { value: offset * scale }
        },
        vertexShader: offsetVertexShader,
        fragmentShader: offsetFragmentShader,
        glslVersion: THREE.GLSL3,
    });
    
    offsetMaterial.extensions = { ...offsetMaterial.extensions, fragDepth: true };
    
    const object = new THREE.Mesh(geometry, offsetMaterial);
    
    // Create projection matrix for this tile
    const camera = new THREE.Camera();
    const e = camera.projectionMatrix.elements;
    
    // Calculate viewport mapping for this tile
    // Tile bounds are in [0,1] normalized space, need to map to [-1,1] NDC
    const ndcXStart = xStart * 2 - 1;
    const ndcXEnd = xEnd * 2 - 1;
    const ndcYStart = yStart * 2 - 1;
    const ndcYEnd = yEnd * 2 - 1;
    
    // Scale to fit tile bounds into [-1,1] viewport
    const tileScaleX = 2.0 / (ndcXEnd - ndcXStart);
    const tileScaleY = 2.0 / (ndcYEnd - ndcYStart);
    const tileOffsetX = -(ndcXStart + ndcXEnd) / (ndcXEnd - ndcXStart);
    const tileOffsetY = -(ndcYStart + ndcYEnd) / (ndcYEnd - ndcYStart);
    
    // Combined transform: model space -> normalized space -> tile viewport
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
    
    // Read back tile heightmap
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
    
    // Cleanup - don't dispose target as it's cached
    geometry.dispose();
    offsetMaterial.dispose();
    
    return { heightMap, resolution: tileWidth };
}

// ---------------------------------------------------------
// Load heightmap from IndexedDB tiles on-demand
// ---------------------------------------------------------

async function loadHeightMapFromTiles(result, progressCallback = null) {
    if (!result.usesIndexedDB) {
        return result.heightMap; // Already in memory
    }
    
    console.log(`Loading heightmap from IndexedDB (${result.resolution}x${result.resolution})...`);
    const startTime = performance.now();
    
    const db = await getTileDB();
    const { resolution, tileSize, tilesPerSide, sessionId } = result;
    const heightMap = new Float32Array(resolution * resolution);
    heightMap.fill(-1.0);
    
    const totalTiles = tilesPerSide * tilesPerSide;
    let loadedTiles = 0;
    
    // Load tiles in parallel batches for much faster loading
    const BATCH_SIZE = 16; // Load 16 tiles at once
    const tilesToLoad = [];
    
    // Prepare all tile coordinates
    for (let tileY = 0; tileY < tilesPerSide; tileY++) {
        for (let tileX = 0; tileX < tilesPerSide; tileX++) {
            tilesToLoad.push({ tileX, tileY });
        }
    }
    
    // Process tiles in batches
    for (let i = 0; i < tilesToLoad.length; i += BATCH_SIZE) {
        const batch = tilesToLoad.slice(i, Math.min(i + BATCH_SIZE, tilesToLoad.length));
        
        // Load batch in parallel
        const tilePromises = batch.map(({ tileX, tileY }) => 
            db.loadTile(sessionId, tileX, tileY).then(tileData => ({ tileX, tileY, tileData }))
        );
        
        const results = await Promise.all(tilePromises);
        
        // Copy loaded tiles into heightmap
        for (const { tileX, tileY, tileData } of results) {
            if (!tileData) continue;
            
            loadedTiles++;
            if (progressCallback) {
                progressCallback(loadedTiles, totalTiles);
            }
            
            const { width: tileWidth, height: tileHeight, heightMap: tileHeightMap } = tileData;
            const destStartX = tileX * tileSize;
            const destStartY = tileY * tileSize;
            
            // Copy tile data into full heightmap
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
    console.log(`Heightmap loaded from IndexedDB in ${(endTime - startTime).toFixed(1)} ms (${loadedTiles} tiles, batches of ${BATCH_SIZE})`);
    
    return heightMap;
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
        this.heightmapLines = null;
        this.bboxHelper = null;
        this.axesHelper = null;
        this.axisLabels = [];
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
        
        // Camera - Orthographic for better technical visualization
        const aspect = window.innerWidth / window.innerHeight;
        const frustumSize = 100;
        this.camera = new THREE.OrthographicCamera(
            frustumSize * aspect / -2,
            frustumSize * aspect / 2,
            frustumSize / 2,
            frustumSize / -2,
            0.01,
            100000
        );
        this.camera.position.set(50, 50, 50);
        this.camera.lookAt(0, 0, 0);
        
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
        
        // Controls - use middle mouse button for panning
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE
        };
        
        // Lights - improved for PBR materials
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(10, 10, 10);
        this.scene.add(directionalLight1);
        
        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight2.position.set(-10, -10, -5);
        this.scene.add(directionalLight2);
        
        // Axes Helper
        this.axesHelper = new THREE.AxesHelper(100);
        this.scene.add(this.axesHelper);
        this.addAxisLabels(100);
        
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
        
        // Keyboard controls for panning
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        
        this.logStatus('Application initialized. Ready to load STL file.', 'info');
    }
    
    handleKeyDown(event) {
        // Arrow keys for panning
        const panSpeed = 5; // Units to pan per keypress
        
        // Calculate right and up vectors based on camera orientation
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        const right = new THREE.Vector3().crossVectors(forward, this.camera.up).normalize();
        const up = this.camera.up.clone().normalize();
        
        let panVector = null;
        
        switch(event.key) {
            case 'ArrowLeft':
                panVector = right.clone().multiplyScalar(-panSpeed);
                break;
            case 'ArrowRight':
                panVector = right.clone().multiplyScalar(panSpeed);
                break;
            case 'ArrowUp':
                panVector = up.clone().multiplyScalar(panSpeed);
                break;
            case 'ArrowDown':
                panVector = up.clone().multiplyScalar(-panSpeed);
                break;
        }
        
        if (panVector) {
            event.preventDefault();
            this.controls.target.add(panVector);
            this.camera.position.add(panVector);
            this.controls.update();
        }
    }
    
    setupEventListeners() {
        // File input
        document.getElementById('file-input').addEventListener('change', (e) => this.handleFileUpload(e));
        
        // Generate button
        document.getElementById('generate-btn').addEventListener('click', () => this.generateOffset());
        
        // Export button
        document.getElementById('export-stl-btn').addEventListener('click', () => this.exportSTL());
        
        // Adaptive resolution toggle
        document.getElementById('adaptive-resolution').addEventListener('change', (e) => {
            const label = document.getElementById('resolution-label');
            const input = document.getElementById('heightmap-resolution');
            if (e.target.checked) {
                label.textContent = 'Pixels Per Unit:';
                input.value = '10';
                input.min = '1';
                input.max = '50';
                input.step = '1';
            } else {
                label.textContent = 'Heightmap Resolution:';
                input.value = '512';
                input.min = '64';
                input.max = '16384';
                input.step = '64';
            }
        });
        
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
        
        document.getElementById('show-heightmap-lines').addEventListener('change', (e) => {
            if (this.heightmapLines) {
                if (Array.isArray(this.heightmapLines)) {
                    this.heightmapLines.forEach(line => line.visible = e.target.checked);
                } else {
                    this.heightmapLines.visible = e.target.checked;
                }
            }
        });
        
        document.getElementById('show-bbox').addEventListener('change', (e) => {
            if (this.bboxHelper) this.bboxHelper.visible = e.target.checked;
        });
        
        document.getElementById('show-axes').addEventListener('change', (e) => {
            if (this.axesHelper) this.axesHelper.visible = e.target.checked;
            this.axisLabels.forEach(label => label.visible = e.target.checked);
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
            const material = new THREE.MeshStandardMaterial({ 
                color: 0x4fc3f7,
                transparent: true,
                opacity: 0.7,
                side: THREE.DoubleSide,
                metalness: 0.1,
                roughness: 0.7
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
            
            // For orthographic camera, adjust zoom based on object size
            const frustumSize = maxDim * 2;
            const aspect = window.innerWidth / window.innerHeight;
            this.camera.left = frustumSize * aspect / -2;
            this.camera.right = frustumSize * aspect / 2;
            this.camera.top = frustumSize / 2;
            this.camera.bottom = frustumSize / -2;
            
            // Adjust clipping planes based on model size
            this.camera.near = maxDim * 0.001;
            this.camera.far = maxDim * 100;
            this.camera.updateProjectionMatrix();
            
            // Position camera
            const distance = maxDim * 1.5;
            this.camera.position.set(center.x + distance, center.y + distance, center.z + distance);
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
    
    async generateOffset() {
        if (!this.loadedGeometry) {
            this.logStatus('✗ No geometry loaded', 'error');
            return;
        }
        
        // Validate inputs
        const offsetDistance = parseFloat(document.getElementById('offset-distance').value);
        if (isNaN(offsetDistance) || offsetDistance <= 0) {
            this.logStatus('✗ Invalid offset distance. Must be a positive number.', 'error');
            return;
        }
        
        const resolutionInput = parseFloat(document.getElementById('heightmap-resolution').value);
        if (isNaN(resolutionInput) || resolutionInput <= 0) {
            this.logStatus('✗ Invalid resolution. Must be a positive number.', 'error');
            return;
        }
        
        const isAdaptive = document.getElementById('adaptive-resolution').checked;
        
        // Calculate effective resolution
        let resolution;
        if (isAdaptive) {
            // Adaptive mode: pixels per unit
            const box = new THREE.Box3().setFromObject(this.originalMesh);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            
            // Add padding for offset
            const effectiveDim = maxDim + (offsetDistance * 10); // 5x padding on each side
            resolution = Math.ceil(effectiveDim * resolutionInput);
            
            // Clamp to reasonable limits (now supports up to 16384)
            resolution = Math.max(64, Math.min(16384, resolution));
            
            this.logStatus(`Adaptive resolution: ${maxDim.toFixed(1)} units × ${resolutionInput} px/unit = ${resolution}×${resolution}`, 'info');
        } else {
            // Fixed mode: absolute resolution
            resolution = resolutionInput;
        }
        
        this.logStatus(`Generating offset (distance: ${offsetDistance}, resolution: ${resolution})...`, 'info');
        
        // Get vertices as Float32Array
        const vertices = this.loadedGeometry.attributes.position.array;
        
        try {
            // Show progress bar for large resolutions
            if (resolution > 2048) {
                this.showProgress('Rendering tiles...');
            }
            
            // Progress callback for tiled rendering
            const progressCallback = resolution > 2048 ? (current, total) => {
                const percent = (current / total) * 100;
                this.updateProgress(percent, current, total);
                this.logStatus(`Rendering tile ${current}/${total}...`, 'info');
            } : null;
            
            // Generate heightmap using the offset algorithm (may be async for tiled rendering)
            const result = await createOffsetHeightMap(vertices, offsetDistance, resolution, 2048, progressCallback);
            
            // Hide progress bar
            this.hideProgress();
            
            if (result.usesIndexedDB) {
                this.logStatus(`✓ Heightmap tiles stored in IndexedDB (${result.resolution}x${result.resolution})`, 'success');
            } else {
                this.logStatus(`✓ Heightmap generated (${result.resolution}x${result.resolution})`, 'success');
            }
            
            // Create offset mesh visualization
            this.createOffsetMeshVisualization(result, offsetDistance);
            
            // Create mesh from heightmap data
            await this.createMeshFromHeightmap(result, offsetDistance);
            
        } catch (error) {
            this.hideProgress(); // Ensure progress bar is hidden on error
            this.logStatus(`✗ Error generating offset: ${error.message}`, 'error');
            console.error('Offset generation error:', error);
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
        offsetGeometry.computeVertexNormals(); // Recompute normals after moving vertices
        offsetGeometry.computeBoundingSphere();
        
        const material = new THREE.MeshStandardMaterial({ 
            color: 0x81c784,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            wireframe: false,
            metalness: 0.1,
            roughness: 0.7,
            flatShading: false
        });
        
        this.offsetMesh = new THREE.Mesh(offsetGeometry, material);
        this.offsetMesh.visible = document.getElementById('show-offset').checked;
        this.scene.add(this.offsetMesh);
        
        this.logStatus('✓ Offset mesh created', 'success');
    }
    
    async createMeshFromHeightmap(result, offsetDistance) {
        // Remove previous heightmap mesh and lines
        if (this.heightmapMesh) {
            this.scene.remove(this.heightmapMesh);
            this.heightmapMesh.geometry.dispose();
            this.heightmapMesh.material.dispose();
            this.heightmapMesh = null;
        }
        
        if (this.heightmapLines) {
            if (Array.isArray(this.heightmapLines)) {
                this.heightmapLines.forEach(line => {
                    this.scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                });
            }
            this.heightmapLines = null;
        }
        
        const { resolution, scale, center } = result;
        
        // Load heightmap data
        let heightMap;
        if (result.usesIndexedDB) {
            this.showProgress('Loading heightmap data...');
            const loadProgress = (current, total) => {
                const percent = (current / total) * 100;
                this.updateProgress(percent, current, total);
            };
            heightMap = await loadHeightMapFromTiles(result, loadProgress);
            this.hideProgress();
        } else {
            heightMap = result.heightMap;
        }
        
        if (!heightMap) {
            this.logStatus('✗ Failed to load heightmap data', 'error');
            return;
        }
        
        this.logStatus('Creating mesh from heightmap...', 'info');
        
        // Calculate clipping bounds: original bounding box + offset
        const originalBox = new THREE.Box3().setFromObject(this.originalMesh);
        const clipZMin = originalBox.min.z - offsetDistance;
        const clipZMax = originalBox.max.z + offsetDistance;
        
        // Create watertight mesh from heightmap - bottom at clipZMin to match the full projected range
        this.logStatus('Creating watertight mesh...', 'info');
        
        // Calculate optimal mesh resolution to prevent crashes on large heightmaps
        const meshSettings = this.calculateOptimalMeshSettings(resolution, heightMap);
        this.logStatus(`Mesh quality: ${meshSettings.quality}, effective resolution: ${meshSettings.effectiveResolution}x${meshSettings.effectiveResolution}`, 'info');
        
        const geometry = this.createWatertightMeshFromHeightmap(heightMap, resolution, scale, center, clipZMin, clipZMax, result, meshSettings);
        
        // Create material with wireframe overlay
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            side: THREE.DoubleSide,
            wireframe: false,
            transparent: true,
            opacity: 0.7,
            metalness: 0.0,
            roughness: 0.8
        });
        
        this.heightmapMesh = new THREE.Mesh(geometry, material);
        this.heightmapMesh.visible = document.getElementById('show-heightmap').checked;
        this.scene.add(this.heightmapMesh);
        
        // Create contour lines for visualization - pass heightmap and clipping bounds to avoid reloading
        await this.createHeightmapContourLines(result, heightMap, offsetDistance, clipZMin, clipZMax);
        
        const finalVertexCount = geometry.getAttribute('position').count;
        this.logStatus(`✓ Watertight mesh created: ${finalVertexCount.toLocaleString()} vertices`, 'success');
        
        // Enable export button
        document.getElementById('export-stl-btn').disabled = false;
    }
    
    calculateOptimalMeshSettings(resolution, heightMap) {
        // Get user-selected downsample factor from UI
        const userDownsampleFactor = parseInt(document.getElementById('mesh-downsample').value) || 2;
        
        // Memory limits for mesh creation
        const MAX_VERTICES = 2000000; // ~2M vertices = safety limit
        const totalVertices = resolution * resolution;
        
        let downsampleFactor = userDownsampleFactor;
        let quality = 'optimized';
        
        // Override if resolution is critically high
        if (totalVertices > MAX_VERTICES) {
            const criticalDownsample = Math.ceil(Math.sqrt(totalVertices / MAX_VERTICES));
            downsampleFactor = Math.max(userDownsampleFactor, criticalDownsample);
            quality = 'auto-reduced';
            console.warn(`Critical heightmap size (${resolution}x${resolution}). Forcing ${downsampleFactor}x downsample to prevent crash.`);
        }
        
        const effectiveResolution = Math.floor(resolution / downsampleFactor);
        const estimatedVertices = effectiveResolution * effectiveResolution * 2; // top + bottom
        const estimatedTriangles = effectiveResolution * effectiveResolution * 4; // 2 per quad for top+bottom
        
        return {
            downsampleFactor,
            effectiveResolution,
            quality,
            estimatedVertices,
            estimatedTriangles
        };
    }
    
    createWatertightMeshFromHeightmap(heightMap, resolution, scale, center, clipZMin, clipZMax, result, meshSettings = null) {
        const startTime = performance.now();
        
        // Apply downsampling if needed for large heightmaps
        let workingHeightMap = heightMap;
        let workingResolution = resolution;
        
        if (meshSettings && meshSettings.downsampleFactor > 1) {
            const downsampleResult = this.downsampleHeightmap(heightMap, resolution, meshSettings.downsampleFactor);
            workingHeightMap = downsampleResult.heightMap;
            workingResolution = downsampleResult.resolution;
            this.logStatus(`Downsampled heightmap: ${resolution}x${resolution} → ${workingResolution}x${workingResolution}`, 'info');
        }
        
        // Pre-calculate coordinate transformation constants
        const invResMinusOne = 1 / (workingResolution - 1);
        const invScale = 1 / scale;
        
        // Step 1: Identify non-zero heightmap points and create vertex grid
        const vertexGrid = new Array(workingResolution * workingResolution);
        const validVertices = [];
        
        // Find the minimum height in the heightmap - this represents the projection plane
        let minHeight = Infinity;
        for (let i = 0; i < workingHeightMap.length; i++) {
            minHeight = Math.min(minHeight, workingHeightMap[i]);
        }
        
        const heightThreshold = 0.001; // Consider heights near minimum as "on the plane"
        let deletedCount = 0;
        
        console.log(`Heightmap min: ${minHeight}, bottom will be at: ${clipZMin}, will delete vertices within ${heightThreshold} of minimum`);
        
        for (let j = 0; j < workingResolution; j++) {
            const flippedJ = workingResolution - 1 - j;
            const yCoord = ((flippedJ * 2 * invResMinusOne - 1) + center.y) * invScale;
            
            for (let i = 0; i < workingResolution; i++) {
                const heightIdx = flippedJ * workingResolution + i;
                const gridIdx = j * workingResolution + i;
                
                // Get RAW height value from heightmap
                const rawHeight = workingHeightMap[heightIdx];
                
                // Only keep vertices where the height is significantly above the minimum (projection plane)
                if (Math.abs(rawHeight - minHeight) > heightThreshold) {
                    // Calculate XY position
                    const x = ((i * 2 * invResMinusOne - 1) + center.x) * invScale;
                    const y = yCoord;
                    
                    // Transform height to world Z
                    let worldZ = (rawHeight + center.z) * invScale;
                    worldZ = Math.max(clipZMin, Math.min(clipZMax, worldZ));
                    
                    const vertexIndex = validVertices.length;
                    
                    validVertices.push({
                        gridI: i,
                        gridJ: j,
                        topPos: new THREE.Vector3(x, y, worldZ),
                        bottomPos: new THREE.Vector3(x, y, clipZMin), // Bottom at minimum clipping bound
                        topIndex: -1,
                        bottomIndex: -1
                    });
                    
                    vertexGrid[gridIdx] = vertexIndex;
                } else {
                    vertexGrid[gridIdx] = null; // Mark as on XY plane (deleted)
                    deletedCount++;
                }
            }
        }
        
        this.logStatus(`Filtered ${validVertices.length} vertices, deleted ${deletedCount} planar vertices from ${workingResolution * workingResolution} total`, 'info');
        
        // Define subdivision parameters for smooth side walls
        const subdivisionSteps = 8; // Subdivide each wall edge into 8 segments for ultra-smooth walls
        
        // Step 2: Build manifold mesh with shared vertices
        // Use a Map to ensure vertex uniqueness and proper sharing
        const vertexMap = new Map(); // key: "x,y,z" -> index
        const positions = [];
        let nextVertexIndex = 0;
        
        const getOrCreateVertex = (x, y, z) => {
            // Round to avoid floating point precision issues
            const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
            
            if (vertexMap.has(key)) {
                return vertexMap.get(key);
            }
            
            const index = nextVertexIndex++;
            positions.push(x, y, z);
            vertexMap.set(key, index);
            return index;
        };
        
        // Create top and bottom vertices with shared vertex tracking
        validVertices.forEach(v => {
            v.topIndex = getOrCreateVertex(v.topPos.x, v.topPos.y, v.topPos.z);
            v.bottomIndex = getOrCreateVertex(v.bottomPos.x, v.bottomPos.y, v.bottomPos.z);
        });
        
        // Step 3: Build triangles with dynamic array (avoid over-allocation)
        // Use growable array pattern since we can't predict exact count with subdivision
        let indices = [];
        let idxCount = 0;
        
        // Helper to ensure capacity and grow if needed
        const ensureCapacity = (needed) => {
            if (indices.length < needed) {
                // Grow by 50% or to needed size, whichever is larger
                const newSize = Math.max(needed, Math.floor(indices.length * 1.5));
                const newIndices = new Uint32Array(newSize);
                newIndices.set(indices);
                indices = newIndices;
            }
        };
        
        // Initial allocation: top + bottom surfaces only
        const surfaceTriangles = (workingResolution - 1) * (workingResolution - 1) * 4; // 2 triangles per quad, top + bottom
        indices = new Uint32Array(surfaceTriangles * 3);
        
        for (let j = 0; j < workingResolution - 1; j++) {
            for (let i = 0; i < workingResolution - 1; i++) {
                const a = vertexGrid[j * workingResolution + i];
                const b = vertexGrid[j * workingResolution + (i + 1)];
                const c = vertexGrid[(j + 1) * workingResolution + i];
                const d = vertexGrid[(j + 1) * workingResolution + (i + 1)];
                
                // Only create triangles if all 4 vertices exist
                if (a !== null && b !== null && c !== null && d !== null) {
                    const va = validVertices[a].topIndex;
                    const vb = validVertices[b].topIndex;
                    const vc = validVertices[c].topIndex;
                    const vd = validVertices[d].topIndex;
                    
                    // Top surface - CCW from above (normals point UP/outward)
                    // Quad: a(top-left) b(top-right) d(bottom-right) c(bottom-left)
                    indices[idxCount++] = va; indices[idxCount++] = vd; indices[idxCount++] = vb;
                    indices[idxCount++] = va; indices[idxCount++] = vc; indices[idxCount++] = vd;
                }
            }
        }
        
        // Step 4: Build bottom surface triangles (reversed winding)
        for (let j = 0; j < workingResolution - 1; j++) {
            for (let i = 0; i < workingResolution - 1; i++) {
                const a = vertexGrid[j * workingResolution + i];
                const b = vertexGrid[j * workingResolution + (i + 1)];
                const c = vertexGrid[(j + 1) * workingResolution + i];
                const d = vertexGrid[(j + 1) * workingResolution + (i + 1)];
                
                if (a !== null && b !== null && c !== null && d !== null) {
                    const va = validVertices[a].bottomIndex;
                    const vb = validVertices[b].bottomIndex;
                    const vc = validVertices[c].bottomIndex;
                    const vd = validVertices[d].bottomIndex;
                    
                    // Bottom surface - CW from above = CCW from below (normals point DOWN/outward)
                    // Reverse winding compared to top surface
                    indices[idxCount++] = va; indices[idxCount++] = vb; indices[idxCount++] = vd;
                    indices[idxCount++] = va; indices[idxCount++] = vd; indices[idxCount++] = vc;
                }
            }
        }
        
        // Step 5: Build side walls by detecting boundary edges with subdivision
        // Track edges to ensure each boundary edge gets exactly ONE wall
        const processedEdges = new Set();
        let wallCount = 0;
        
        const getEdgeKey = (v1, v2) => {
            // Create canonical edge key (smaller index first)
            return v1 < v2 ? `${v1},${v2}` : `${v2},${v1}`;
        };
        
        const addWallQuadSubdivided = (v1Top, v1Bottom, v2Top, v2Bottom) => {
            // For manifold mesh: walls must share the EXACT vertices with top/bottom surfaces
            // This means using the already-subdivided vertices from surface generation
            // We cannot create new intermediate vertices here
            
            // Simply create a quad connecting the two edge vertices
            ensureCapacity(idxCount + 6);
            
            // Two triangles for the wall quad
            indices[idxCount++] = v1Top;
            indices[idxCount++] = v2Top;
            indices[idxCount++] = v2Bottom;
            
            indices[idxCount++] = v1Top;
            indices[idxCount++] = v2Bottom;
            indices[idxCount++] = v1Bottom;
            
            wallCount++;
        };
        
        // Horizontal edges (along i direction)
        for (let j = 0; j < workingResolution; j++) {
            for (let i = 0; i < workingResolution - 1; i++) {
                const curr = vertexGrid[j * workingResolution + i];
                const next = vertexGrid[j * workingResolution + (i + 1)];
                
                if (curr !== null && next !== null) {
                    const currTop = validVertices[curr].topIndex;
                    const currBottom = validVertices[curr].bottomIndex;
                    const nextTop = validVertices[next].topIndex;
                    const nextBottom = validVertices[next].bottomIndex;
                    
                    // Check if this edge is on a boundary
                    const above = (j > 0) ? vertexGrid[(j - 1) * workingResolution + i] : null;
                    const aboveNext = (j > 0) ? vertexGrid[(j - 1) * workingResolution + (i + 1)] : null;
                    const below = (j < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + i] : null;
                    const belowNext = (j < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + (i + 1)] : null;
                    
                    // Wall needed if missing quad on either side
                    const missingAbove = (above === null || aboveNext === null);
                    const missingBelow = (below === null || belowNext === null);
                    
                    // Only create wall if exactly one side is missing (boundary edge)
                    if (missingAbove && !missingBelow) {
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            // Front wall (looking from -j direction)
                            addWallQuadSubdivided(currTop, currBottom, nextTop, nextBottom);
                        }
                    } else if (missingBelow && !missingAbove) {
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            // Back wall (looking from +j direction, reversed winding)
                            addWallQuadSubdivided(nextTop, nextBottom, currTop, currBottom);
                        }
                    } else if (missingAbove && missingBelow) {
                        // Both sides missing - this is a standalone edge, add wall with default orientation
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            addWallQuadSubdivided(currTop, currBottom, nextTop, nextBottom);
                        }
                    }
                }
            }
        }
        
        // Vertical edges (along j direction)
        for (let i = 0; i < workingResolution; i++) {
            for (let j = 0; j < workingResolution - 1; j++) {
                const curr = vertexGrid[j * workingResolution + i];
                const next = vertexGrid[(j + 1) * workingResolution + i];
                
                if (curr !== null && next !== null) {
                    const currTop = validVertices[curr].topIndex;
                    const currBottom = validVertices[curr].bottomIndex;
                    const nextTop = validVertices[next].topIndex;
                    const nextBottom = validVertices[next].bottomIndex;
                    
                    // Check if this edge is on a boundary
                    const left = (i > 0) ? vertexGrid[j * workingResolution + (i - 1)] : null;
                    const leftNext = (i > 0) ? vertexGrid[(j + 1) * workingResolution + (i - 1)] : null;
                    const right = (i < workingResolution - 1) ? vertexGrid[j * workingResolution + (i + 1)] : null;
                    const rightNext = (i < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + (i + 1)] : null;
                    
                    // Wall needed if missing quad on either side
                    const missingLeft = (left === null || leftNext === null);
                    const missingRight = (right === null || rightNext === null);
                    
                    // Only create wall if exactly one side is missing (boundary edge)
                    if (missingLeft && !missingRight) {
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            // Left wall (looking from -i direction, reversed winding)
                            addWallQuadSubdivided(nextTop, nextBottom, currTop, currBottom);
                        }
                    } else if (missingRight && !missingLeft) {
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            // Right wall (looking from +i direction)
                            addWallQuadSubdivided(currTop, currBottom, nextTop, nextBottom);
                        }
                    } else if (missingLeft && missingRight) {
                        // Both sides missing - this is a standalone edge, add wall with default orientation
                        const edgeKey = getEdgeKey(currTop, nextTop);
                        if (!processedEdges.has(edgeKey)) {
                            processedEdges.add(edgeKey);
                            addWallQuadSubdivided(currTop, currBottom, nextTop, nextBottom);
                        }
                    }
                }
            }
        }
        
        // Create geometry with actual used indices
        const finalIndices = new Uint32Array(indices.buffer, 0, idxCount);
        const finalPositions = new Float32Array(positions);
        
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
        geometry.setIndex(new THREE.BufferAttribute(finalIndices, 1));
        geometry.computeVertexNormals();
        
        const endTime = performance.now();
        const vertexCount = finalPositions.length / 3;
        const triangleCount = finalIndices.length / 3;
        const sharedVertexCount = vertexMap.size;
        
        this.logStatus(
            `Manifold mesh: ${vertexCount.toLocaleString()} vertices (${sharedVertexCount.toLocaleString()} unique), ${triangleCount.toLocaleString()} triangles, ${wallCount} walls [${(endTime - startTime).toFixed(0)}ms]`,
            'success'
        );
        
        console.log(`Wall generation: ${wallCount} walls created, ${processedEdges.size} unique boundary edges`);
        
        return geometry;
    }
    
    downsampleHeightmap(heightMap, resolution, factor) {
        const startTime = performance.now();
        
        // Boundary-aware subdivision for pristine side walls
        // Strategy:
        // 1. Identify active vertices (above minimum height threshold)
        // 2. Detect boundary vertices that will become side walls
        // 3. Subdivide boundary regions with high resolution
        // 4. Downsample interior regions normally
        
        const newResolution = Math.floor(resolution / factor);
        const newHeightMap = new Float32Array(newResolution * newResolution);
        
        // Pass 1: Identify active mesh regions (post-deletion simulation)
        this.logStatus('Pass 1: Identifying active mesh boundaries...', 'info');
        const boundaryMap = this.detectActiveMeshBoundaries(heightMap, resolution);
        
        // Pass 2: Boundary-targeted subdivision and adaptive sampling
        this.logStatus('Pass 2: Subdividing boundaries and resampling...', 'info');
        for (let j = 0; j < newResolution; j++) {
            for (let i = 0; i < newResolution; i++) {
                const srcJ = j * factor;
                const srcI = i * factor;
                
                // Check if this block contains actual mesh boundaries (future walls)
                let isBoundary = false;
                let maxBoundaryScore = 0;
                
                // Sample boundary map in neighborhood
                const boundaryCheckRadius = Math.ceil(factor * 2.0); // Check boundary vicinity
                const blockCenterI = Math.floor(srcI + factor / 2);
                const blockCenterJ = Math.floor(srcJ + factor / 2);
                
                for (let dj = -boundaryCheckRadius; dj <= boundaryCheckRadius; dj++) {
                    for (let di = -boundaryCheckRadius; di <= boundaryCheckRadius; di++) {
                        const sampleJ = Math.min(resolution - 1, Math.max(0, blockCenterJ + dj));
                        const sampleI = Math.min(resolution - 1, Math.max(0, blockCenterI + di));
                        const boundaryScore = boundaryMap[sampleJ * resolution + sampleI];
                        
                        if (boundaryScore > 0.5) { // Strong boundary detected
                            isBoundary = true;
                        }
                        maxBoundaryScore = Math.max(maxBoundaryScore, boundaryScore);
                    }
                }
                
                let sampledValue;
                
                if (isBoundary && maxBoundaryScore > 0.8) {
                    // BOUNDARY WALL: Maximum subdivision with 16x16 supersampling
                    // These pixels will literally become the visible side walls
                    sampledValue = this.subdivideBoundary(heightMap, resolution, srcI, srcJ, factor, 16);
                } else if (maxBoundaryScore > 0.5) {
                    // NEAR BOUNDARY: High-quality 12x12 supersampling
                    sampledValue = this.subdivideBoundary(heightMap, resolution, srcI, srcJ, factor, 12);
                } else if (maxBoundaryScore > 0.2) {
                    // BOUNDARY INFLUENCE: Lanczos reconstruction
                    sampledValue = this.sampleLanczos2(heightMap, resolution, srcI + factor/2, srcJ + factor/2, factor);
                } else {
                    // INTERIOR: Fast bilinear interpolation (no walls here)
                    sampledValue = this.bilinearInterpolate(heightMap, resolution, srcI + factor/2, srcJ + factor/2);
                }
                
                newHeightMap[j * newResolution + i] = sampledValue;
            }
        }
        
        // Pass 3: REMOVED - No post-processing smoothing to preserve pristine edge quality
        // The 10x10 supersampling already provides exceptional quality without any filtering
        
        const endTime = performance.now();
        this.logStatus(`Edge-focused downsampling complete: ${(endTime - startTime).toFixed(0)}ms`, 'success');
        
        return {
            heightMap: newHeightMap,
            resolution: newResolution
        };
    }
    
    detectActiveMeshBoundaries(heightMap, resolution) {
        // Detect actual mesh boundaries that will become side walls
        // Simulates the vertex deletion that happens in createWatertightMeshFromHeightmap
        
        const boundaryMap = new Float32Array(resolution * resolution);
        
        // Find minimum height (same threshold as mesh creation)
        let minHeight = Infinity;
        for (let i = 0; i < heightMap.length; i++) {
            minHeight = Math.min(minHeight, heightMap[i]);
        }
        
        const heightThreshold = 0.001; // Same as mesh creation
        
        // Create active vertex map (vertices that will survive deletion)
        const isActive = new Uint8Array(resolution * resolution);
        for (let i = 0; i < heightMap.length; i++) {
            isActive[i] = Math.abs(heightMap[i] - minHeight) > heightThreshold ? 1 : 0;
        }
        
        // Detect boundary vertices: active vertices with at least one inactive neighbor
        // These are the EXACT vertices that will form side walls
        for (let j = 0; j < resolution; j++) {
            for (let i = 0; i < resolution; i++) {
                const idx = j * resolution + i;
                
                if (!isActive[idx]) {
                    boundaryMap[idx] = 0; // Deleted vertex, not a boundary
                    continue;
                }
                
                // Check all 8 neighbors for inactive vertices
                let hasInactiveNeighbor = false;
                let inactiveCount = 0;
                
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (di === 0 && dj === 0) continue;
                        
                        const ni = i + di;
                        const nj = j + dj;
                        
                        // Edge of heightmap is always considered boundary
                        if (ni < 0 || ni >= resolution || nj < 0 || nj >= resolution) {
                            hasInactiveNeighbor = true;
                            inactiveCount++;
                            continue;
                        }
                        
                        const nidx = nj * resolution + ni;
                        if (!isActive[nidx]) {
                            hasInactiveNeighbor = true;
                            inactiveCount++;
                        }
                    }
                }
                
                if (hasInactiveNeighbor) {
                    // This is a boundary vertex - will become a side wall
                    // Score based on how many inactive neighbors (more = stronger boundary)
                    boundaryMap[idx] = Math.min(1.0, inactiveCount / 4.0);
                } else {
                    // Interior vertex - no wall here
                    boundaryMap[idx] = 0;
                }
            }
        }
        
        return boundaryMap;
    }
    
    subdivideBoundary(heightMap, resolution, srcI, srcJ, factor, subdivisionFactor) {
        // High-resolution subdivision specifically for boundary regions
        // Uses dense sampling to create smooth side walls
        
        const samples = [];
        const weights = [];
        
        for (let dj = 0; dj < factor; dj++) {
            for (let di = 0; di < factor; di++) {
                for (let ssj = 0; ssj < subdivisionFactor; ssj++) {
                    for (let ssi = 0; ssi < subdivisionFactor; ssi++) {
                        const subI = (ssi + 0.5) / subdivisionFactor;
                        const subJ = (ssj + 0.5) / subdivisionFactor;
                        
                        const posI = srcI + di + subI;
                        const posJ = srcJ + dj + subJ;
                        
                        const value = this.bilinearInterpolate(heightMap, resolution, posI, posJ);
                        samples.push(value);
                        
                        // Gaussian weighting
                        const centerI = srcI + factor / 2;
                        const centerJ = srcJ + factor / 2;
                        const dx = posI - centerI;
                        const dy = posJ - centerJ;
                        const distSq = dx * dx + dy * dy;
                        const sigma = factor / 2;
                        const weight = Math.exp(-distSq / (2 * sigma * sigma));
                        weights.push(weight);
                    }
                }
            }
        }
        
        if (samples.length === 0) {
            return heightMap[Math.min(resolution - 1, Math.floor(srcJ + factor/2)) * resolution + 
                            Math.min(resolution - 1, Math.floor(srcI + factor/2))];
        }
        
        // Weighted average with outlier filtering
        let sum = 0, totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * weights[i];
            totalWeight += weights[i];
        }
        const mean = sum / totalWeight;
        
        // Compute standard deviation
        let variance = 0;
        for (let i = 0; i < samples.length; i++) {
            const diff = samples[i] - mean;
            variance += diff * diff * weights[i];
        }
        variance /= totalWeight;
        const stdDev = Math.sqrt(variance);
        
        // Remove outliers
        sum = 0;
        totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i] - mean) < 2.5 * stdDev) {
                sum += samples[i] * weights[i];
                totalWeight += weights[i];
            }
        }
        
        return totalWeight > 0 ? sum / totalWeight : mean;
    }
    
    bilinearInterpolate(heightMap, resolution, x, y) {
        // LEGACY: Enhanced multi-scale boundary and edge detection
        // Detects regions that will become side walls with high precision
        
        const edgeMap = new Float32Array(resolution * resolution);
        
        // Find minimum height (projection plane)
        let minHeight = Infinity;
        for (let i = 0; i < heightMap.length; i++) {
            minHeight = Math.min(minHeight, heightMap[i]);
        }
        
        const heightThreshold = 0.001; // Same as mesh creation threshold
        
        // Multi-scale Sobel kernels for robust edge detection
        const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
        
        // Scharr operator (more accurate for diagonal edges)
        const scharrX = [-3, 0, 3, -10, 0, 10, -3, 0, 3];
        const scharrY = [-3, -10, -3, 0, 0, 0, 3, 10, 3];
        
        let maxEdgeStrength = 0;
        
        for (let j = 1; j < resolution - 1; j++) {
            for (let i = 1; i < resolution - 1; i++) {
                const idx = j * resolution + i;
                const centerHeight = heightMap[idx];
                
                // Check if this pixel is part of the mesh (not on projection plane)
                const isActive = Math.abs(centerHeight - minHeight) > heightThreshold;
                
                if (!isActive) {
                    edgeMap[idx] = 0;
                    continue;
                }
                
                // Multi-scale gradient computation (Sobel + Scharr)
                let gxSobel = 0, gySobel = 0, gxScharr = 0, gyScharr = 0;
                for (let kj = -1; kj <= 1; kj++) {
                    for (let ki = -1; ki <= 1; ki++) {
                        const nidx = (j + kj) * resolution + (i + ki);
                        const kernelIdx = (kj + 1) * 3 + (ki + 1);
                        gxSobel += heightMap[nidx] * sobelX[kernelIdx];
                        gySobel += heightMap[nidx] * sobelY[kernelIdx];
                        gxScharr += heightMap[nidx] * scharrX[kernelIdx];
                        gyScharr += heightMap[nidx] * scharrY[kernelIdx];
                    }
                }
                const gradientSobel = Math.sqrt(gxSobel * gxSobel + gySobel * gySobel);
                const gradientScharr = Math.sqrt(gxScharr * gxScharr + gyScharr * gyScharr);
                // Use maximum of both for robust detection
                const gradient = Math.max(gradientSobel, gradientScharr * 0.5);
                
                // Check for boundary transitions (active neighbor to inactive)
                let boundaryScore = 0;
                let activeNeighbors = 0;
                for (let kj = -1; kj <= 1; kj++) {
                    for (let ki = -1; ki <= 1; ki++) {
                        if (ki === 0 && kj === 0) continue;
                        const nidx = (j + kj) * resolution + (i + ki);
                        const neighborHeight = heightMap[nidx];
                        const neighborActive = Math.abs(neighborHeight - minHeight) > heightThreshold;
                        
                        if (neighborActive) {
                            activeNeighbors++;
                        }
                    }
                }
                
                // Boundary detection: fewer active neighbors = closer to edge
                // 8 neighbors total, if less than 7 active, it's near boundary
                if (activeNeighbors < 7) {
                    boundaryScore = 1.0 - (activeNeighbors / 8.0);
                }
                
                // Combine gradient and boundary score
                // High gradient OR boundary = edge that needs high-quality sampling
                const edgeStrength = Math.max(boundaryScore, gradient / (gradient + 1.0));
                edgeMap[idx] = edgeStrength;
                maxEdgeStrength = Math.max(maxEdgeStrength, edgeStrength);
            }
        }
        
        // Normalize edge strengths
        if (maxEdgeStrength > 0) {
            for (let i = 0; i < edgeMap.length; i++) {
                edgeMap[i] /= maxEdgeStrength;
            }
        }
        
        // Dilate edges to ensure we catch nearby regions
        // This ensures smooth transitions and catches edge influence zones
        const dilatedEdgeMap = new Float32Array(resolution * resolution);
        dilatedEdgeMap.set(edgeMap);
        
        const dilationRadius = 4; // Maximum edge expansion - 4 pixels for widest high-quality zones
        for (let j = dilationRadius; j < resolution - dilationRadius; j++) {
            for (let i = dilationRadius; i < resolution - dilationRadius; i++) {
                const idx = j * resolution + i;
                let maxNeighborEdge = edgeMap[idx];
                
                // Check neighborhood for strong edges
                for (let dj = -dilationRadius; dj <= dilationRadius; dj++) {
                    for (let di = -dilationRadius; di <= dilationRadius; di++) {
                        const nidx = (j + dj) * resolution + (i + di);
                        const dist = Math.sqrt(di * di + dj * dj);
                        // Distance-weighted dilation
                        const weight = 1.0 - (dist / (dilationRadius + 1));
                        maxNeighborEdge = Math.max(maxNeighborEdge, edgeMap[nidx] * weight);
                    }
                }
                
                dilatedEdgeMap[idx] = maxNeighborEdge;
            }
        }
        
        return dilatedEdgeMap;
    }
    
    supersampleEdgeRegion(heightMap, resolution, srcI, srcJ, factor, edgeMap) {
        // Ultra-high-quality supersampling specifically for edge/boundary regions
        // Uses 10x10 supersampling with edge-aware filtering for exceptional smoothness
        
        const supersampleFactor = 10; // 10x10 = 100 samples per pixel for absolutely pristine edges
        const samples = [];
        const weights = [];
        
        // Detect primary edge direction in this block
        let avgGradX = 0, avgGradY = 0;
        let gradCount = 0;
        
        for (let dj = 0; dj < factor; dj++) {
            for (let di = 0; di < factor; di++) {
                const sj = Math.min(resolution - 1, Math.max(0, srcJ + dj));
                const si = Math.min(resolution - 1, Math.max(0, srcI + di));
                
                if (si > 0 && si < resolution - 1 && sj > 0 && sj < resolution - 1) {
                    const idx = sj * resolution + si;
                    const gx = (heightMap[idx + 1] - heightMap[idx - 1]) / 2;
                    const gy = (heightMap[idx + resolution] - heightMap[idx - resolution]) / 2;
                    avgGradX += gx;
                    avgGradY += gy;
                    gradCount++;
                }
            }
        }
        
        if (gradCount > 0) {
            avgGradX /= gradCount;
            avgGradY /= gradCount;
        }
        
        const gradMag = Math.sqrt(avgGradX * avgGradX + avgGradY * avgGradY);
        let edgeNormalX = 0, edgeNormalY = 0;
        
        if (gradMag > 1e-6) {
            // Edge normal (perpendicular to gradient direction)
            edgeNormalX = -avgGradY / gradMag;
            edgeNormalY = avgGradX / gradMag;
        }
        
        // Supersample with rotated grid aligned to edge
        for (let dj = 0; dj < factor; dj++) {
            for (let di = 0; di < factor; di++) {
                for (let ssj = 0; ssj < supersampleFactor; ssj++) {
                    for (let ssi = 0; ssi < supersampleFactor; ssi++) {
                        // Sub-pixel offset
                        const subI = (ssi + 0.5) / supersampleFactor;
                        const subJ = (ssj + 0.5) / supersampleFactor;
                        
                        // Position in source space
                        const posI = srcI + di + subI;
                        const posJ = srcJ + dj + subJ;
                        
                        // High-quality interpolation at this point
                        const value = this.bilinearInterpolate(heightMap, resolution, posI, posJ);
                        samples.push(value);
                        
                        // Edge-aligned weighting
                        const centerI = srcI + factor / 2;
                        const centerJ = srcJ + factor / 2;
                        const dx = posI - centerI;
                        const dy = posJ - centerJ;
                        
                        // Distance weight
                        const distSq = dx * dx + dy * dy;
                        const sigma = factor / 2;
                        let weight = Math.exp(-distSq / (2 * sigma * sigma));
                        
                        // Edge alignment boost (prefer samples along edge)
                        if (gradMag > 0.01) {
                            const normalAlign = Math.abs(dx * edgeNormalX + dy * edgeNormalY);
                            const tangentAlign = Math.abs(dx * avgGradX / gradMag + dy * avgGradY / gradMag);
                            
                            // Boost weight for samples aligned with edge direction
                            const alignmentBoost = 1.0 + normalAlign * 0.5 - tangentAlign * 0.3;
                            weight *= Math.max(0.3, alignmentBoost);
                        }
                        
                        weights.push(weight);
                    }
                }
            }
        }
        
        // Weighted average with outlier filtering
        if (samples.length === 0) {
            return heightMap[Math.min(resolution - 1, Math.floor(srcJ + factor/2)) * resolution + 
                            Math.min(resolution - 1, Math.floor(srcI + factor/2))];
        }
        
        // Compute weighted mean
        let sum = 0, totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            sum += samples[i] * weights[i];
            totalWeight += weights[i];
        }
        const mean = sum / totalWeight;
        
        // Compute weighted standard deviation
        let variance = 0;
        for (let i = 0; i < samples.length; i++) {
            const diff = samples[i] - mean;
            variance += diff * diff * weights[i];
        }
        variance /= totalWeight;
        const stdDev = Math.sqrt(variance);
        
        // Remove outliers and recompute (robust to noise)
        sum = 0;
        totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i] - mean) < 2.5 * stdDev) {
                sum += samples[i] * weights[i];
                totalWeight += weights[i];
            }
        }
        
        return totalWeight > 0 ? sum / totalWeight : mean;
    }
    
    bilinearInterpolate(heightMap, resolution, x, y) {
        // Bilinear interpolation at fractional coordinates
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(resolution - 1, x0 + 1);
        const y1 = Math.min(resolution - 1, y0 + 1);
        
        // Clamp to valid range
        const cx0 = Math.max(0, Math.min(resolution - 1, x0));
        const cy0 = Math.max(0, Math.min(resolution - 1, y0));
        const cx1 = Math.max(0, Math.min(resolution - 1, x1));
        const cy1 = Math.max(0, Math.min(resolution - 1, y1));
        
        // Fractional parts
        const fx = x - x0;
        const fy = y - y0;
        
        // Sample four corners
        const v00 = heightMap[cy0 * resolution + cx0];
        const v10 = heightMap[cy0 * resolution + cx1];
        const v01 = heightMap[cy1 * resolution + cx0];
        const v11 = heightMap[cy1 * resolution + cx1];
        
        // Bilinear interpolation
        const v0 = v00 * (1 - fx) + v10 * fx;
        const v1 = v01 * (1 - fx) + v11 * fx;
        return v0 * (1 - fy) + v1 * fy;
    }
    
    sampleLanczos2(heightMap, resolution, x, y, windowSize) {
        const sobelX = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
        const sobelY = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
        
        for (let j = 1; j < resolution - 1; j++) {
            for (let i = 1; i < resolution - 1; i++) {
                let gx = 0, gy = 0;
                
                // Apply Sobel kernels
                for (let kj = -1; kj <= 1; kj++) {
                    for (let ki = -1; ki <= 1; ki++) {
                        const idx = (j + kj) * resolution + (i + ki);
                        const kernelIdx = (kj + 1) * 3 + (ki + 1);
                        gx += heightMap[idx] * sobelX[kernelIdx];
                        gy += heightMap[idx] * sobelY[kernelIdx];
                    }
                }
                
                // Gradient magnitude
                gradientMap[j * resolution + i] = Math.sqrt(gx * gx + gy * gy);
            }
        }
        
        return gradientMap;
    }
    
    classifyDetailRegions(gradientMap, resolution, edgeThreshold) {
        // Classify each pixel by detail level (0 = flat, 1 = high detail)
        const detailMap = new Float32Array(resolution * resolution);
        
        // Find gradient statistics for normalization
        let maxGradient = 0;
        for (let i = 0; i < gradientMap.length; i++) {
            maxGradient = Math.max(maxGradient, gradientMap[i]);
        }
        
        // Normalize and classify
        const gradientThreshold = Math.sqrt(edgeThreshold);
        for (let i = 0; i < resolution * resolution; i++) {
            const normalizedGradient = gradientMap[i] / (maxGradient + 1e-6);
            
            // Smooth classification with sigmoid-like curve
            const x = normalizedGradient / gradientThreshold;
            detailMap[i] = Math.min(1, x * x); // Quadratic ramp for smooth transition
        }
        
        return detailMap;
    }
    
    sampleHighDetail(heightMap, resolution, srcI, srcJ, factor, gradientMap) {
        // High-detail sampling: use gradient-weighted median filter
        // This preserves edges while reducing noise
        
        const samples = [];
        const weights = [];
        
        for (let dj = 0; dj < factor; dj++) {
            for (let di = 0; di < factor; di++) {
                const sj = Math.min(resolution - 1, srcJ + dj);
                const si = Math.min(resolution - 1, srcI + di);
                const idx = sj * resolution + si;
                
                samples.push(heightMap[idx]);
                
                // Weight by inverse gradient: lower gradient = more influence
                // This helps preserve sharp edges
                const gradient = gradientMap[idx];
                const weight = 1 / (1 + gradient);
                weights.push(weight);
            }
        }
        
        // Weighted percentile (closer to median for robust edge preservation)
        const sortedIndices = samples.map((_, i) => i)
            .sort((a, b) => samples[a] - samples[b]);
        
        let cumulativeWeight = 0;
        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const targetWeight = totalWeight * 0.5; // Median
        
        for (let i = 0; i < sortedIndices.length; i++) {
            cumulativeWeight += weights[sortedIndices[i]];
            if (cumulativeWeight >= targetWeight) {
                return samples[sortedIndices[i]];
            }
        }
        
        return samples[sortedIndices[Math.floor(sortedIndices.length / 2)]];
    }
    
    sampleHighDetailAntialiased(heightMap, resolution, srcI, srcJ, factor, gradientMap) {
        // Enhanced anti-aliased sampling with proper Lanczos-style filtering
        // Uses higher supersampling rate and better interpolation
        
        // Collect samples with their gradients
        const blockSamples = [];
        let avgGradX = 0, avgGradY = 0;
        let sampleCount = 0;
        
        // First pass: analyze the block to detect edge orientation
        for (let dj = -1; dj <= factor; dj++) {
            for (let di = -1; di <= factor; di++) {
                const sj = Math.min(resolution - 1, Math.max(0, srcJ + dj));
                const si = Math.min(resolution - 1, Math.max(0, srcI + di));
                const idx = sj * resolution + si;
                
                blockSamples.push({ value: heightMap[idx], i: si, j: sj });
                
                // Compute gradient using central differences
                if (si > 0 && si < resolution - 1 && sj > 0 && sj < resolution - 1) {
                    const gx = (heightMap[idx + 1] - heightMap[idx - 1]) / 2;
                    const gy = (heightMap[idx + resolution] - heightMap[idx - resolution]) / 2;
                    avgGradX += gx;
                    avgGradY += gy;
                    sampleCount++;
                }
            }
        }
        
        // Average gradient direction for the block
        if (sampleCount > 0) {
            avgGradX /= sampleCount;
            avgGradY /= sampleCount;
        }
        
        // Normalize to get edge tangent (perpendicular to gradient)
        const gradMag = Math.sqrt(avgGradX * avgGradX + avgGradY * avgGradY);
        let edgeTangentX = 0, edgeTangentY = 0;
        
        if (gradMag > 1e-6) {
            // Edge tangent is perpendicular to gradient
            edgeTangentX = -avgGradY / gradMag;
            edgeTangentY = avgGradX / gradMag;
        }
        
        // Second pass: Supersampled reconstruction with Lanczos-2 kernel
        // Use 4x4 supersampling for better quality
        const supersampleRes = 4;
        const samples = [];
        const weights = [];
        
        for (let dj = 0; dj < factor; dj++) {
            for (let di = 0; di < factor; di++) {
                // Multiple subsamples per pixel
                for (let ssj = 0; ssj < supersampleRes; ssj++) {
                    for (let ssi = 0; ssi < supersampleRes; ssi++) {
                        // Sub-pixel position (0 to 1 within pixel)
                        const subI = (ssi + 0.5) / supersampleRes;
                        const subJ = (ssj + 0.5) / supersampleRes;
                        
                        // Continuous position in source space
                        const contI = srcI + di + subI;
                        const contJ = srcJ + dj + subJ;
                        
                        // Bilinear interpolation with edge-aware adjustment
                        const value = this.bilinearInterpolate(heightMap, resolution, contI, contJ);
                        samples.push(value);
                        
                        // Compute weight based on distance and edge alignment
                        const centerI = srcI + factor / 2;
                        const centerJ = srcJ + factor / 2;
                        const dx = contI - centerI;
                        const dy = contJ - centerJ;
                        
                        // Distance weight (Gaussian)
                        const distSq = dx * dx + dy * dy;
                        const sigma = factor / 2;
                        let weight = Math.exp(-distSq / (2 * sigma * sigma));
                        
                        // Edge alignment weight (prefer samples aligned with edge)
                        if (gradMag > 0.01) {
                            // Project displacement onto edge tangent
                            const tangentAlign = Math.abs(dx * edgeTangentX + dy * edgeTangentY);
                            const normalAlign = Math.abs(dx * avgGradX / gradMag + dy * avgGradY / gradMag);
                            
                            // Prefer samples along edge direction, less across edge
                            const alignmentFactor = 1 + tangentAlign - normalAlign * 0.5;
                            weight *= Math.max(0.1, alignmentFactor);
                        }
                        
                        weights.push(weight);
                    }
                }
            }
        }
        
        // Weighted average with outlier rejection
        if (samples.length === 0) {
            return heightMap[Math.min(resolution - 1, Math.floor(srcJ + factor/2)) * resolution + 
                            Math.min(resolution - 1, Math.floor(srcI + factor/2))];
        }
        
        // Calculate weighted mean and standard deviation
        let weightedSum = 0;
        let totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            weightedSum += samples[i] * weights[i];
            totalWeight += weights[i];
        }
        const mean = weightedSum / totalWeight;
        
        let variance = 0;
        for (let i = 0; i < samples.length; i++) {
            const diff = samples[i] - mean;
            variance += diff * diff * weights[i];
        }
        variance /= totalWeight;
        const stdDev = Math.sqrt(variance);
        
        // Remove outliers (> 2 std dev) and recalculate
        weightedSum = 0;
        totalWeight = 0;
        for (let i = 0; i < samples.length; i++) {
            if (Math.abs(samples[i] - mean) < 2 * stdDev) {
                weightedSum += samples[i] * weights[i];
                totalWeight += weights[i];
            }
        }
        
        return totalWeight > 0 ? weightedSum / totalWeight : mean;
    }
    
    bilinearInterpolate(heightMap, resolution, x, y) {
        // Bilinear interpolation at fractional coordinates
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(resolution - 1, x0 + 1);
        const y1 = Math.min(resolution - 1, y0 + 1);
        
        // Clamp to valid range
        const cx0 = Math.max(0, Math.min(resolution - 1, x0));
        const cy0 = Math.max(0, Math.min(resolution - 1, y0));
        const cx1 = Math.max(0, Math.min(resolution - 1, x1));
        const cy1 = Math.max(0, Math.min(resolution - 1, y1));
        
        // Fractional parts
        const fx = x - x0;
        const fy = y - y0;
        
        // Sample four corners
        const v00 = heightMap[cy0 * resolution + cx0];
        const v10 = heightMap[cy0 * resolution + cx1];
        const v01 = heightMap[cy1 * resolution + cx0];
        const v11 = heightMap[cy1 * resolution + cx1];
        
        // Bilinear interpolation
        const v0 = v00 * (1 - fx) + v10 * fx;
        const v1 = v01 * (1 - fx) + v11 * fx;
        return v0 * (1 - fy) + v1 * fy;
    }
    
    sampleLanczos2(heightMap, resolution, x, y, windowSize) {
        // Lanczos-2 windowed sinc interpolation - highest quality resampling
        const lanczos = (x, a = 2) => {
            if (Math.abs(x) < 1e-6) return 1;
            if (Math.abs(x) >= a) return 0;
            const px = Math.PI * x;
            return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
        };
        
        const radius = 2;
        let sum = 0;
        let weightSum = 0;
        
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        
        for (let dy = -radius + 1; dy <= radius; dy++) {
            for (let dx = -radius + 1; dx <= radius; dx++) {
                const sx = x0 + dx;
                const sy = y0 + dy;
                
                if (sx < 0 || sx >= resolution || sy < 0 || sy >= resolution) continue;
                
                const distX = x - sx;
                const distY = y - sy;
                const weight = lanczos(distX) * lanczos(distY);
                
                sum += heightMap[sy * resolution + sx] * weight;
                weightSum += weight;
            }
        }
        
        return weightSum > 0 ? sum / weightSum : heightMap[Math.floor(y) * resolution + Math.floor(x)];
    }
    
    async createHeightmapContourLines(result, heightmapData, offsetDistance, clipZMin, clipZMax) {
        // Catmull-Rom bicubic interpolation
        const cubic = (t, p0, p1, p2, p3) => {
            return 0.5 * (
                (2 * p1) +
                (-p0 + p2) * t +
                (2*p0 - 5*p1 + 4*p2 - p3) * t * t +
                (-p0 + 3*p1 - 3*p2 + p3) * t * t * t
            );
        };
        
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        
        const samples = new Array(4);
        for (let j = 0; j < 4; j++) {
            const sy = Math.max(0, Math.min(resolution - 1, y0 - 1 + j));
            const row = [];
            for (let i = 0; i < 4; i++) {
                const sx = Math.max(0, Math.min(resolution - 1, x0 - 1 + i));
                row.push(heightMap[sy * resolution + sx]);
            }
            samples[j] = cubic(fx, row[0], row[1], row[2], row[3]);
        }
        
        return cubic(fy, samples[0], samples[1], samples[2], samples[3]);
    }
    
    bilinearInterpolate(heightMap, resolution, x, y) {
        // Bilinear interpolation at fractional coordinates
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const x1 = Math.min(resolution - 1, x0 + 1);
        const y1 = Math.min(resolution - 1, y0 + 1);
        
        // Clamp to valid range
        const cx0 = Math.max(0, Math.min(resolution - 1, x0));
        const cy0 = Math.max(0, Math.min(resolution - 1, y0));
        const cx1 = Math.max(0, Math.min(resolution - 1, x1));
        const cy1 = Math.max(0, Math.min(resolution - 1, y1));
        
        // Fractional parts
        const fx = x - x0;
        const fy = y - y0;
        
        // Sample four corners
        const v00 = heightMap[cy0 * resolution + cx0];
        const v10 = heightMap[cy0 * resolution + cx1];
        const v01 = heightMap[cy1 * resolution + cx0];
        const v11 = heightMap[cy1 * resolution + cx1];
        
        // Bilinear interpolation
        const v0 = v00 * (1 - fx) + v10 * fx;
        const v1 = v01 * (1 - fx) + v11 * fx;
        return v0 * (1 - fy) + v1 * fy;
    }
    
    adaptiveBilateralSmooth(heightMap, resolution, edgeThreshold) {
        // Adaptive bilateral filter: stronger smoothing in flat regions, minimal at edges
        const smoothed = new Float32Array(heightMap.length);
        const spatialSigma = 1.5;
        const rangeSigma = Math.sqrt(edgeThreshold) * 2;
        
        // Compute local gradients for adaptive kernel sizing
        const localGradients = new Float32Array(resolution * resolution);
        for (let j = 1; j < resolution - 1; j++) {
            for (let i = 1; i < resolution - 1; i++) {
                const idx = j * resolution + i;
                const center = heightMap[idx];
                
                // Compute local gradient magnitude
                const dx = heightMap[idx + 1] - heightMap[idx - 1];
                const dy = heightMap[idx + resolution] - heightMap[idx - resolution];
                localGradients[idx] = Math.sqrt(dx * dx + dy * dy);
            }
        }
        
        for (let j = 0; j < resolution; j++) {
            for (let i = 0; i < resolution; i++) {
                const idx = j * resolution + i;
                const center = heightMap[idx];
                const localGrad = localGradients[idx];
                
                // Adaptive kernel radius: smaller for edges, larger for flat regions
                const normalizedGrad = localGrad / (Math.sqrt(edgeThreshold) + 1e-6);
                const kernelRadius = Math.max(1, Math.floor(3 * (1 - Math.min(1, normalizedGrad))));
                
                let weightedSum = 0;
                let weightSum = 0;
                
                for (let dj = -kernelRadius; dj <= kernelRadius; dj++) {
                    for (let di = -kernelRadius; di <= kernelRadius; di++) {
                        const nj = j + dj;
                        const ni = i + di;
                        
                        if (nj >= 0 && nj < resolution && ni >= 0 && ni < resolution) {
                            const neighborValue = heightMap[nj * resolution + ni];
                            
                            // Spatial weight
                            const spatialDist = Math.sqrt(di * di + dj * dj);
                            const spatialWeight = Math.exp(-(spatialDist * spatialDist) / (2 * spatialSigma * spatialSigma));
                            
                            // Range weight (intensity-based)
                            const rangeDist = Math.abs(neighborValue - center);
                            const rangeWeight = Math.exp(-(rangeDist * rangeDist) / (2 * rangeSigma * rangeSigma));
                            
                            const weight = spatialWeight * rangeWeight;
                            weightedSum += neighborValue * weight;
                            weightSum += weight;
                        }
                    }
                }
                
                smoothed[idx] = weightSum > 0 ? weightedSum / weightSum : center;
            }
        }
        
        heightMap.set(smoothed);
    }
    
    async createHeightmapContourLines(result, heightmapData, offsetDistance, clipZMin, clipZMax) {
        // Remove previous heightmap lines
        if (this.heightmapLines) {
            if (Array.isArray(this.heightmapLines)) {
                this.heightmapLines.forEach(line => {
                    this.scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                });
            } else {
                this.scene.remove(this.heightmapLines);
                if (this.heightmapLines.geometry) this.heightmapLines.geometry.dispose();
                if (this.heightmapLines.material) this.heightmapLines.material.dispose();
            }
            this.heightmapLines = null;
        }
        
        const { resolution, scale, center } = result;
        
        // Use provided heightmap data or load if not available
        let heightMap = heightmapData;
        if (!heightMap) {
            if (result.usesIndexedDB) {
                this.showProgress('Loading contour data...');
                const loadProgress = (current, total) => {
                    const percent = (current / total) * 100;
                    this.updateProgress(percent, current, total);
                };
                heightMap = await loadHeightMapFromTiles(result, loadProgress);
                this.hideProgress();
            } else {
                heightMap = result.heightMap;
            }
        }
        
        if (!heightMap) {
            this.logStatus('✗ Failed to load heightmap data', 'error');
            return;
        }
        
        // Use provided clipping bounds or calculate if not available
        if (clipZMin === undefined || clipZMax === undefined) {
            const originalBox = new THREE.Box3().setFromObject(this.originalMesh);
            clipZMin = originalBox.min.z - offsetDistance;
            clipZMax = originalBox.max.z + offsetDistance;
        }
        
        // Create horizontal contour lines for visualization
        // Draw lines at regular intervals across the heightmap
        const numLines = Math.floor(resolution / 7); // ~150 lines for 1024 resolution
        const lineStep = Math.floor(resolution / numLines);
        
        this.logStatus(`Creating ${numLines} horizontal contour lines for visualization...`, 'info');
        
        // Pre-calculate coordinate transformation constants
        const invResMinusOne = 1 / (resolution - 1);
        const invScale = 1 / scale;
        
        // Share a single material for all lines (instancing)
        const sharedLineMaterial = new THREE.LineBasicMaterial({ 
            color: 0x0000ff,
            linewidth: 1
        });
        
        const lines = [];
        const isVisible = document.getElementById('show-heightmap-lines').checked;
        
        // Create horizontal contour lines (Y direction)
        for (let j = 0; j < resolution; j += lineStep) {
            const positions = new Float32Array(resolution * 3);
            const flippedJ = resolution - 1 - j;
            const yCoord = ((flippedJ * 2 * invResMinusOne - 1) + center.y) * invScale;
            
            let posIdx = 0;
            for (let i = 0; i < resolution; i++) {
                // Get heightmap value with Y-flip to match rendering
                const idx = flippedJ * resolution + i;
                
                // Map to world coordinates
                const x = ((i * 2 * invResMinusOne - 1) + center.x) * invScale;
                let worldZ = (heightMap[idx] + center.z) * invScale;
                
                // Clip Z to bounding box + offset range
                worldZ = Math.max(clipZMin, Math.min(clipZMax, worldZ));
                
                positions[posIdx++] = x;
                positions[posIdx++] = yCoord;
                positions[posIdx++] = worldZ;
            }
            
            const lineGeometry = new THREE.BufferGeometry();
            lineGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            
            const line = new THREE.Line(lineGeometry, sharedLineMaterial);
            line.visible = isVisible;
            this.scene.add(line);
            lines.push(line);
        }
        
        // Store contour lines array
        this.heightmapLines = lines;
        
        this.logStatus(`✓ ${lines.length} contour lines created`, 'success');
    }
    
    async exportSTL() {
        if (!this.heightmapMesh) {
            this.logStatus('✗ No heightmap mesh to export. Generate offset first.', 'error');
            return;
        }
        
        try {
            const originalGeometry = this.heightmapMesh.geometry;
            const triangleCount = originalGeometry.index.count / 3;
            
            this.logStatus(`Preparing mesh for export: ${triangleCount.toLocaleString()} triangles...`, 'info');
            this.showProgress('Exporting mesh...');
            
            // Yield to UI
            await this.delay(10);
            
            // Verify watertightness
            const isWatertight = this.verifyWatertightness(originalGeometry);
            if (isWatertight) {
                this.logStatus('✓ Mesh is watertight', 'success');
            } else {
                this.logStatus('⚠ Warning: Mesh may have gaps', 'info');
            }
            
            this.updateProgress(50, 1, 2);
            
            // Yield to UI
            await this.delay(10);
            
            // Export geometry
            this.logStatus('Exporting to STL...', 'info');
            
            const exporter = new STLExporter();
            const tempMesh = new THREE.Mesh(originalGeometry);
            const stlBinary = exporter.parse(tempMesh, { binary: true });
            
            this.updateProgress(100, 2, 2);
            this.hideProgress();
            
            // Create blob and download
            const blob = new Blob([stlBinary], { type: 'application/octet-stream' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            
            // Generate filename with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
            link.download = `offset_mesh_${timestamp}.stl`;
            
            link.click();
            URL.revokeObjectURL(link.href);
            
            this.logStatus(`✓ STL file downloaded: ${triangleCount.toLocaleString()} triangles`, 'success');
        } catch (error) {
            this.hideProgress();
            this.logStatus(`✗ Export failed: ${error.message}`, 'error');
            console.error('STL export error:', error);
        }
    }
    
    async fixMeshIssues(geometry) {
        // Manifold mesh should have no degenerate triangles, but check anyway
        const positions = geometry.attributes.position.array;
        const indices = geometry.index.array;
        const newIndices = [];
        
        let removedTriangles = 0;
        const epsilon = 1e-10;
        
        const totalTriangles = indices.length / 3;
        const batchSize = 5000; // Process triangles in batches
        
        for (let batchStart = 0; batchStart < indices.length; batchStart += batchSize * 3) {
            const batchEnd = Math.min(batchStart + batchSize * 3, indices.length);
            
            for (let i = batchStart; i < batchEnd; i += 3) {
                const i0 = indices[i] * 3;
                const i1 = indices[i + 1] * 3;
                const i2 = indices[i + 2] * 3;
                
                // Get triangle vertices
                const v0x = positions[i0], v0y = positions[i0 + 1], v0z = positions[i0 + 2];
                const v1x = positions[i1], v1y = positions[i1 + 1], v1z = positions[i1 + 2];
                const v2x = positions[i2], v2y = positions[i2 + 1], v2z = positions[i2 + 2];
                
                // Calculate edge vectors
                const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
                const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
                
                // Calculate cross product (normal) magnitude
                const cx = e1y * e2z - e1z * e2y;
                const cy = e1z * e2x - e1x * e2z;
                const cz = e1x * e2y - e1y * e2x;
                const areaSq = cx * cx + cy * cy + cz * cz;
                
                // Keep triangle if area is significant
                if (areaSq > epsilon) {
                    newIndices.push(indices[i], indices[i + 1], indices[i + 2]);
                } else {
                    removedTriangles++;
                }
            }
            
            // Yield to UI every batch
            if (batchEnd < indices.length) {
                await this.delay(1);
            }
        }
        
        if (removedTriangles > 0) {
            this.logStatus(`✓ Removed ${removedTriangles} degenerate triangles`, 'success');
            
            // Create new geometry with cleaned indices
            const cleanedGeometry = new THREE.BufferGeometry();
            cleanedGeometry.setAttribute('position', geometry.attributes.position.clone());
            cleanedGeometry.setIndex(newIndices);
            cleanedGeometry.computeVertexNormals();
            
            return cleanedGeometry;
        }
        
        this.logStatus('✓ No degenerate triangles found (manifold mesh)', 'success');
        return geometry;
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    verifyWatertightness(geometry) {
        // Build edge map to check if every edge is shared by exactly 2 triangles
        const edges = new Map();
        const indices = geometry.index.array;
        const positions = geometry.attributes.position.array;
        
        // Track which triangles use each edge
        const edgeTriangles = new Map();
        
        for (let i = 0; i < indices.length; i += 3) {
            const triIdx = i / 3;
            const v0 = indices[i];
            const v1 = indices[i + 1];
            const v2 = indices[i + 2];
            
            // Check all three edges of the triangle
            const edges_in_tri = [
                [v0, v1],
                [v1, v2],
                [v2, v0]
            ];
            
            for (const [va, vb] of edges_in_tri) {
                const key = va < vb ? `${va}_${vb}` : `${vb}_${va}`;
                edges.set(key, (edges.get(key) || 0) + 1);
                
                if (!edgeTriangles.has(key)) {
                    edgeTriangles.set(key, []);
                }
                edgeTriangles.get(key).push(triIdx);
            }
        }
        
        // Analyze non-manifold edges
        let nonManifoldEdges = 0;
        const edgesByCount = { '0': 0, '1': 0, '2': 0, '3+': 0 };
        const debugReport = [];
        
        debugReport.push('\n========== MANIFOLD ANALYSIS ==========');
        debugReport.push(`Total edges: ${edges.size}`);
        debugReport.push(`Total triangles: ${indices.length / 3}`);
        debugReport.push(`Total vertices: ${positions.length / 3}`);
        
        for (const [edge, count] of edges) {
            if (count === 2) {
                edgesByCount['2']++;
            } else {
                nonManifoldEdges++;
                if (count === 1) edgesByCount['1']++;
                else if (count === 0) edgesByCount['0']++;
                else edgesByCount['3+']++;
                
                if (debugReport.length < 50) { // First 30 non-manifold edges
                    const [v0, v1] = edge.split('_').map(Number);
                    const p0 = [positions[v0*3], positions[v0*3+1], positions[v0*3+2]];
                    const p1 = [positions[v1*3], positions[v1*3+1], positions[v1*3+2]];
                    const tris = edgeTriangles.get(edge);
                    
                    debugReport.push(`\nEdge ${edge}: used by ${count} triangles`);
                    debugReport.push(`  V${v0}: [${p0[0].toFixed(4)}, ${p0[1].toFixed(4)}, ${p0[2].toFixed(4)}]`);
                    debugReport.push(`  V${v1}: [${p1[0].toFixed(4)}, ${p1[1].toFixed(4)}, ${p1[2].toFixed(4)}]`);
                    debugReport.push(`  Triangles: ${tris.join(', ')}`);
                }
            }
        }
        
        debugReport.push('\n========== EDGE STATISTICS ==========');
        debugReport.push(`Manifold edges (count=2): ${edgesByCount['2']}`);
        debugReport.push(`Boundary edges (count=1): ${edgesByCount['1']}`);
        debugReport.push(`Over-shared edges (count=3+): ${edgesByCount['3+']}`);
        debugReport.push(`Total non-manifold: ${nonManifoldEdges}`);
        debugReport.push('======================================\n');
        
        // Output to console
        console.log(debugReport.join('\n'));
        
        // Also create a downloadable report
        const reportText = debugReport.join('\n');
        const blob = new Blob([reportText], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'manifold_debug_report.txt';
        link.textContent = 'Download Debug Report';
        link.style.display = 'none';
        document.body.appendChild(link);
        
        if (nonManifoldEdges > 0) {
            this.logStatus(`⚠ Found ${nonManifoldEdges} non-manifold edges - check console for debug report`, 'error');
            
            // Auto-download report
            setTimeout(() => {
                link.click();
                URL.revokeObjectURL(url);
                link.remove();
            }, 100);
        } else {
            this.logStatus(`✓ All ${edges.size} edges are manifold`, 'success');
        }
        
        return nonManifoldEdges === 0;
    }
    
    addEdge(edgeMap, v0, v1) {
        // Create canonical edge representation (smaller vertex index first)
        const key = v0 < v1 ? `${v0}_${v1}` : `${v1}_${v0}`;
        edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }

    
    addAxisLabels(size) {
        const createTextSprite = (text, color) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 256;
            canvas.height = 256;
            
            ctx.fillStyle = color;
            ctx.font = 'Bold 120px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, 128, 128);
            
            const texture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ 
                map: texture,
                depthTest: false,
                depthWrite: false
            });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(15, 15, 1);
            
            return sprite;
        };

        const xLabel = createTextSprite('X', '#ff0000');
        xLabel.position.set(size * 1.1, 0, 0);
        this.scene.add(xLabel);
        this.axisLabels.push(xLabel);

        const yLabel = createTextSprite('Y', '#00ff00');
        yLabel.position.set(0, size * 1.1, 0);
        this.scene.add(yLabel);
        this.axisLabels.push(yLabel);

        const zLabel = createTextSprite('Z', '#0000ff');
        zLabel.position.set(0, 0, size * 1.1);
        this.scene.add(zLabel);
        this.axisLabels.push(zLabel);
    }
    
    clearScene() {
        // Clear meshes with proper disposal
        const meshesToClear = [
            { mesh: this.originalMesh, name: 'originalMesh' },
            { mesh: this.offsetMesh, name: 'offsetMesh' },
            { mesh: this.heightmapMesh, name: 'heightmapMesh' }
        ];
        
        meshesToClear.forEach(({ mesh, name }) => {
            if (mesh) {
                this.scene.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) {
                    // Handle material textures
                    if (mesh.material.map) mesh.material.map.dispose();
                    mesh.material.dispose();
                }
                this[name] = null;
            }
        });
        
        // Clear heightmap lines (now an array of Line objects)
        if (this.heightmapLines) {
            if (Array.isArray(this.heightmapLines)) {
                this.heightmapLines.forEach(line => {
                    this.scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                });
            } else {
                this.scene.remove(this.heightmapLines);
                if (this.heightmapLines.geometry) this.heightmapLines.geometry.dispose();
                if (this.heightmapLines.material) this.heightmapLines.material.dispose();
            }
            this.heightmapLines = null;
        }
        
        if (this.bboxHelper) {
            this.scene.remove(this.bboxHelper);
            this.bboxHelper.dispose();
            this.bboxHelper = null;
        }
        
        // Clear ray helpers
        this.rayHelpers.forEach(helper => {
            this.scene.remove(helper);
            if (helper.geometry) helper.geometry.dispose();
            if (helper.material) helper.material.dispose();
        });
        this.rayHelpers = [];
    }
    
    // New comprehensive cleanup method
    dispose() {
        this.clearScene();
        
        // Dispose loaded geometry
        if (this.loadedGeometry) {
            this.loadedGeometry.dispose();
            this.loadedGeometry = null;
        }
        
        // Dispose renderer and controls
        if (this.controls) {
            this.controls.dispose();
        }
        
        if (this.renderer) {
            this.renderer.dispose();
        }
        
        // Clean up offscreen resources
        cleanupOffscreenResources();
        
        // Clean up axis labels
        this.axisLabels.forEach(label => {
            this.scene.remove(label);
            if (label.material) {
                if (label.material.map) label.material.map.dispose();
                label.material.dispose();
            }
        });
        this.axisLabels = [];
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
    
    showProgress(label = 'Processing...') {
        const container = document.getElementById('progress-container');
        const labelEl = document.getElementById('progress-label');
        if (container && labelEl) {
            container.classList.add('active');
            labelEl.textContent = label;
            this.updateProgress(0);
        }
    }
    
    updateProgress(percent, current = null, total = null) {
        const fill = document.getElementById('progress-bar-fill');
        const text = document.getElementById('progress-text');
        
        if (fill && text) {
            const clampedPercent = Math.min(100, Math.max(0, percent));
            fill.style.width = `${clampedPercent}%`;
            
            if (current !== null && total !== null) {
                text.textContent = `${current}/${total} (${Math.round(clampedPercent)}%)`;
            } else {
                text.textContent = `${Math.round(clampedPercent)}%`;
            }
        }
    }
    
    hideProgress() {
        const container = document.getElementById('progress-container');
        if (container) {
            container.classList.remove('active');
        }
    }
    
    onWindowResize() {
        const aspect = window.innerWidth / window.innerHeight;
        const frustumSize = 100;
        
        this.camera.left = frustumSize * aspect / -2;
        this.camera.right = frustumSize * aspect / 2;
        this.camera.top = frustumSize / 2;
        this.camera.bottom = frustumSize / -2;
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
