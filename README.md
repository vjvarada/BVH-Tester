# Offset Mesh Processor - Modular API

A modular, reusable library for creating GPU-accelerated offset meshes from STL geometry.

## Features

- 🚀 **GPU-Accelerated** - Uses WebGL shaders for fast heightmap generation
- 📦 **Modular Architecture** - Import only what you need
- 🔧 **Flexible API** - Returns BufferGeometry for further processing (CSG, manipulation, etc.)
- 💾 **Large Model Support** - Handles up to 16384×16384 resolution with tiling
- ✅ **Watertight Meshes** - Generates manifold, 3D-printable geometry
- 🎯 **Mesh Simplification** - Optional mesh simplification with manifold repair
- 📊 **Progress Tracking** - Built-in progress callbacks
- 🎯 **Adaptive Resolution** - Automatic sizing based on model dimensions
- 🔄 **Rotatable Projection** - Change heightmap projection angle via XZ and YZ rotation

## Installation

```javascript
import { createOffsetMesh } from './offsetMeshProcessor.js';
import { exportAndDownloadSTL } from './stlExporter.js';
```

## Quick Start

### Simple Usage

```javascript
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { createOffsetMesh, extractVertices } from './offsetMeshProcessor.js';
import { exportAndDownloadSTL } from './stlExporter.js';
import * as THREE from 'three';

// Load STL
const loader = new STLLoader();
const geometry = loader.parse(arrayBuffer);

// Optional: Rotate the geometry to change projection angle
const rotationXZ = 45;  // Rotation around Y axis (degrees)
const rotationYZ = 30;  // Rotation around X axis (degrees, inverted: 180 - input)

if (rotationXZ !== 0 || rotationYZ !== 0) {
    const matrix = new THREE.Matrix4();
    
    // Apply XZ rotation (around Y axis)
    if (rotationXZ !== 0) {
        const rotY = new THREE.Matrix4();
        rotY.makeRotationY(rotationXZ * Math.PI / 180);
        matrix.multiply(rotY);
    }
    
    // Apply YZ rotation (around X axis, inverted)
    if (rotationYZ !== 0) {
        const actualYZ = 180 - rotationYZ;  // Invert for opposite projection
        const rotX = new THREE.Matrix4();
        rotX.makeRotationX(actualYZ * Math.PI / 180);
        matrix.multiply(rotX);
    }
    
    geometry.applyMatrix4(matrix);
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
}

// Extract vertices from the (possibly rotated) geometry
const vertices = extractVertices(geometry);

// Create offset mesh (returns BufferGeometry)
const result = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,        // Offset amount in world units
    pixelsPerUnit: 10,          // Resolution (higher = more detail)
    simplifyRatio: 0.5,         // Optional: simplify to 50% of triangles
    verifyManifold: true        // Optional: verify and repair manifold issues
});

console.log(`Created mesh: ${result.metadata.triangleCount} triangles`);
console.log(`Simplified: ${result.metadata.simplificationApplied}`);

// Rotate back to original orientation
if (rotationXZ !== 0 || rotationYZ !== 0) {
    const inverseMatrix = new THREE.Matrix4();
    
    // Apply inverse rotations in reverse order
    if (rotationYZ !== 0) {
        const actualYZ = 180 - rotationYZ;
        const rotX = new THREE.Matrix4();
        rotX.makeRotationX(-actualYZ * Math.PI / 180);
        inverseMatrix.multiply(rotX);
    }
    
    if (rotationXZ !== 0) {
        const rotY = new THREE.Matrix4();
        rotY.makeRotationY(-rotationXZ * Math.PI / 180);
        inverseMatrix.multiply(rotY);
    }
    
    result.geometry.applyMatrix4(inverseMatrix);
    result.geometry.computeVertexNormals();
}

// Export to STL when ready (application layer responsibility)
const exportInfo = exportAndDownloadSTL(result.geometry, 'offset.stl');
console.log(`Exported: ${exportInfo.filename}, Size: ${exportInfo.size} bytes`);
```

## Architecture

**Core Module** (`offsetMeshProcessor.js`):
- Returns `THREE.BufferGeometry` - not STL
- No file I/O or export logic
- Pure mesh generation pipeline

**Application Layer** (your code):
- Handles STL export via `stlExporter.js`
- Performs CSG operations on BufferGeometry
- Manages file downloads and UI

This separation allows you to:
- ✅ Use the geometry in CSG operations before export
- ✅ Apply post-processing (smoothing, decimation, etc.)
- ✅ Use in Three.js scenes without exporting
- ✅ Export to formats other than STL

## Modules

### 1. `offsetMeshProcessor.js` - Main API

**Primary Functions:**

```javascript
// Create offset mesh (returns Three.js BufferGeometry)
const result = await createOffsetMesh(vertices, options);

// Cleanup resources when done
cleanup();

// Extract vertices from BufferGeometry
const vertices = extractVertices(geometry);
```

**Options:**
- `offsetDistance` (required): Offset distance in world units
- `pixelsPerUnit` (required): Resolution - pixels per unit (1-50)
- `simplifyRatio` (optional): Mesh simplification ratio (0.1-1.0, default: null/disabled)
  - `0.5` = Reduce to 50% of triangles
  - `0.3` = Reduce to 30% of triangles
  - `null` = No simplification
- `verifyManifold` (optional): Verify and repair manifold issues (default: true)
  - `true` = Verify simplified mesh is manifold, repair if needed, fallback to full mesh if repair fails
  - `false` = Use simplified mesh as-is without verification
- `tileSize` (optional): Tile size for large heightmaps (default: 2048)
- `progressCallback` (optional): Function `(current, total, stage) => {}`

**Return Value:**
```javascript
{
    geometry: THREE.BufferGeometry,  // The offset mesh (indexed, ready for CSG or export)
    heightmapResult: Object,          // Raw heightmap data
    metadata: {
        offsetDistance: Number,
        pixelsPerUnit: Number,
        resolution: Number,
        vertexCount: Number,
        triangleCount: Number,
        originalTriangleCount: Number,    // Before simplification
        simplificationApplied: Boolean,
        simplificationTime: Number,
        geometryCreationTime: Number,
        processingTime: Number
    }
}
```

### 2. `offsetHeightmap.js` - GPU Heightmap Generation

Low-level heightmap generation. Usually you don't need to call this directly.

```javascript
import { createOffsetHeightMap, loadHeightMapFromTiles } from './offsetHeightmap.js';

const result = await createOffsetHeightMap(vertices, offset, resolution);
const heightMap = await loadHeightMapFromTiles(result);
```

### 3. `meshGenerator.js` - Watertight Mesh Creation

Convert heightmaps to manifold meshes.

```javascript
import { createWatertightMeshFromHeightmap } from './meshGenerator.js';

const geometry = createWatertightMeshFromHeightmap(
    heightMap, 
    resolution, 
    scale, 
    center, 
    clipZMin, 
    clipZMax
);
```

### 4. `meshOptimizer.js` - Mesh Cleanup & Simplification

```javascript
import { removeDegenerateTriangles, verifyWatertightness, repairNonManifoldMesh } from './meshOptimizer.js';

// Remove bad triangles
const cleanGeometry = removeDegenerateTriangles(geometry);

// Verify manifold
const verification = verifyWatertightness(geometry);
console.log(`Watertight: ${verification.isWatertight}`);
console.log(`Non-manifold edges: ${verification.nonManifoldEdges}`);

// Repair non-manifold mesh
const repairedGeometry = repairNonManifoldMesh(geometry, 3); // 3 iterations
```
```

### 5. `stlExporter.js` - STL Export

```javascript
import { exportAndDownloadSTL } from './stlExporter.js';

const exportInfo = exportAndDownloadSTL(geometry, 'my_model.stl');
```

## Usage Examples

### Example 1: Use in Three.js Scene

```javascript
import * as THREE from 'three';
import { createOffsetMesh, cleanup } from './offsetMeshProcessor.js';

// Create offset mesh
const result = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10,
    simplifyRatio: 0.5
});

// Add to scene
const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
const mesh = new THREE.Mesh(result.geometry, material);
scene.add(mesh);

// Export later when needed
import { exportAndDownloadSTL } from './stlExporter.js';
exportAndDownloadSTL(result.geometry, 'exported.stl');

// Cleanup
cleanup();
```

### Example 1b: Rotated Projection Angle

```javascript
import * as THREE from 'three';
import { createOffsetMesh, extractVertices, cleanup } from './offsetMeshProcessor.js';

// Load and rotate geometry to change projection angle
const geometry = loadedGeometry.clone();

// Rotate 45° around Y axis (XZ plane) and 30° around X axis (YZ plane, inverted)
const rotationXZ = 45;
const rotationYZ = 30;

const rotMatrix = new THREE.Matrix4();
rotMatrix.makeRotationY(rotationXZ * Math.PI / 180);

const rotMatrixX = new THREE.Matrix4();
const actualYZ = 180 - rotationYZ;  // Invert YZ for opposite projection
rotMatrixX.makeRotationX(actualYZ * Math.PI / 180);
rotMatrix.multiply(rotMatrixX);

geometry.applyMatrix4(rotMatrix);
geometry.computeVertexNormals();
geometry.computeBoundingBox();

// Create offset mesh from rotated geometry
const vertices = extractVertices(geometry);
const result = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10
});

// Rotate back for display
const inverseMatrix = new THREE.Matrix4();
const invX = new THREE.Matrix4();
invX.makeRotationX(-actualYZ * Math.PI / 180);
inverseMatrix.multiply(invX);

const invY = new THREE.Matrix4();
invY.makeRotationY(-rotationXZ * Math.PI / 180);
inverseMatrix.multiply(invY);

result.geometry.applyMatrix4(inverseMatrix);
result.geometry.computeVertexNormals();

// Add to scene
const mesh = new THREE.Mesh(result.geometry, material);
scene.add(mesh);

cleanup();
```

### Example 2: Batch Processing

```javascript
async function processBatch(files) {
    const results = [];
    
    for (const file of files) {
        const loader = new STLLoader();
        const geometry = await loadSTL(file);
        const vertices = extractVertices(geometry);
        
        const result = await createOffsetMesh(vertices, {
            offsetDistance: 0.2,
            pixelsPerUnit: 10,
            simplifyRatio: 0.5
        });
        
        exportAndDownloadSTL(result.geometry, `offset_${file.name}`);
        
        results.push(result);
    }
    
    cleanup();
    return results;
}
```

### Example 3: Progress Tracking

```javascript
const result = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10,
    progressCallback: (current, total, stage) => {
        const percent = Math.round(current);
        console.log(`[${percent}%] ${stage}`);
        
        // Update UI progress bar
        document.getElementById('progress').value = percent;
        document.getElementById('stage').textContent = stage;
    }
});
```

### Example 4: Mesh Simplification Options

```javascript
// Default: No simplification
const fullMesh = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10
});

// Simplify to 50% with manifold verification
const simplifiedSafe = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10,
    simplifyRatio: 0.5,
    verifyManifold: true  // Falls back to full mesh if simplification creates non-manifold issues
});

// Simplify to 30% without verification (always use simplified, even if non-manifold)
const simplifiedAggressive = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10,
    simplifyRatio: 0.3,
    verifyManifold: false  // Use simplified mesh as-is
});

console.log(`Original: ${fullMesh.metadata.triangleCount} triangles`);
console.log(`Simplified (safe): ${simplifiedSafe.metadata.triangleCount} triangles`);
console.log(`Applied: ${simplifiedSafe.metadata.simplificationApplied}`);
```

### Example 5: CSG Operations Before Export

```javascript
import { SUBTRACTION } from 'three-bvh-csg';
import { exportAndDownloadSTL } from './stlExporter.js';

// Create offset mesh
const result = await createOffsetMesh(vertices, {
    offsetDistance: 0.2,
    pixelsPerUnit: 10,
    simplifyRatio: 0.5
});

// Use BufferGeometry for CSG operations
const offsetMesh = new THREE.Mesh(result.geometry);
const originalMesh = new THREE.Mesh(originalGeometry);

// Subtract original from offset to get shell
const shellMesh = SUBTRACTION(offsetMesh, originalMesh);

// Export the final result
const exportInfo = exportAndDownloadSTL(shellMesh.geometry, 'shell.stl');
console.log(`Shell exported: ${exportInfo.triangleCount} triangles`);
```

## Performance Guidelines

### Resolution (pixelsPerUnit)

- **5-8**: Fast, good for previews
- **10-15**: Balanced (recommended)
- **20+**: High detail, slower

### Mesh Simplification (simplifyRatio)

- **null/undefined**: No simplification (full quality)
- **0.5-0.7**: Moderate reduction (recommended for most cases)
- **0.3-0.5**: Aggressive reduction (good for very large meshes)
- **0.1-0.3**: Extreme reduction (preview quality)

**Manifold Verification:**
- Enable (`verifyManifold: true`) when you need guaranteed watertight meshes for 3D printing
- Disable (`verifyManifold: false`) when speed is more important than perfect topology
- The repair process uses iterative triangle removal to fix over-shared edges
- Falls back to full mesh if simplification creates unrepairable non-manifold issues

### Memory Limits

- Resolutions > 2048 automatically use tiled rendering
- Maximum resolution: 16384×16384
- Tiles stored in IndexedDB for large heightmaps

## API Reference

### Main Functions

#### `createOffsetMesh(vertices, options)`
Creates an offset mesh from triangle soup vertices. Returns BufferGeometry for further processing.

**Parameters:**
- `vertices` (Float32Array): Triangle soup (xyz per vertex)
- `options` (Object): Configuration options

**Returns:** Promise<Object> with `{ geometry: THREE.BufferGeometry, metadata: Object }`

#### `extractVertices(geometry)`
Extract vertices from Three.js BufferGeometry.

**Returns:** Float32Array

#### `cleanup()`
Cleanup GPU resources and caches. Call when done processing.

## Error Handling

```javascript
try {
    const result = await createOffsetMesh(vertices, options);
} catch (error) {
    console.error('Processing failed:', error.message);
}
```

Common errors:
- Invalid vertices (empty array)
- Invalid offset distance (must be > 0)
- Invalid pixels per unit (must be > 0)
- GPU memory limits exceeded

## Browser Compatibility

- Requires WebGL 2.0
- Requires IndexedDB (for large heightmaps)
- Modern browsers: Chrome, Firefox, Edge, Safari 15+

## License

MIT

## Credits

Built with:
- Three.js for 3D rendering
- WebGL 2.0 for GPU acceleration
- IndexedDB for large dataset storage
