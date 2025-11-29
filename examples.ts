// ============================================
// Example: Using the Offset Mesh Processor API
// ============================================

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { 
    createOffsetMesh, 
    extractVertices,
    cleanup 
} from './offsetMeshProcessor.js';
import { exportAndDownloadSTL } from './stlExporter.js';

// ============================================
// Example 1: Simple Usage - Create and Export
// ============================================

async function example1_simpleUsage(stlFile) {
    console.log('Example 1: Simple usage');
    
    // Load STL
    const loader = new STLLoader();
    const geometry = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const geo = loader.parse(e.target.result);
            resolve(geo);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(stlFile);
    });
    
    // Extract vertices
    const vertices = extractVertices(geometry);
    
    // Create offset mesh (returns BufferGeometry)
    const result = await createOffsetMesh(vertices, {
        offsetDistance: 5.0,
        pixelsPerUnit: 10,
        downsampleFactor: 2,
        progressCallback: (current, total, stage) => {
            console.log(`Progress: ${current}/${total} - ${stage}`);
        }
    });
    
    console.log('Mesh created:', result.metadata);
    
    // Export to STL (application layer responsibility)
    const exportInfo = exportAndDownloadSTL(result.geometry, 'my_offset_mesh.stl');
    console.log('Export complete:', exportInfo);
    
    // Cleanup
    cleanup();
}

// ============================================
// Example 2: Advanced Usage - Create Mesh, Use in Scene, Then Export
// ============================================

async function example2_advancedUsage(stlFile, scene) {
    console.log('Example 2: Advanced usage with scene integration');
    
    // Load STL
    const loader = new STLLoader();
    const geometry = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const geo = loader.parse(e.target.result);
            resolve(geo);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(stlFile);
    });
    
    // Extract vertices
    const vertices = extractVertices(geometry);
    
    // Create offset mesh (without exporting yet)
    const result = await createOffsetMesh(vertices, {
        offsetDistance: 5.0,
        pixelsPerUnit: 10,
        downsampleFactor: 2,
        progressCallback: (current, total, stage) => {
            console.log(`${stage}: ${Math.round(current)}%`);
        }
    });
    
    // Use the geometry in your scene
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const mesh = new THREE.Mesh(result.geometry, material);
    scene.add(mesh);
    
    // Later, export when needed
    const exportResult = exportAndDownloadSTL(result.geometry, 'delayed_export.stl');
    console.log('Exported:', exportResult.filename);
    
    // Cleanup when done
    cleanup();
    
    return mesh;
}

// ============================================
// Example 3: Batch Processing Multiple Files
// ============================================

async function example3_batchProcessing(stlFiles) {
    console.log('Example 3: Batch processing');
    
    const results = [];
    
    for (let i = 0; i < stlFiles.length; i++) {
        const file = stlFiles[i];
        console.log(`Processing ${i + 1}/${stlFiles.length}: ${file.name}`);
        
        // Load STL
        const loader = new STLLoader();
        const geometry = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const geo = loader.parse(e.target.result);
                resolve(geo);
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
        
        // Extract vertices
        const vertices = extractVertices(geometry);
        
        // Process (get BufferGeometry)
        const result = await createOffsetMesh(vertices, {
            offsetDistance: 5.0,
            pixelsPerUnit: 10,
            downsampleFactor: 2
        });
        
        // Export to STL
        const exportInfo = exportAndDownloadSTL(result.geometry, `offset_${file.name}`);
        
        results.push({
            originalFile: file.name,
            outputFile: exportInfo.filename,
            triangles: result.metadata.triangleCount,
            processingTime: result.metadata.processingTime
        });
        
        console.log(`  ✓ ${exportInfo.filename} (${result.metadata.triangleCount} triangles)`);
    }
    
    // Cleanup
    cleanup();
    
    return results;
}

// ============================================
// Example 4: Custom Settings Per Use Case
// ============================================

const PRESET_SETTINGS = {
    // High quality for small models
    highQuality: {
        pixelsPerUnit: 20,
        downsampleFactor: 1
    },
    
    // Balanced for medium models
    balanced: {
        pixelsPerUnit: 10,
        downsampleFactor: 2
    },
    
    // Fast processing for large models
    fast: {
        pixelsPerUnit: 5,
        downsampleFactor: 4
    }
};

async function example4_presets(stlFile, preset = 'balanced') {
    console.log(`Example 4: Using ${preset} preset`);
    
    const settings = PRESET_SETTINGS[preset];
    
    const loader = new STLLoader();
    const geometry = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const geo = loader.parse(e.target.result);
            resolve(geo);
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(stlFile);
    });
    
    const vertices = extractVertices(geometry);
    
    const result = await createOffsetMesh(vertices, {
        offsetDistance: 5.0,
        ...settings,
        progressCallback: (current, total, stage) => {
            if (current === total) {
                console.log(`✓ ${stage} complete`);
            }
        }
    });
    
    // Export to STL
    const exportInfo = exportAndDownloadSTL(result.geometry);
    console.log('Export complete:', exportInfo);
    
    cleanup();
    
    return { result, exportInfo };
}

// ============================================
// Export examples
// ============================================

export {
    example1_simpleUsage,
    example2_advancedUsage,
    example3_batchProcessing,
    example4_presets
};
