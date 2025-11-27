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
        // Step 1: Calculate resolution
        if (progressCallback) progressCallback(0, 100, 'Calculating resolution');
        
        const box = new THREE.Box3();
        box.setFromArray(vertices);
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
            vertices, 
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
