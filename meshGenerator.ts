// ============================================
// Watertight Mesh Generation Module
// Creates manifold meshes from heightmap data
// ============================================

import * as THREE from 'three';

// ============================================
// Mesh Generation from Heightmap
// ============================================

export function createWatertightMeshFromHeightmap(
    heightMap, 
    resolution, 
    scale, 
    center, 
    clipZMin, 
    clipZMax, 
    meshSettings = null
) {
    const startTime = performance.now();
    
    // Apply downsampling if needed
    let workingHeightMap = heightMap;
    let workingResolution = resolution;
    
    if (meshSettings && meshSettings.downsampleFactor > 1) {
        const downsampleResult = downsampleHeightmap(heightMap, resolution, meshSettings.downsampleFactor);
        workingHeightMap = downsampleResult.heightMap;
        workingResolution = downsampleResult.resolution;
    }
    
    // Pre-calculate coordinate transformation constants
    const invResMinusOne = 1 / (workingResolution - 1);
    const invScale = 1 / scale;
    
    // Step 1: Identify non-zero heightmap points
    const vertexGrid = new Array(workingResolution * workingResolution);
    const validVertices = [];
    
    let minHeight = Infinity;
    for (let i = 0; i < workingHeightMap.length; i++) {
        minHeight = Math.min(minHeight, workingHeightMap[i]);
    }
    
    const heightThreshold = 0.001;
    
    for (let j = 0; j < workingResolution; j++) {
        const flippedJ = workingResolution - 1 - j;
        const yCoord = ((flippedJ * 2 * invResMinusOne - 1) + center.y) * invScale;
        
        for (let i = 0; i < workingResolution; i++) {
            const heightIdx = flippedJ * workingResolution + i;
            const gridIdx = j * workingResolution + i;
            
            const rawHeight = workingHeightMap[heightIdx];
            
            if (Math.abs(rawHeight - minHeight) > heightThreshold) {
                const x = ((i * 2 * invResMinusOne - 1) + center.x) * invScale;
                const y = yCoord;
                
                let worldZ = (rawHeight + center.z) * invScale;
                worldZ = Math.max(clipZMin, Math.min(clipZMax, worldZ));
                
                const vertexIndex = validVertices.length;
                
                validVertices.push({
                    gridI: i,
                    gridJ: j,
                    topPos: new THREE.Vector3(x, y, worldZ),
                    bottomPos: new THREE.Vector3(x, y, clipZMin),
                    topIndex: -1,
                    bottomIndex: -1
                });
                
                vertexGrid[gridIdx] = vertexIndex;
            } else {
                vertexGrid[gridIdx] = null;
            }
        }
    }
    
    // Step 2: Build manifold mesh with shared vertices
    const vertexMap = new Map();
    const positions = [];
    let nextVertexIndex = 0;
    
    const getOrCreateVertex = (x, y, z) => {
        const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
        
        if (vertexMap.has(key)) {
            return vertexMap.get(key);
        }
        
        const index = nextVertexIndex++;
        positions.push(x, y, z);
        vertexMap.set(key, index);
        return index;
    };
    
    // Create top and bottom vertices
    validVertices.forEach(v => {
        v.topIndex = getOrCreateVertex(v.topPos.x, v.topPos.y, v.topPos.z);
        v.bottomIndex = getOrCreateVertex(v.bottomPos.x, v.bottomPos.y, v.bottomPos.z);
    });
    
    // Step 3: Build triangles
    let indices: Uint32Array | any[] = [];
    let idxCount = 0;
    
    const surfaceTriangles = (workingResolution - 1) * (workingResolution - 1) * 4;
    indices = new Uint32Array(surfaceTriangles * 3);
    
    // Top surface
    for (let j = 0; j < workingResolution - 1; j++) {
        for (let i = 0; i < workingResolution - 1; i++) {
            const a = vertexGrid[j * workingResolution + i];
            const b = vertexGrid[j * workingResolution + (i + 1)];
            const c = vertexGrid[(j + 1) * workingResolution + i];
            const d = vertexGrid[(j + 1) * workingResolution + (i + 1)];
            
            if (a !== null && b !== null && c !== null && d !== null) {
                const va = validVertices[a].topIndex;
                const vb = validVertices[b].topIndex;
                const vc = validVertices[c].topIndex;
                const vd = validVertices[d].topIndex;
                
                indices[idxCount++] = va; indices[idxCount++] = vd; indices[idxCount++] = vb;
                indices[idxCount++] = va; indices[idxCount++] = vc; indices[idxCount++] = vd;
            }
        }
    }
    
    // Bottom surface
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
                
                indices[idxCount++] = va; indices[idxCount++] = vb; indices[idxCount++] = vd;
                indices[idxCount++] = va; indices[idxCount++] = vd; indices[idxCount++] = vc;
            }
        }
    }
    
    // Step 4: Build side walls
    const ensureCapacity = (needed) => {
        if (indices.length < needed) {
            const newSize = Math.max(needed, Math.floor(indices.length * 1.5));
            const newIndices = new Uint32Array(newSize);
            newIndices.set(indices);
            indices = newIndices;
        }
    };
    
    const processedEdges = new Set();
    let wallCount = 0;
    
    const getEdgeKey = (v1, v2) => {
        return v1 < v2 ? `${v1},${v2}` : `${v2},${v1}`;
    };
    
    const addWallQuad = (v1Top, v1Bottom, v2Top, v2Bottom) => {
        ensureCapacity(idxCount + 6);
        
        indices[idxCount++] = v1Top;
        indices[idxCount++] = v2Top;
        indices[idxCount++] = v2Bottom;
        
        indices[idxCount++] = v1Top;
        indices[idxCount++] = v2Bottom;
        indices[idxCount++] = v1Bottom;
        
        wallCount++;
    };
    
    // Horizontal edges
    for (let j = 0; j < workingResolution; j++) {
        for (let i = 0; i < workingResolution - 1; i++) {
            const curr = vertexGrid[j * workingResolution + i];
            const next = vertexGrid[j * workingResolution + (i + 1)];
            
            if (curr !== null && next !== null) {
                const currTop = validVertices[curr].topIndex;
                const currBottom = validVertices[curr].bottomIndex;
                const nextTop = validVertices[next].topIndex;
                const nextBottom = validVertices[next].bottomIndex;
                
                const above = (j > 0) ? vertexGrid[(j - 1) * workingResolution + i] : null;
                const aboveNext = (j > 0) ? vertexGrid[(j - 1) * workingResolution + (i + 1)] : null;
                const below = (j < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + i] : null;
                const belowNext = (j < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + (i + 1)] : null;
                
                const missingAbove = (above === null || aboveNext === null);
                const missingBelow = (below === null || belowNext === null);
                
                if (missingAbove && !missingBelow) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(currTop, currBottom, nextTop, nextBottom);
                    }
                } else if (missingBelow && !missingAbove) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(nextTop, nextBottom, currTop, currBottom);
                    }
                } else if (missingAbove && missingBelow) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(currTop, currBottom, nextTop, nextBottom);
                    }
                }
            }
        }
    }
    
    // Vertical edges
    for (let i = 0; i < workingResolution; i++) {
        for (let j = 0; j < workingResolution - 1; j++) {
            const curr = vertexGrid[j * workingResolution + i];
            const next = vertexGrid[(j + 1) * workingResolution + i];
            
            if (curr !== null && next !== null) {
                const currTop = validVertices[curr].topIndex;
                const currBottom = validVertices[curr].bottomIndex;
                const nextTop = validVertices[next].topIndex;
                const nextBottom = validVertices[next].bottomIndex;
                
                const left = (i > 0) ? vertexGrid[j * workingResolution + (i - 1)] : null;
                const leftNext = (i > 0) ? vertexGrid[(j + 1) * workingResolution + (i - 1)] : null;
                const right = (i < workingResolution - 1) ? vertexGrid[j * workingResolution + (i + 1)] : null;
                const rightNext = (i < workingResolution - 1) ? vertexGrid[(j + 1) * workingResolution + (i + 1)] : null;
                
                const missingLeft = (left === null || leftNext === null);
                const missingRight = (right === null || rightNext === null);
                
                if (missingLeft && !missingRight) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(nextTop, nextBottom, currTop, currBottom);
                    }
                } else if (missingRight && !missingLeft) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(currTop, currBottom, nextTop, nextBottom);
                    }
                } else if (missingLeft && missingRight) {
                    const edgeKey = getEdgeKey(currTop, nextTop);
                    if (!processedEdges.has(edgeKey)) {
                        processedEdges.add(edgeKey);
                        addWallQuad(currTop, currBottom, nextTop, nextBottom);
                    }
                }
            }
        }
    }
    
    // Create geometry
    const finalIndices = new Uint32Array(indices.buffer, 0, idxCount);
    const finalPositions = new Float32Array(positions);
    
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(finalPositions, 3));
    geometry.setIndex(new THREE.BufferAttribute(finalIndices, 1));
    geometry.computeVertexNormals();
    
    const endTime = performance.now();
    const vertexCount = finalPositions.length / 3;
    const triangleCount = finalIndices.length / 3;
    
    console.log(`Manifold mesh: ${vertexCount} vertices, ${triangleCount} triangles [${(endTime - startTime).toFixed(0)}ms]`);
    
    return geometry;
}

// ============================================
// Heightmap Downsampling
// ============================================

function downsampleHeightmap(heightMap, resolution, factor) {
    const newResolution = Math.floor(resolution / factor);
    const newHeightMap = new Float32Array(newResolution * newResolution);
    
    for (let j = 0; j < newResolution; j++) {
        for (let i = 0; i < newResolution; i++) {
            const srcJ = j * factor;
            const srcI = i * factor;
            
            // Simple average of the block
            let sum = 0;
            let count = 0;
            
            for (let dj = 0; dj < factor; dj++) {
                for (let di = 0; di < factor; di++) {
                    const sj = Math.min(resolution - 1, srcJ + dj);
                    const si = Math.min(resolution - 1, srcI + di);
                    sum += heightMap[sj * resolution + si];
                    count++;
                }
            }
            
            newHeightMap[j * newResolution + i] = sum / count;
        }
    }
    
    return {
        heightMap: newHeightMap,
        resolution: newResolution
    };
}

export function calculateOptimalMeshSettings(resolution, heightMap) {
    const MAX_VERTICES = 2000000;
    const totalVertices = resolution * resolution;
    
    // Default downsample factor is 2x for optimization
    let downsampleFactor = 2;
    let quality = 'optimized';
    
    if (totalVertices > MAX_VERTICES) {
        const criticalDownsample = Math.ceil(Math.sqrt(totalVertices / MAX_VERTICES));
        downsampleFactor = Math.max(2, criticalDownsample);
        quality = 'auto-reduced';
    }
    
    const effectiveResolution = Math.floor(resolution / downsampleFactor);
    const estimatedVertices = effectiveResolution * effectiveResolution * 2;
    const estimatedTriangles = effectiveResolution * effectiveResolution * 4;
    
    return {
        downsampleFactor,
        effectiveResolution,
        quality,
        estimatedVertices,
        estimatedTriangles
    };
}
