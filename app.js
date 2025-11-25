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
    
    // Cleanup old sessions to prevent database bloat
    async cleanupOldSessions(maxAge = 3600000) { // 1 hour default
        const cutoffTime = Date.now() - maxAge;
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['tiles'], 'readwrite');
            const store = transaction.objectStore('tiles');
            const request = store.openCursor();
            
            request.onerror = () => reject(request.error);
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const sessionTimestamp = parseInt(cursor.value.sessionId.split('_')[1]);
                    if (sessionTimestamp < cutoffTime) {
                        cursor.delete();
                    }
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
        
        // Smoothing passes slider
        document.getElementById('smoothing-passes').addEventListener('input', (e) => {
            document.getElementById('smoothing-value').textContent = e.target.value;
        });
        
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
    
    async createHeightmapVisualization(result) {
        // Remove previous heightmap mesh
        if (this.heightmapMesh) {
            this.scene.remove(this.heightmapMesh);
            this.heightmapMesh.geometry.dispose();
            this.heightmapMesh.material.dispose();
        }
        
        const { resolution, scale, center } = result;
        
        // Load heightmap data (from memory or IndexedDB)
        let heightMap;
        if (result.usesIndexedDB) {
            this.showProgress('Loading from IndexedDB...');
            this.logStatus('Loading heightmap from IndexedDB...', 'info');
            
            // Progress callback for loading tiles
            const loadProgress = (current, total) => {
                const percent = (current / total) * 100;
                this.updateProgress(percent, current, total);
            };
            
            heightMap = await loadHeightMapFromTiles(result, loadProgress);
            this.hideProgress();
            this.logStatus('✓ Heightmap loaded from IndexedDB', 'success');
        } else {
            heightMap = result.heightMap;
        }
        
        if (!heightMap) {
            this.logStatus('✗ Failed to load heightmap data', 'error');
            return null;
        }
        
        // No smoothing - preserve sharp edges
        const smoothedHeightMap = heightMap;
        
        // For high resolutions, we'll downsample for visualization but keep full detail in the data
        // Adaptive LOD: use more vertices for better quality display
        const targetVertexCount = 1000000; // ~1000x1000 grid for high quality
        const maxDisplayResolution = Math.floor(Math.sqrt(targetVertexCount));
        const displayResolution = Math.min(resolution, maxDisplayResolution);
        const downsampleStep = Math.max(1, Math.ceil(resolution / displayResolution));
        
        // Build custom geometry to handle any resolution efficiently
        const geometry = new THREE.BufferGeometry();
        const positions = [];
        const indices = [];
        const uvs = [];
        
        // Create vertices with downsampling if needed
        for (let y = 0; y < resolution; y += downsampleStep) {
            for (let x = 0; x < resolution; x += downsampleStep) {
                // Map to normalized [-1, 1] space
                const nx = (x / (resolution - 1)) * 2 - 1;
                // Flip Y coordinate to match the heightmap data orientation
                const ny = ((resolution - 1 - y) / (resolution - 1)) * 2 - 1;
                
                // Get height value with Y-flip
                const heightValue = smoothedHeightMap[(resolution - 1 - y) * resolution + x];
                
                positions.push(nx, ny, heightValue);
                uvs.push(x / (resolution - 1), 1.0 - (y / (resolution - 1))); // Flip UV Y as well
            }
        }
        
        // Calculate actual grid dimensions after downsampling
        const gridWidth = Math.ceil(resolution / downsampleStep);
        const gridHeight = Math.ceil(resolution / downsampleStep);
        
        // Create triangle indices for the grid
        for (let y = 0; y < gridHeight - 1; y++) {
            for (let x = 0; x < gridWidth - 1; x++) {
                const a = y * gridWidth + x;
                const b = y * gridWidth + (x + 1);
                const c = (y + 1) * gridWidth + x;
                const d = (y + 1) * gridWidth + (x + 1);
                
                // Two triangles per quad
                indices.push(a, b, d);
                indices.push(a, d, c);
            }
        }
        
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
        geometry.setIndex(indices);
        
        // Compute smooth normals for better appearance
        geometry.computeVertexNormals();
        
        // Apply additional smoothing to normals for even better visual quality
        const normals = geometry.attributes.normal.array;
        const smoothedNormals = new Float32Array(normals.length);
        
        for (let i = 0; i < normals.length; i += 3) {
            const vertexIndex = i / 3;
            const x = vertexIndex % gridWidth;
            const y = Math.floor(vertexIndex / gridWidth);
            
            // Average with neighboring normals
            let nx = normals[i];
            let ny = normals[i + 1];
            let nz = normals[i + 2];
            let count = 1;
            
            // Check all 8 neighbors
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    
                    const neighborX = x + dx;
                    const neighborY = y + dy;
                    
                    if (neighborX >= 0 && neighborX < gridWidth && 
                        neighborY >= 0 && neighborY < gridHeight) {
                        const neighborIndex = (neighborY * gridWidth + neighborX) * 3;
                        nx += normals[neighborIndex];
                        ny += normals[neighborIndex + 1];
                        nz += normals[neighborIndex + 2];
                        count++;
                    }
                }
            }
            
            // Average and normalize
            nx /= count;
            ny /= count;
            nz /= count;
            const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
            
            smoothedNormals[i] = nx / length;
            smoothedNormals[i + 1] = ny / length;
            smoothedNormals[i + 2] = nz / length;
        }
        
        geometry.setAttribute('normal', new THREE.BufferAttribute(smoothedNormals, 3));
        
        // Use solid white color material
        const material = new THREE.MeshStandardMaterial({ 
            color: 0xffffff,
            side: THREE.DoubleSide,
            wireframe: false,
            transparent: true,
            opacity: 0.75,
            metalness: 0.0,
            roughness: 0.8
        });
        
        this.heightmapMesh = new THREE.Mesh(geometry, material);
        
        // Scale back from normalized space
        this.heightmapMesh.scale.set(1 / scale, 1 / scale, 1 / scale);
        this.heightmapMesh.position.set(center.x / scale, center.y / scale, center.z / scale);
        
        this.heightmapMesh.visible = document.getElementById('show-heightmap').checked;
        this.scene.add(this.heightmapMesh);
        
        const actualVertices = positions.length / 3;
        if (downsampleStep > 1) {
            this.logStatus(`✓ Heightmap mesh: ${resolution}x${resolution} data, ${gridWidth}x${gridHeight} display (${actualVertices.toLocaleString()} vertices)`, 'success');
        } else {
            this.logStatus(`✓ Heightmap mesh created: ${gridWidth}x${gridHeight} (${actualVertices.toLocaleString()} vertices)`, 'success');
        }
        
        // Return smoothed data and display info for use by contour lines
        return { 
            smoothedHeightMap, 
            displayResolution, 
            downsampleStep 
        };
    }
    
    // Extract contour lines at 0°, 45°, 90°, and 135° from heightmap
    extractContourLines(heightMap, resolution, scale, center, clipZMin, clipZMax) {
        const invResMinusOne = 1 / (resolution - 1);
        const invScale = 1 / scale;
        
        const contourLines = {
            angle0: [],   // Horizontal lines (0°)
            angle90: [],  // Vertical lines (90°)
            angle45: [],  // Diagonal lines (45°)
            angleNeg45: [] // Diagonal lines (-45°)
        };
        
        // Determine contour spacing (fewer lines for faster processing)
        const spacing = Math.max(10, Math.floor(resolution / 30)); // ~30 contours per direction
        
        console.log(`Extracting contours with spacing: ${spacing} (resolution: ${resolution})`);
        
        // 0° - Horizontal lines (constant Y)
        for (let y = 0; y < resolution; y += spacing) {
            const points = [];
            const flippedY = resolution - 1 - y;
            const yCoord = ((flippedY * 2 * invResMinusOne - 1) + center.y) * invScale;
            
            for (let x = 0; x < resolution; x += 2) { // Sample every 2 pixels for speed
                const idx = flippedY * resolution + x;
                const xCoord = ((x * 2 * invResMinusOne - 1) + center.x) * invScale;
                let zCoord = (heightMap[idx] + center.z) * invScale;
                zCoord = Math.max(clipZMin, Math.min(clipZMax, zCoord));
                
                points.push({ x: xCoord, y: yCoord, z: zCoord });
            }
            contourLines.angle0.push(points);
        }
        
        // 90° - Vertical lines (constant X)
        for (let x = 0; x < resolution; x += spacing) {
            const points = [];
            const xCoord = ((x * 2 * invResMinusOne - 1) + center.x) * invScale;
            
            for (let y = 0; y < resolution; y += 2) { // Sample every 2 pixels for speed
                const flippedY = resolution - 1 - y;
                const idx = flippedY * resolution + x;
                const yCoord = ((flippedY * 2 * invResMinusOne - 1) + center.y) * invScale;
                let zCoord = (heightMap[idx] + center.z) * invScale;
                zCoord = Math.max(clipZMin, Math.min(clipZMax, zCoord));
                
                points.push({ x: xCoord, y: yCoord, z: zCoord });
            }
            contourLines.angle90.push(points);
        }
        
        // 45° - Diagonal lines (X + Y = constant)
        for (let offset = -resolution; offset < resolution; offset += spacing) {
            const points = [];
            
            for (let x = 0; x < resolution; x += 2) { // Sample every 2 pixels for speed
                const y = x + offset;
                if (y < 0 || y >= resolution) continue;
                
                const flippedY = resolution - 1 - y;
                const idx = flippedY * resolution + x;
                const xCoord = ((x * 2 * invResMinusOne - 1) + center.x) * invScale;
                const yCoord = ((flippedY * 2 * invResMinusOne - 1) + center.y) * invScale;
                let zCoord = (heightMap[idx] + center.z) * invScale;
                zCoord = Math.max(clipZMin, Math.min(clipZMax, zCoord));
                
                points.push({ x: xCoord, y: yCoord, z: zCoord });
            }
            
            if (points.length > 1) {
                contourLines.angle45.push(points);
            }
        }
        
        // -45° - Diagonal lines (X + Y = constant, perpendicular to 45°)
        for (let offset = 0; offset < 2 * resolution; offset += spacing) {
            const points = [];
            
            for (let x = 0; x < resolution; x += 2) { // Sample every 2 pixels for speed
                const y = -x + offset;  // Perpendicular to 45° line
                if (y < 0 || y >= resolution) continue;
                
                const flippedY = resolution - 1 - y;
                const idx = flippedY * resolution + x;
                const xCoord = ((x * 2 * invResMinusOne - 1) + center.x) * invScale;
                const yCoord = ((flippedY * 2 * invResMinusOne - 1) + center.y) * invScale;
                let zCoord = (heightMap[idx] + center.z) * invScale;
                zCoord = Math.max(clipZMin, Math.min(clipZMax, zCoord));
                
                points.push({ x: xCoord, y: yCoord, z: zCoord });
            }
            
            if (points.length > 1) {
                contourLines.angleNeg45.push(points);
            }
        }
        
        const totalLines = contourLines.angle0.length + contourLines.angle90.length + 
                          contourLines.angle45.length + contourLines.angleNeg45.length;
        console.log(`Extracted ${totalLines} contour lines (0°: ${contourLines.angle0.length}, 90°: ${contourLines.angle90.length}, 45°: ${contourLines.angle45.length}, -45°: ${contourLines.angleNeg45.length})`);
        
        return contourLines;
    }
    
    // Find intersections between contour lines
    findContourIntersections(contourLines) {
        const vertices = [];
        const vertexSet = new Set(); // To avoid duplicate vertices
        
        // Helper to add unique vertex
        const addVertex = (x, y, z) => {
            const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
            if (!vertexSet.has(key)) {
                vertexSet.add(key);
                vertices.push({ x, y, z });
            }
        };
        
        // Helper to find intersection between two 3D line segments
        const findLineIntersection = (line1Points, line2Points) => {
            // Check each segment of line1 against each segment of line2
            for (let i = 0; i < line1Points.length - 1; i++) {
                const p1 = line1Points[i];
                const p2 = line1Points[i + 1];
                
                for (let j = 0; j < line2Points.length - 1; j++) {
                    const p3 = line2Points[j];
                    const p4 = line2Points[j + 1];
                    
                    // Find closest points between two 3D line segments
                    const intersection = this.closestPointsBetweenSegments(p1, p2, p3, p4);
                    
                    if (intersection) {
                        // Add midpoint as the intersection vertex
                        const midX = (intersection.point1.x + intersection.point2.x) / 2;
                        const midY = (intersection.point1.y + intersection.point2.y) / 2;
                        const midZ = (intersection.point1.z + intersection.point2.z) / 2;
                        addVertex(midX, midY, midZ);
                    }
                }
            }
        };
        
        // Find intersections between different angle groups
        const angleGroups = [
            { name: '0°', lines: contourLines.angle0 },
            { name: '90°', lines: contourLines.angle90 },
            { name: '45°', lines: contourLines.angle45 },
            { name: '135°', lines: contourLines.angle135 }
        ];
        
        // Check all pairs of angle groups
        for (let i = 0; i < angleGroups.length; i++) {
            for (let j = i + 1; j < angleGroups.length; j++) {
                const group1 = angleGroups[i];
                const group2 = angleGroups[j];
                
                console.log(`Finding intersections between ${group1.name} and ${group2.name}...`);
                
                // Check each line in group1 against each line in group2
                for (const line1 of group1.lines) {
                    for (const line2 of group2.lines) {
                        findLineIntersection(line1, line2);
                    }
                }
            }
        }
        
        console.log(`Found ${vertices.length} unique intersection vertices`);
        return vertices;
    }
    
    // Find closest points between two 3D line segments
    closestPointsBetweenSegments(p1, p2, p3, p4) {
        const EPSILON = 0.0001;
        const PROXIMITY_THRESHOLD = 0.5; // Maximum distance to consider as intersection
        
        // Direction vectors
        const d1 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
        const d2 = { x: p4.x - p3.x, y: p4.y - p3.y, z: p4.z - p3.z };
        
        // Vector between segment start points
        const r = { x: p1.x - p3.x, y: p1.y - p3.y, z: p1.z - p3.z };
        
        const a = d1.x * d1.x + d1.y * d1.y + d1.z * d1.z; // ||d1||^2
        const b = d1.x * d2.x + d1.y * d2.y + d1.z * d2.z; // d1 · d2
        const c = d2.x * d2.x + d2.y * d2.y + d2.z * d2.z; // ||d2||^2
        const d = d1.x * r.x + d1.y * r.y + d1.z * r.z;    // d1 · r
        const e = d2.x * r.x + d2.y * r.y + d2.z * r.z;    // d2 · r
        
        const denom = a * c - b * b;
        
        // Check if lines are parallel
        if (Math.abs(denom) < EPSILON) {
            return null;
        }
        
        // Calculate parameters
        let s = (b * e - c * d) / denom;
        let t = (a * e - b * d) / denom;
        
        // Clamp to segment bounds [0, 1]
        s = Math.max(0, Math.min(1, s));
        t = Math.max(0, Math.min(1, t));
        
        // Calculate closest points
        const point1 = {
            x: p1.x + s * d1.x,
            y: p1.y + s * d1.y,
            z: p1.z + s * d1.z
        };
        
        const point2 = {
            x: p3.x + t * d2.x,
            y: p3.y + t * d2.y,
            z: p3.z + t * d2.z
        };
        
        // Calculate distance between closest points
        const dx = point2.x - point1.x;
        const dy = point2.y - point1.y;
        const dz = point2.z - point1.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        // Only consider as intersection if points are close enough
        if (distance < PROXIMITY_THRESHOLD) {
            return { point1, point2, distance };
        }
        
        return null;
    }
    
    // Triangulate vertices using Delaunay triangulation (2D projection + Z interpolation)
    triangulateIntersectionVertices(vertices) {
        if (vertices.length < 3) {
            console.error('Not enough vertices for triangulation');
            return null;
        }
        
        // Simple 2D Delaunay triangulation using ear clipping approximation
        // For production, consider using libraries like Delaunator.js
        
        // Project vertices to XY plane and keep track of Z values
        const points2D = vertices.map(v => ({ x: v.x, y: v.y, z: v.z }));
        
        // Create a bounding box to add boundary vertices
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of points2D) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        
        // Use simple grid-based triangulation for now
        // Sort vertices by X, then Y
        points2D.sort((a, b) => {
            if (Math.abs(a.x - b.x) < 0.001) return a.y - b.y;
            return a.x - b.x;
        });
        
        // Create triangles using a simple approach: connect nearby vertices
        const positions = [];
        const indices = [];
        
        // Add all vertices to positions array
        for (const v of vertices) {
            positions.push(v.x, v.y, v.z);
        }
        
        // Create triangles by connecting nearby vertices (simplified triangulation)
        // This is a basic approach - for better results, use proper Delaunay
        const vertexCount = vertices.length;
        const gridSize = Math.ceil(Math.sqrt(vertexCount));
        
        for (let i = 0; i < vertexCount - 2; i++) {
            // Create triangles with next two vertices (simple fan triangulation)
            // Better: use spatial hashing to find nearby vertices
            const v0 = vertices[i];
            
            // Find two closest vertices to form a triangle
            const distances = [];
            for (let j = i + 1; j < vertexCount; j++) {
                const v = vertices[j];
                const dx = v.x - v0.x;
                const dy = v.y - v0.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                distances.push({ idx: j, dist });
            }
            
            distances.sort((a, b) => a.dist - b.dist);
            
            if (distances.length >= 2) {
                const idx1 = distances[0].idx;
                const idx2 = distances[1].idx;
                
                // Check if triangle is not degenerate
                if (this.isValidTriangle(vertices[i], vertices[idx1], vertices[idx2])) {
                    indices.push(i, idx1, idx2);
                }
            }
        }
        
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();
        
        console.log(`Created mesh: ${vertexCount} vertices, ${indices.length / 3} triangles`);
        return geometry;
    }
    
    // Check if triangle is valid (non-degenerate and reasonable size)
    isValidTriangle(v0, v1, v2) {
        const EPSILON = 0.001;
        const MAX_EDGE_LENGTH = 50; // Maximum edge length for valid triangles
        
        // Calculate edge lengths
        const dx1 = v1.x - v0.x, dy1 = v1.y - v0.y, dz1 = v1.z - v0.z;
        const dx2 = v2.x - v0.x, dy2 = v2.y - v0.y, dz2 = v2.z - v0.z;
        const dx3 = v2.x - v1.x, dy3 = v2.y - v1.y, dz3 = v2.z - v1.z;
        
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1 + dz1 * dz1);
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
        const len3 = Math.sqrt(dx3 * dx3 + dy3 * dy3 + dz3 * dz3);
        
        // Check if any edge is too short or too long
        if (len1 < EPSILON || len2 < EPSILON || len3 < EPSILON) return false;
        if (len1 > MAX_EDGE_LENGTH || len2 > MAX_EDGE_LENGTH || len3 > MAX_EDGE_LENGTH) return false;
        
        // Calculate area using cross product
        const crossX = dy1 * dz2 - dz1 * dy2;
        const crossY = dz1 * dx2 - dx1 * dz2;
        const crossZ = dx1 * dy2 - dy1 * dx2;
        const area = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ) / 2;
        
        // Reject triangles with very small area
        return area > EPSILON;
    }
    
    // Visualize contour lines
    async visualizeContourLines(contourLines) {
        // Remove previous contour lines
        if (this.heightmapLines) {
            if (Array.isArray(this.heightmapLines)) {
                this.heightmapLines.forEach(line => {
                    this.scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                });
            }
        }
        
        const lines = [];
        const isVisible = document.getElementById('show-heightmap-lines').checked;
        
        // Color scheme for different angles
        const colors = {
            angle0: 0xff0000,   // Red for 0°
            angle90: 0x00ff00,  // Green for 90°
            angle45: 0x0000ff,  // Blue for 45°
            angleNeg45: 0xffff00  // Yellow for -45°
        };
        
        // Create lines for each angle group
        for (const [angleKey, contours] of Object.entries(contourLines)) {
            const material = new THREE.LineBasicMaterial({ 
                color: colors[angleKey],
                linewidth: 2
            });
            
            for (const points of contours) {
                const positions = [];
                for (const p of points) {
                    positions.push(p.x, p.y, p.z);
                }
                
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
                
                const line = new THREE.Line(geometry, material);
                line.visible = isVisible;
                this.scene.add(line);
                lines.push(line);
            }
        }
        
        this.heightmapLines = lines;
        console.log(`Visualized ${lines.length} contour lines`);
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
        
        this.logStatus('Extracting and visualizing contour lines...', 'info');
        
        // Calculate clipping bounds: original bounding box + offset
        const originalBox = new THREE.Box3().setFromObject(this.originalMesh);
        const clipZMin = originalBox.min.z - offsetDistance;
        const clipZMax = originalBox.max.z + offsetDistance;
        
        // Extract contour lines at 0, 45, 90, and -45 degrees
        this.logStatus('Extracting contour lines at 0°, 45°, 90°, -45°...', 'info');
        const contourLines = this.extractContourLines(heightMap, resolution, scale, center, clipZMin, clipZMax);
        
        // Visualize contour lines only (no mesh generation yet)
        await this.visualizeContourLines(contourLines);
        
        this.logStatus('✓ Contour lines displayed', 'success');
        
        // TODO: Next steps - find intersections and create mesh
        // For now, just show the contour lines
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
    
    optimizeMeshGeometry(geometry, resolution) {
        const startTime = performance.now();
        const positionAttr = geometry.getAttribute('position');
        const indexAttr = geometry.index;
        
        if (!positionAttr || !indexAttr) return;
        
        const positions = positionAttr.array;
        const indices = indexAttr.array;
        const vertexCount = positions.length / 3;
        
        // Step 1: Merge duplicate/near-duplicate vertices
        const mergeThreshold = 0.0001;
        const vertexMap = new Map();
        const newPositions = [];
        const vertexRemap = new Uint32Array(vertexCount);
        let newVertexCount = 0;
        
        for (let i = 0; i < vertexCount; i++) {
            const x = positions[i * 3];
            const y = positions[i * 3 + 1];
            const z = positions[i * 3 + 2];
            
            // Create a key for spatial hashing
            const key = `${Math.round(x / mergeThreshold)},${Math.round(y / mergeThreshold)},${Math.round(z / mergeThreshold)}`;
            
            if (vertexMap.has(key)) {
                // Check if actually close enough
                const existingIdx = vertexMap.get(key);
                const ex = newPositions[existingIdx * 3];
                const ey = newPositions[existingIdx * 3 + 1];
                const ez = newPositions[existingIdx * 3 + 2];
                
                const dx = x - ex;
                const dy = y - ey;
                const dz = z - ez;
                const distSq = dx * dx + dy * dy + dz * dz;
                
                if (distSq < mergeThreshold * mergeThreshold) {
                    vertexRemap[i] = existingIdx;
                    continue;
                }
            }
            
            vertexMap.set(key, newVertexCount);
            vertexRemap[i] = newVertexCount;
            newPositions.push(x, y, z);
            newVertexCount++;
        }
        
        // Step 2: Remove degenerate triangles and remap indices
        const newIndices = [];
        for (let i = 0; i < indices.length; i += 3) {
            const a = vertexRemap[indices[i]];
            const b = vertexRemap[indices[i + 1]];
            const c = vertexRemap[indices[i + 2]];
            
            // Skip degenerate triangles (where two or more vertices are the same)
            if (a !== b && b !== c && a !== c) {
                newIndices.push(a, b, c);
            }
        }
        
        // Step 3: Optimize triangle order for better cache coherency
        // Sort triangles by vertex indices for better GPU cache utilization
        const triangles = [];
        for (let i = 0; i < newIndices.length; i += 3) {
            triangles.push([newIndices[i], newIndices[i + 1], newIndices[i + 2]]);
        }
        
        // Simple optimization: sort by minimum vertex index
        triangles.sort((a, b) => Math.min(...a) - Math.min(...b));
        
        const optimizedIndices = new Uint32Array(triangles.length * 3);
        for (let i = 0; i < triangles.length; i++) {
            optimizedIndices[i * 3] = triangles[i][0];
            optimizedIndices[i * 3 + 1] = triangles[i][1];
            optimizedIndices[i * 3 + 2] = triangles[i][2];
        }
        
        // Update geometry with optimized data
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(newPositions), 3));
        geometry.setIndex(new THREE.BufferAttribute(optimizedIndices, 1));
        
        // Recompute normals with the optimized geometry
        geometry.computeVertexNormals();
        
        // Step 4: Compute bounding sphere for frustum culling optimization
        geometry.computeBoundingSphere();
        geometry.computeBoundingBox();
        
        const endTime = performance.now();
        const vertexReduction = ((vertexCount - newVertexCount) / vertexCount * 100).toFixed(1);
        const triangleReduction = ((indices.length - optimizedIndices.length) / indices.length * 100).toFixed(1);
        
        this.logStatus(
            `✓ Mesh optimized: ${vertexCount.toLocaleString()} → ${newVertexCount.toLocaleString()} vertices (-${vertexReduction}%), ` +
            `${(indices.length / 3).toLocaleString()} → ${(optimizedIndices.length / 3).toLocaleString()} triangles (-${triangleReduction}%) ` +
            `[${(endTime - startTime).toFixed(0)}ms]`,
            'success'
        );
    }
    
    simplifyHeightmap(heightMap, resolution, scale, center, clipZMin, clipZMax) {
        const startTime = performance.now();
        
        // Pre-calculate coordinate transformation constants
        const invResMinusOne = 1 / (resolution - 1);
        const invScale = 1 / scale;
        
        // Build full vertex grid - no holes
        const positions = [];
        
        for (let j = 0; j < resolution; j++) {
            const flippedJ = resolution - 1 - j;
            const yCoord = ((flippedJ * 2 * invResMinusOne - 1) + center.y) * invScale;
            
            for (let i = 0; i < resolution; i++) {
                const heightIdx = flippedJ * resolution + i;
                const x = ((i * 2 * invResMinusOne - 1) + center.x) * invScale;
                let worldZ = (heightMap[heightIdx] + center.z) * invScale;
                worldZ = Math.max(clipZMin, Math.min(clipZMax, worldZ));
                
                positions.push(x, yCoord, worldZ);
            }
        }
        
        // Build triangle indices - full grid triangulation
        const indices = [];
        
        for (let j = 0; j < resolution - 1; j++) {
            const rowOffset = j * resolution;
            const nextRowOffset = (j + 1) * resolution;
            
            for (let i = 0; i < resolution - 1; i++) {
                const a = rowOffset + i;
                const b = rowOffset + i + 1;
                const c = nextRowOffset + i;
                const d = nextRowOffset + i + 1;
                
                // Two triangles per quad
                indices.push(a, b, d);
                indices.push(a, d, c);
            }
        }
        
        const endTime = performance.now();
        
        console.log(`Heightmap mesh created: ${resolution * resolution} vertices [${(endTime - startTime).toFixed(0)}ms]`);
        
        return {
            vertices: new Float32Array(positions),
            indices: new Uint32Array(indices)
        };
    }
    
    smoothHeightmap(heightMap, resolution, passes = 1) {
        if (passes === 0) return heightMap;
        
        let current = new Float32Array(heightMap);
        let temp = new Float32Array(resolution * resolution);
        
        // Use an even larger, very aggressive Gaussian kernel for ultra-smooth results
        // 7-tap Gaussian kernel with maximum smoothing
        const kernel = [0.03, 0.11, 0.22, 0.28, 0.22, 0.11, 0.03]; // Very wide, very smooth kernel
        const kernelRadius = 3;
        
        // Apply 5x more passes for extremely smooth results
        const effectivePasses = passes * 5;
        
        for (let pass = 0; pass < effectivePasses; pass++) {
            // Horizontal pass
            for (let y = 0; y < resolution; y++) {
                for (let x = 0; x < resolution; x++) {
                    let sum = 0;
                    let weightSum = 0;
                    
                    for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
                        const nx = x + kx;
                        if (nx >= 0 && nx < resolution) {
                            const idx = y * resolution + nx;
                            const weight = kernel[kx + kernelRadius];
                            sum += current[idx] * weight;
                            weightSum += weight;
                        }
                    }
                    
                    temp[y * resolution + x] = sum / weightSum;
                }
            }
            
            // Vertical pass
            for (let y = 0; y < resolution; y++) {
                for (let x = 0; x < resolution; x++) {
                    let sum = 0;
                    let weightSum = 0;
                    
                    for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
                        const ny = y + ky;
                        if (ny >= 0 && ny < resolution) {
                            const idx = ny * resolution + x;
                            const weight = kernel[ky + kernelRadius];
                            sum += temp[idx] * weight;
                            weightSum += weight;
                        }
                    }
                    
                    current[y * resolution + x] = sum / weightSum;
                }
            }
        }
        
        return current;
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
