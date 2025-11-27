// ============================================
// STL Export Module
// ============================================

import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

// ============================================
// Export Functions
// ============================================

export function exportSTLBinary(geometry) {
    const exporter = new STLExporter();
    const tempMesh = new THREE.Mesh(geometry);
    const stlBinary = exporter.parse(tempMesh, { binary: true });
    
    return stlBinary;
}

export function downloadSTL(stlBinary, filename = null) {
    if (!filename) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        filename = `offset_mesh_${timestamp}.stl`;
    }
    
    const blob = new Blob([stlBinary], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    
    return filename;
}

export function exportAndDownloadSTL(geometry, filename = null) {
    const stlBinary = exportSTLBinary(geometry);
    const finalFilename = downloadSTL(stlBinary, filename);
    
    const triangleCount = geometry.index.count / 3;
    console.log(`STL exported: ${triangleCount.toLocaleString()} triangles → ${finalFilename}`);
    
    return {
        filename: finalFilename,
        triangleCount,
        size: stlBinary.byteLength
    };
}
