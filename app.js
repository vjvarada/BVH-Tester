// ============================================
// Main Application Entry Point - Minimal Architecture
// ============================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import Stats from 'three/addons/libs/stats.module.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Import modular offset mesh processor
import { createOffsetMesh, extractVertices, cleanup } from './offsetMeshProcessor.js';
import { exportAndDownloadSTL } from './stlExporter.js';
import { verifyWatertightness } from './meshOptimizer.js';

// Add BVH support to BufferGeometry
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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
        
        this.loadedGeometry = null;
        
        // Cache DOM elements
        this.domElements = {};
        
        this.init();
        this.cacheDOMElements();
        this.setupEventListeners();
        this.animate();
    }
    
    cacheDOMElements() {
        this.domElements = {
            fileInput: document.getElementById('file-input'),
            generateBtn: document.getElementById('generate-btn'),
            exportBtn: document.getElementById('export-stl-btn'),
            offsetDistance: document.getElementById('offset-distance'),
            pixelsPerUnit: document.getElementById('heightmap-resolution'),
            rotationXZ: document.getElementById('rotation-xz'),
            rotationYZ: document.getElementById('rotation-yz'),
            simplifyMesh: document.getElementById('simplify-mesh'),
            simplifyRatio: document.getElementById('simplify-ratio'),
            checkManifold: document.getElementById('check-manifold'),
            showOriginal: document.getElementById('show-original'),
            showHeightmap: document.getElementById('show-heightmap'),
            statusLog: document.getElementById('status-log') || document.getElementById('status'),
            progressContainer: document.getElementById('progress-container'),
            progressLabel: document.getElementById('progress-label'),
            progressBar: document.getElementById('progress-bar-fill'),
            progressText: document.getElementById('progress-text')
        };
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
        
        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.PAN,
            RIGHT: THREE.MOUSE.ROTATE
        };
        
        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(10, 10, 10);
        this.scene.add(directionalLight1);
        
        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight2.position.set(-10, -10, -5);
        this.scene.add(directionalLight2);
        
        // Stats
        this.stats = new Stats();
        this.stats.dom.style.position = 'absolute';
        this.stats.dom.style.top = '0px';
        this.stats.dom.style.right = '0px';
        const statsContainer = document.getElementById('stats-container');
        if (statsContainer) {
            statsContainer.appendChild(this.stats.dom);
        }
        
        // Event listeners
        window.addEventListener('resize', () => this.onWindowResize());
        window.addEventListener('keydown', (e) => this.handleKeyDown(e));
        
        this.logStatus('Application initialized. Ready to load STL file.', 'info');
    }
    
    handleKeyDown(event) {
        const panSpeed = 5;
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
        const { fileInput, generateBtn, exportBtn, showOriginal, showHeightmap } = this.domElements;
        
        fileInput?.addEventListener('change', (e) => this.handleFileUpload(e));
        generateBtn?.addEventListener('click', () => this.generateOffset());
        exportBtn?.addEventListener('click', () => this.exportSTL());
        
        showOriginal?.addEventListener('change', (e) => {
            if (this.originalMesh) this.originalMesh.visible = e.target.checked;
        });
        
        showHeightmap?.addEventListener('change', (e) => {
            if (this.offsetMesh) this.offsetMesh.visible = e.target.checked;
        });
    }
    
    getNumericInput(element, defaultValue = 0) {
        const value = parseFloat(element?.value);
        return isNaN(value) ? defaultValue : value;
    }
    
    validatePositiveNumber(value, name) {
        if (isNaN(value) || value <= 0) {
            this.logStatus(`✗ Invalid ${name}`, 'error');
            return false;
        }
        return true;
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
            
            // Center camera on object
            const box = new THREE.Box3().setFromObject(this.originalMesh);
            const center = new THREE.Vector3();
            box.getCenter(center);
            const size = new THREE.Vector3();
            box.getSize(size);
            const maxDim = Math.max(size.x, size.y, size.z);
            
            // Adjust orthographic camera
            const frustumSize = maxDim * 2;
            const aspect = window.innerWidth / window.innerHeight;
            this.camera.left = frustumSize * aspect / -2;
            this.camera.right = frustumSize * aspect / 2;
            this.camera.top = frustumSize / 2;
            this.camera.bottom = frustumSize / -2;
            this.camera.near = maxDim * 0.001;
            this.camera.far = maxDim * 100;
            this.camera.updateProjectionMatrix();
            
            // Position camera
            const distance = maxDim * 1.5;
            this.camera.position.set(center.x + distance, center.y + distance, center.z + distance);
            this.camera.lookAt(center);
            this.controls.target.copy(center);
            this.controls.update();
            
            const triangleCount = geometry.attributes.position.count / 3;
            this.logStatus(`✓ Loaded: ${file.name} (${triangleCount.toLocaleString()} triangles)`, 'success');
            
            if (this.domElements.generateBtn) {
                this.domElements.generateBtn.disabled = false;
            }
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
        
        try {
            // Get parameters from UI using cached elements
            const { offsetDistance, pixelsPerUnit, rotationXZ, rotationYZ, simplifyMesh, simplifyRatio, checkManifold } = this.domElements;
            
            const offsetDist = this.getNumericInput(offsetDistance, 0.2);
            const pixelsUnit = this.getNumericInput(pixelsPerUnit, 10);
            const rotXZ = this.getNumericInput(rotationXZ, 0);
            const rotYZ = this.getNumericInput(rotationYZ, 0);
            
            // Validate inputs
            if (!this.validatePositiveNumber(offsetDist, 'offset distance')) return;
            if (!this.validatePositiveNumber(pixelsUnit, 'pixels per unit')) return;
            
            this.logStatus('Generating offset mesh...', 'info');
            if (rotXZ !== 0 || rotYZ !== 0) {
                this.logStatus(`Projection angle: XZ=${rotXZ}°, YZ=${rotYZ}°`, 'info');
            }
            this.showProgress('Initializing...');
            
            // Extract vertices from the original geometry
            const vertices = extractVertices(this.loadedGeometry);
            
            // Get simplification settings
            const enableSimplify = simplifyMesh?.checked || false;
            const ratio = enableSimplify ? this.getNumericInput(simplifyRatio, 0.5) : null;
            const verifyManifold = checkManifold?.checked || false;
            
            this.logStatus(`Mesh simplification: ${enableSimplify ? `ENABLED (${(ratio * 100).toFixed(0)}%)` : 'DISABLED'}`, 'info');
            if (enableSimplify && verifyManifold) {
                this.logStatus('Manifold verification: ENABLED (will fallback to full mesh if needed)', 'info');
            } else if (enableSimplify && !verifyManifold) {
                this.logStatus('Manifold verification: DISABLED (will use simplified mesh as-is)', 'info');
            }
            
            // Create offset mesh using modular processor (rotation handled internally)
            const result = await createOffsetMesh(vertices, {
                offsetDistance: offsetDist,
                pixelsPerUnit: pixelsUnit,
                simplifyRatio: ratio,
                verifyManifold,
                rotationXZ: rotXZ,
                rotationYZ: rotYZ,
                tileSize: 2048,
                progressCallback: (percent, total, stage) => {
                    this.updateProgress(percent, percent, 100);
                    this.logStatus(stage, 'info');
                }
            });
            
            this.hideProgress();
            
            // Get metadata
            const { metadata } = result;
            const finalGeometry = result.geometry;
            
            // Log simplification results if applied
            if (metadata.simplificationApplied) {
                const reduction = ((1 - metadata.triangleCount / metadata.originalTriangleCount) * 100).toFixed(1);
                this.logStatus(
                    `✓ Mesh simplified: ${metadata.originalTriangleCount.toLocaleString()} → ${metadata.triangleCount.toLocaleString()} triangles (${reduction}% reduction)`,
                    'success'
                );
                this.logStatus(`⏱ Simplification time: ${metadata.simplificationTime.toFixed(0)}ms`, 'info');
            } else if (enableSimplify) {
                this.logStatus('Mesh simplification not applied (check console for details)', 'info');
            }
            
            // Remove previous offset mesh
            if (this.offsetMesh) {
                this.scene.remove(this.offsetMesh);
                if (this.offsetMesh.geometry) this.offsetMesh.geometry.dispose();
                if (this.offsetMesh.material) this.offsetMesh.material.dispose();
                this.offsetMesh = null;
            }
            
            // Create mesh from result
            const material = new THREE.MeshStandardMaterial({
                color: 0xffffff,
                side: THREE.DoubleSide,
                wireframe: false,
                transparent: true,
                opacity: 0.7,
                metalness: 0.0,
                roughness: 0.8
            });
            
            this.offsetMesh = new THREE.Mesh(finalGeometry, material);
            this.offsetMesh.visible = this.domElements.showHeightmap?.checked ?? true;
            this.scene.add(this.offsetMesh);
            
            // Log results with actual final geometry counts
            const finalVertexCount = finalGeometry.getAttribute('position').count;
            const finalTriangleCount = finalGeometry.index.count / 3;
            
            this.logStatus(
                `✓ Offset mesh created: ${finalVertexCount.toLocaleString()} vertices, ` +
                `${finalTriangleCount.toLocaleString()} triangles`,
                'success'
            );
            this.logStatus(
                `⏱ Geometry creation time: ${metadata.geometryCreationTime.toFixed(0)}ms`,
                'info'
            );
            
            // Optional manifold check
            if (verifyManifold) {
                this.logStatus('Performing manifold check...', 'info');
                const manifoldStartTime = performance.now();
                const verification = verifyWatertightness(finalGeometry);
                const manifoldTime = performance.now() - manifoldStartTime;
                
                if (verification.isWatertight) {
                    this.logStatus('✓ Mesh is watertight', 'success');
                } else {
                    this.logStatus('⚠ Warning: Mesh may have gaps', 'info');
                }
                this.logStatus(`⏱ Manifold check time: ${manifoldTime.toFixed(0)}ms`, 'info');
            }
            
            // Enable export button
            if (this.domElements.exportBtn) {
                this.domElements.exportBtn.disabled = false;
            }
            
        } catch (error) {
            this.hideProgress();
            this.logStatus(`✗ Error generating offset: ${error.message}`, 'error');
            console.error('Offset generation error:', error);
        }
    }
    
    async exportSTL() {
        if (!this.offsetMesh) {
            this.logStatus('✗ No offset mesh to export. Generate offset first.', 'error');
            return;
        }
        
        try {
            this.logStatus('Exporting to STL...', 'info');
            this.showProgress('Exporting mesh...');
            
            // Use modular STL exporter
            const result = exportAndDownloadSTL(this.offsetMesh.geometry);
            
            this.hideProgress();
            this.logStatus(
                `✓ STL file downloaded: ${result.filename} (${result.triangleCount.toLocaleString()} triangles)`,
                'success'
            );
            
        } catch (error) {
            this.hideProgress();
            this.logStatus(`✗ Export failed: ${error.message}`, 'error');
            console.error('STL export error:', error);
        }
    }
    
    clearScene() {
        if (this.originalMesh) {
            this.scene.remove(this.originalMesh);
            if (this.originalMesh.geometry) this.originalMesh.geometry.dispose();
            if (this.originalMesh.material) this.originalMesh.material.dispose();
            this.originalMesh = null;
        }
        
        if (this.offsetMesh) {
            this.scene.remove(this.offsetMesh);
            if (this.offsetMesh.geometry) this.offsetMesh.geometry.dispose();
            if (this.offsetMesh.material) this.offsetMesh.material.dispose();
            this.offsetMesh = null;
        }
    }
    
    dispose() {
        this.clearScene();
        
        if (this.loadedGeometry) {
            this.loadedGeometry.dispose();
            this.loadedGeometry = null;
        }
        
        if (this.renderer) {
            this.renderer.dispose();
        }
        
        cleanup(); // Cleanup offset mesh processor resources
    }
    
    // ============================================
    // UI Helper Methods
    // ============================================
    
    logStatus(message, type = 'info') {
        // Always log to console
        console.log(`[${type.toUpperCase()}] ${message}`);
        
        const { statusLog } = this.domElements;
        if (!statusLog) {
            console.warn('Status log element not found in DOM');
            return;
        }
        
        const entry = document.createElement('div');
        entry.className = `log-entry log-${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        
        statusLog.appendChild(entry);
        statusLog.scrollTop = statusLog.scrollHeight;
    }
    
    showProgress(label = 'Processing...') {
        const { progressContainer, progressLabel } = this.domElements;
        if (progressContainer) progressContainer.style.display = 'block';
        if (progressLabel) progressLabel.textContent = label;
    }
    
    updateProgress(percent, current = null, total = null) {
        const { progressBar, progressText } = this.domElements;
        const clampedPercent = Math.min(100, Math.max(0, percent));
        
        if (progressBar) {
            progressBar.style.width = `${clampedPercent}%`;
        }
        
        if (progressText) {
            progressText.textContent = current !== null && total !== null 
                ? `${Math.floor(clampedPercent)}% (${current}/${total})`
                : `${Math.floor(clampedPercent)}%`;
        }
    }
    
    hideProgress() {
        const { progressContainer } = this.domElements;
        if (progressContainer) progressContainer.style.display = 'none';
    }
    
    onWindowResize() {
        const aspect = window.innerWidth / window.innerHeight;
        
        if (this.camera.isOrthographicCamera) {
            const frustumSize = (this.camera.top - this.camera.bottom);
            this.camera.left = frustumSize * aspect / -2;
            this.camera.right = frustumSize * aspect / 2;
        }
        
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
        
        if (this.stats) {
            this.stats.update();
        }
    }
}

// ============================================
// Application Entry Point
// ============================================

window.addEventListener('DOMContentLoaded', () => {
    new OffsetGeneratorApp();
});
