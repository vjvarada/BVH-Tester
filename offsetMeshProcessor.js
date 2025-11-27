// ============================================
// Offset Mesh Processor - Main API
// High-level API for creating offset meshes from STL geometry
// ============================================

import * as THREE from 'three';
import { createOffsetHeightMap, loadHeightMapFromTiles, cleanupOffscreenResources } from './offsetHeightmap.js';
import { createWatertightMeshFromHeightmap, calculateOptimalMeshSettings } from './meshGenerator.js';
import { MeshoptSimplifier } from './node_modules/meshoptimizer/meshopt_simplifier.module.js';

// ============================================
// Main Processing Pipeline
// ============================================

/**
 * Process STL geometry and create offset mesh
 * @param {Float32Array} vertices - Triangle soup vertices (xyz per vertex)
 * @param {Object} options - Processing options
 * @param {number} options.offsetDistance - Offset distance in world units
 * @param {number} options.pixelsPerUnit - Resolution (pixels per unit)
 * @param {number} [options.tileSize=2048] - Tile size for large heightmaps
 * @param {number} [options.simplifyRatio=null] - Simplification ratio (0.1-1.0), null to disable
 * @param {boolean} [options.verifyManifold=true] - Verify manifold and repair/fallback if needed
 * @param {number} [options.rotationXZ=0] - Rotation around Y axis in degrees (XZ plane)
 * @param {number} [options.rotationYZ=0] - Rotation around X axis in degrees (YZ plane, inverted: 180-input)
 * @param {Function} [options.progressCallback] - Progress callback (current, total, stage)
 * @returns {Promise<Object>} Result with geometry and metadata
 */
export async function createOffsetMesh(vertices, options) {
    const {
        offsetDistance,
        pixelsPerUnit,
        tileSize = 2048,
        simplifyRatio = null,
        verifyManifold = true,
        rotationXZ = 0,
        rotationYZ = 0,
        progressCallback = null
    } = options;
    
    // Validate inputs
    if (!vertices || vertices.length === 0) {
        throw new Error('No vertices provided');
    }
    if (offsetDistance <= 0) {
        throw new Error('Offset distance must be positive');
    }
    if (pixelsPerUnit <= 0) {
        throw new Error('Pixels per unit must be positive');
    }
    
    const result = {
        heightmapResult: null,
        geometry: null,
        metadata: {
            offsetDistance,
            pixelsPerUnit,
            resolution: 0,
            vertexCount: 0,
            triangleCount: 0,
            processingTime: 0,
            simplificationApplied: false,
            simplificationTime: 0,
            originalTriangleCount: 0
        }
    };
    
    const startTime = performance.now();
    
    try {
        // Step 0: Apply rotation if needed
        let workingVertices = vertices;
        let needsRotation = rotationXZ !== 0 || rotationYZ !== 180;  // Check if different from default inverted state
        
        if (needsRotation) {
            if (progressCallback) progressCallback(0, 100, 'Applying rotation');
            
            // Create rotation matrix
            const rotationMatrix = createRotationMatrix(rotationXZ, rotationYZ, false);
            
            // Rotate vertices
            workingVertices = applyMatrixToVertices(vertices, rotationMatrix);
            
            console.log(`Applied rotation: XZ=${rotationXZ}°, YZ=${rotationYZ}° (actual YZ=${180 - rotationYZ}°)`);
        }
        
        // Step 1: Calculate resolution
        if (progressCallback) progressCallback(0, 100, 'Calculating resolution');
        
        const box = new THREE.Box3();
        box.setFromArray(workingVertices);
        const size = new THREE.Vector3();
        box.getSize(size);
        const maxDim = Math.max(size.x, size.y, size.z);
        
        const effectiveDim = maxDim + (offsetDistance * 10);
        const resolution = Math.ceil(effectiveDim * pixelsPerUnit);
        const clampedResolution = Math.max(64, Math.min(16384, resolution));
        
        result.metadata.resolution = clampedResolution;
        
        console.log(`Resolution: ${maxDim.toFixed(1)} units × ${pixelsPerUnit} px/unit = ${clampedResolution}×${clampedResolution}`);
        
        // Step 2: Generate heightmap
        if (progressCallback) progressCallback(10, 100, 'Generating heightmap');
        
        const heightmapProgressCallback = clampedResolution > tileSize ? (current, total) => {
            const percent = 10 + (current / total) * 40;
            if (progressCallback) progressCallback(percent, 100, `Rendering tile ${current}/${total}`);
        } : null;
        
        const heightmapResult = await createOffsetHeightMap(
            workingVertices, 
            offsetDistance, 
            clampedResolution, 
            tileSize, 
            heightmapProgressCallback
        );
        
        result.heightmapResult = heightmapResult;
        
        // Step 3: Load heightmap data
        if (progressCallback) progressCallback(50, 100, 'Loading heightmap data');
        
        let heightMap;
        if (heightmapResult.usesIndexedDB) {
            const loadProgressCallback = (current, total) => {
                const percent = 50 + (current / total) * 20;
                if (progressCallback) progressCallback(percent, 100, `Loading tile ${current}/${total}`);
            };
            heightMap = await loadHeightMapFromTiles(heightmapResult, loadProgressCallback);
        } else {
            heightMap = heightmapResult.heightMap;
        }
        
        // Step 4: Calculate mesh settings
        if (progressCallback) progressCallback(70, 100, 'Calculating mesh settings');
        
        const meshSettings = {
            downsampleFactor: 1,
            effectiveResolution: clampedResolution
        };
        
        console.log(`Mesh resolution: ${meshSettings.effectiveResolution}×${meshSettings.effectiveResolution}`);
        
        // Step 5: Create watertight mesh
        if (progressCallback) progressCallback(75, 100, 'Creating watertight mesh');
        
        const originalBox = box;
        const clipZMin = originalBox.min.z - offsetDistance;
        const clipZMax = originalBox.max.z + offsetDistance;
        
        const geometry = createWatertightMeshFromHeightmap(
            heightMap,
            clampedResolution,
            heightmapResult.scale,
            heightmapResult.center,
            clipZMin,
            clipZMax,
            meshSettings
        );
        
        result.geometry = geometry;
        result.metadata.originalTriangleCount = geometry.index.count / 3;
        
        // Step 6: Optional mesh simplification
        if (simplifyRatio !== null && simplifyRatio > 0 && simplifyRatio < 1) {
            if (progressCallback) progressCallback(90, 100, 'Simplifying mesh');
            
            const simplifyStartTime = performance.now();
            try {
                console.log(`Attempting mesh simplification with ratio ${simplifyRatio}`);
                const simplifiedGeometry = await simplifyGeometry(geometry, simplifyRatio);
                
                let finalGeometry = simplifiedGeometry;
                let acceptMesh = true;
                
                // Only verify/repair if manifold checking is enabled
                if (verifyManifold) {
                    console.log('Verifying manifold properties...');
                    const { verifyWatertightness, repairNonManifoldMesh } = await import('./meshOptimizer.js');
                    let manifoldCheck = verifyWatertightness(simplifiedGeometry);
                    
                    acceptMesh = manifoldCheck.isWatertight;
                    
                    // If non-manifold, attempt repair
                    if (!manifoldCheck.isWatertight && manifoldCheck.overSharedEdges > 0) {
                        console.log(`Attempting to repair ${manifoldCheck.overSharedEdges} over-shared edges...`);
                        const repairedGeometry = repairNonManifoldMesh(simplifiedGeometry, 3);
                        
                        // Verify repair worked
                        const repairedCheck = verifyWatertightness(repairedGeometry);
                        
                        if (repairedCheck.isWatertight) {
                            console.log('✓ Successfully repaired non-manifold geometry');
                            finalGeometry = repairedGeometry;
                            acceptMesh = true;
                        } else if (repairedCheck.nonManifoldEdges < manifoldCheck.nonManifoldEdges * 0.1) {
                            console.log(`✓ Significantly improved: ${manifoldCheck.nonManifoldEdges} → ${repairedCheck.nonManifoldEdges} non-manifold edges (${((1 - repairedCheck.nonManifoldEdges / manifoldCheck.nonManifoldEdges) * 100).toFixed(1)}% reduction)`);
                            finalGeometry = repairedGeometry;
                            acceptMesh = true;
                        } else {
                            console.warn(`Repair incomplete: ${repairedCheck.nonManifoldEdges} non-manifold edges remain. Using full mesh.`);
                        }
                    }
                } else {
                    console.log('Manifold verification disabled - using simplified mesh as-is');
                }
                
                if (acceptMesh) {
                    result.geometry = finalGeometry;
                    result.metadata.simplificationApplied = true;
                    result.metadata.simplificationTime = performance.now() - simplifyStartTime;
                    console.log(`Mesh simplified: ${result.metadata.originalTriangleCount.toLocaleString()} → ${(finalGeometry.index.count / 3).toLocaleString()} triangles`);
                } else {
                    console.warn(`Simplification created non-manifold geometry that couldn't be repaired. Using full mesh.`);
                    result.metadata.simplificationApplied = false;
                    result.metadata.simplificationTime = 0;
                }
            } catch (error) {
                console.warn(`Mesh simplification failed: ${error.message}. Using full mesh.`);
                result.metadata.simplificationApplied = false;
                result.metadata.simplificationTime = 0;
            }
        }
        
        // Apply inverse rotation to restore original orientation
        if (needsRotation) {
            if (progressCallback) progressCallback(95, 100, 'Restoring orientation');
            
            const inverseMatrix = createRotationMatrix(rotationXZ, rotationYZ, true);
            result.geometry.applyMatrix4(inverseMatrix);
            result.geometry.computeVertexNormals();
            
            console.log('Restored original orientation');
        }
        
        result.metadata.vertexCount = result.geometry.getAttribute('position').count;
        result.metadata.triangleCount = result.geometry.index.count / 3;
        
        const endTime = performance.now();
        result.metadata.processingTime = endTime - startTime;
        result.metadata.geometryCreationTime = result.metadata.processingTime - result.metadata.simplificationTime;
        
        if (progressCallback) progressCallback(100, 100, 'Complete');
        
        console.log(`Processing complete: ${result.metadata.triangleCount.toLocaleString()} triangles in ${result.metadata.processingTime.toFixed(0)}ms`);
        
        return result;
        
    } catch (error) {
        console.error('Error in createOffsetMesh:', error);
        throw error;
    }
}

/**
 * Simplify mesh geometry using meshoptimizer
 * @param {THREE.BufferGeometry} geometry - Geometry to simplify
 * @param {number} targetRatio - Target ratio (0.1-1.0)
 * @returns {Promise<THREE.BufferGeometry>} Simplified geometry
 */
async function simplifyGeometry(geometry, targetRatio) {
    // Wait for meshoptimizer to be ready
    await MeshoptSimplifier.ready;
    
    // Extract mesh data
    const positions = geometry.attributes.position.array;
    const indices = geometry.index.array;
    
    // Validate input
    if (!indices || indices.length === 0) {
        throw new Error('Geometry has no indices');
    }
    if (!positions || positions.length === 0) {
        throw new Error('Geometry has no positions');
    }
    
    // Convert to Uint32Array and Float32Array if needed
    const uint32Indices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    const float32Positions = positions instanceof Float32Array ? positions : new Float32Array(positions);
    
    // Calculate target index count with minimum threshold
    const minIndexCount = 3;
    const targetIndexCount = Math.max(minIndexCount, Math.floor(uint32Indices.length * targetRatio));
    
    // Ensure target is divisible by 3 (triangles)
    const adjustedTargetIndexCount = Math.floor(targetIndexCount / 3) * 3;
    
    console.log(`Simplifying: ${uint32Indices.length} → ${adjustedTargetIndexCount} indices (ratio: ${targetRatio})`);
    
    // Simplify using meshoptimizer with LockBorder flag to preserve manifold topology
    // This prevents collapsing edges on the border which can create non-manifold geometry
    const [simplifiedIndices, error] = MeshoptSimplifier.simplify(
        uint32Indices,
        float32Positions,
        3, // stride (xyz)
        adjustedTargetIndexCount,
        0.01, // target error
        ['LockBorder'] // lock border vertices to preserve topology
    );
    
    console.log(`Simplification result: ${simplifiedIndices.length} indices, error: ${error.toFixed(6)}`);
    
    // Create new geometry with simplified indices
    const simplifiedGeometry = new THREE.BufferGeometry();
    simplifiedGeometry.setAttribute('position', geometry.attributes.position.clone());
    simplifiedGeometry.setIndex(Array.from(simplifiedIndices));
    simplifiedGeometry.computeVertexNormals();
    
    return simplifiedGeometry;
}

/**
 * Cleanup resources (call when done)
 */
export function cleanup() {
    cleanupOffscreenResources();
}

// ============================================
// Utility Functions
// ============================================

/**
 * Extract vertices from Three.js BufferGeometry
 * @param {THREE.BufferGeometry} geometry
 * @returns {Float32Array} Triangle soup vertices
 */
export function extractVertices(geometry) {
    return geometry.attributes.position.array;
}

/**
 * Calculate adaptive resolution based on model size
 * @param {THREE.Box3} boundingBox - Model bounding box
 * @param {number} pixelsPerUnit - Pixels per unit
 * @param {number} offsetDistance - Offset distance
 * @returns {number} Calculated resolution (clamped 64-16384)
 */
export function calculateResolution(boundingBox, pixelsPerUnit, offsetDistance) {
    const size = new THREE.Vector3();
    boundingBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    const effectiveDim = maxDim + (offsetDistance * 10);
    const resolution = Math.ceil(effectiveDim * pixelsPerUnit);
    return Math.max(64, Math.min(16384, resolution));
}

// ============================================
// Rotation Helper Functions
// ============================================

/**
 * Create a rotation matrix from XZ and YZ angles
 * @param {number} xzAngleDeg - Rotation around Y axis (degrees)
 * @param {number} yzAngleDeg - Rotation around X axis (degrees, inverted: 180-input)
 * @param {boolean} inverse - If true, creates inverse rotation
 * @returns {THREE.Matrix4} Rotation matrix
 */
function createRotationMatrix(xzAngleDeg, yzAngleDeg, inverse = false) {
    const matrix = new THREE.Matrix4();
    
    // Apply YZ inversion (180 - input)
    const actualYZ = 180 - yzAngleDeg;
    
    if (inverse) {
        // For inverse, apply rotations in reverse order with negative angles
        // If forward was: Y then X, inverse is: -X then -Y
        if (actualYZ !== 0) {  // Only skip if actualYZ is 0 (no rotation)
            const rotX = new THREE.Matrix4();
            rotX.makeRotationX(-actualYZ * Math.PI / 180);
            matrix.multiply(rotX);
        }
        
        if (xzAngleDeg !== 0) {
            const rotY = new THREE.Matrix4();
            rotY.makeRotationY(-xzAngleDeg * Math.PI / 180);
            matrix.multiply(rotY);
        }
    } else {
        // Forward rotation: Y axis first (XZ plane), then X axis (YZ plane)
        if (xzAngleDeg !== 0) {
            const rotY = new THREE.Matrix4();
            rotY.makeRotationY(xzAngleDeg * Math.PI / 180);
            matrix.multiply(rotY);
        }
        
        if (actualYZ !== 0) {  // Only skip if actualYZ is 0 (no rotation)
            const rotX = new THREE.Matrix4();
            rotX.makeRotationX(actualYZ * Math.PI / 180);
            matrix.multiply(rotX);
        }
    }
    
    return matrix;
}

/**
 * Apply a transformation matrix to vertices
 * @param {Float32Array} vertices - Input vertices
 * @param {THREE.Matrix4} matrix - Transformation matrix
 * @returns {Float32Array} Transformed vertices
 */
function applyMatrixToVertices(vertices, matrix) {
    const result = new Float32Array(vertices.length);
    const vec = new THREE.Vector3();
    
    for (let i = 0; i < vertices.length; i += 3) {
        vec.set(vertices[i], vertices[i + 1], vertices[i + 2]);
        vec.applyMatrix4(matrix);
        result[i] = vec.x;
        result[i + 1] = vec.y;
        result[i + 2] = vec.z;
    }
    
    return result;
}
