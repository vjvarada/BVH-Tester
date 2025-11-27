# Offset Mesh Processor - Modular API

A modular, reusable library for creating GPU-accelerated offset meshes from STL geometry.

## Features

- 🚀 **GPU-Accelerated** - Uses WebGL shaders for fast heightmap generation
- 📦 **Modular Architecture** - Import only what you need
- 🔧 **Flexible API** - Returns BufferGeometry for further processing (CSG, manipulation, etc.)
- 💾 **Large Model Support** - Handles up to 16384×16384 resolution with tiling
- ✅ **Watertight Meshes** - Generates manifold, 3D-printable geometry
- 📊 **Progress Tracking** - Built-in progress callbacks
- 🎯 **Adaptive Resolution** - Automatic sizing based on model dimensions

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

// Load STL
const loader = new STLLoader();
const geometry = loader.parse(arrayBuffer);
const vertices = extractVertices(geometry);

// Create offset mesh (returns BufferGeometry)
const result = await createOffsetMesh(vertices, {
    offsetDistance: 5.0,        // Offset amount in world units
    pixelsPerUnit: 10,          // Resolution (higher = more detail)
    downsampleFactor: 2         // Mesh optimization (1=full, 2=optimized, 4=fast)
});

console.log(`Created mesh: ${result.metadata.triangleCount} triangles`);

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
- `downsampleFactor` (optional): Mesh optimization level (default: 2)
  - `1` = Full quality (no downsampling)
  - `2` = Optimized (recommended)
  - `3-4` = Fast (for large models)
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
        isWatertight: Boolean,
        processingTime: Number
    },
    exportInfo: {                     // Only for createAndExportOffsetMesh
        filename: String,
        triangleCount: Number,
        size: Number
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

### 4. `meshOptimizer.js` - Mesh Cleanup

```javascript
import { removeDegenerateTriangles, verifyWatertightness } from './meshOptimizer.js';

// Remove bad triangles
const cleanGeometry = await removeDegenerateTriangles(geometry);

// Verify manifold
const verification = verifyWatertightness(geometry);
console.log(`Watertight: ${verification.isWatertight}`);
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
    offsetDistance: 5.0,
    pixelsPerUnit: 10,
    downsampleFactor: 2
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

### Example 2: Batch Processing

```javascript
async function processBatch(files) {
    const results = [];
    
    for (const file of files) {
        const loader = new STLLoader();
        const geometry = await loadSTL(file);
        const vertices = extractVertices(geometry);
        
        const result = await createAndExportOffsetMesh(vertices, {
            offsetDistance: 5.0,
            pixelsPerUnit: 10,
            downsampleFactor: 2,
            filename: `offset_${file.name}`
        });
        
        results.push(result);
    }
    
    cleanup();
    return results;
}
```

### Example 3: Progress Tracking

```javascript
const result = await createOffsetMesh(vertices, {
    offsetDistance: 5.0,
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

### Example 4: Custom Quality Settings

```javascript
// High quality for small models
const highQuality = await createOffsetMesh(vertices, {
    offsetDistance: 5.0,
    pixelsPerUnit: 20,
    downsampleFactor: 1
});

// Fast processing for large models
const fastProcessing = await createOffsetMesh(vertices, {
    offsetDistance: 5.0,
    pixelsPerUnit: 5,
    downsampleFactor: 4
});
```

### Example 5: CSG Operations Before Export

```javascript
import { SUBTRACTION } from 'three-bvh-csg';
import { exportAndDownloadSTL } from './stlExporter.js';

// Create offset mesh
const result = await createOffsetMesh(vertices, {
    offsetDistance: 5.0,
    pixelsPerUnit: 10,
    downsampleFactor: 2
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

### Mesh Optimization (downsampleFactor)

- **1**: Full quality, no downsampling
- **2**: Optimized, ~4x fewer triangles (recommended)
- **3-4**: Fast, good for large models

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
