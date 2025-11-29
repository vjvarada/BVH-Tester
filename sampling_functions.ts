// Advanced sampling functions for high-quality heightmap downsampling
// These are added to the OffsetGeneratorApp class prototype

// Lanczos-2 windowed sinc interpolation - highest quality
function sampleLanczos2(heightMap, resolution, x, y, windowSize) {
    // Lanczos kernel: sinc(x) * sinc(x/a) where a=2
    const lanczos = (x, a = 2) => {
        if (Math.abs(x) < 1e-6) return 1;
        if (Math.abs(x) >= a) return 0;
        const px = Math.PI * x;
        return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
    };
    
    const radius = 2; // Lanczos-2 has radius of 2
    let sum = 0;
    let weightSum = 0;
    
    // Sample in a 4x4 window around the point
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    
    for (let dy = -radius + 1; dy <= radius; dy++) {
        for (let dx = -radius + 1; dx <= radius; dx++) {
            const sx = x0 + dx;
            const sy = y0 + dy;
            
            // Boundary check
            if (sx < 0 || sx >= resolution || sy < 0 || sy >= resolution) continue;
            
            // Compute Lanczos weight
            const distX = x - sx;
            const distY = y - sy;
            const weight = lanczos(distX) * lanczos(distY);
            
            sum += heightMap[sy * resolution + sx] * weight;
            weightSum += weight;
        }
    }
    
    return weightSum > 0 ? sum / weightSum : heightMap[Math.floor(y) * resolution + Math.floor(x)];
}

// Bicubic interpolation - good balance of quality and speed
function sampleBicubic(heightMap, resolution, x, y) {
    // Catmull-Rom cubic interpolation
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
    
    // Sample 4x4 grid
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

// Selective smoothing - only smooth where needed
function selectiveSmooth(heightMap, resolution, edgeThreshold) {
    // Compute local gradients to identify where smoothing is needed
    const needsSmoothing = new Uint8Array(resolution * resolution);
    
    // Detect high-frequency noise (rapid oscillations without strong gradients)
    for (let j = 1; j < resolution - 1; j++) {
        for (let i = 1; i < resolution - 1; i++) {
            const idx = j * resolution + i;
            const center = heightMap[idx];
            
            // Compute local variation
            let variation = 0;
            let count = 0;
            for (let dj = -1; dj <= 1; dj++) {
                for (let di = -1; di <= 1; di++) {
                    if (di === 0 && dj === 0) continue;
                    const neighbor = heightMap[(j + dj) * resolution + (i + di)];
                    variation += Math.abs(neighbor - center);
                    count++;
                }
            }
            variation /= count;
            
            // Compute directional gradient strength
            const gx = heightMap[idx + 1] - heightMap[idx - 1];
            const gy = heightMap[idx + resolution] - heightMap[idx - resolution];
            const gradStrength = Math.sqrt(gx * gx + gy * gy);
            
            // High variation with low gradient suggests noise/aliasing
            if (variation > edgeThreshold * 0.5 && gradStrength < edgeThreshold) {
                needsSmoothing[idx] = 1;
            }
        }
    }
    
    // Apply smoothing only to marked pixels
    const smoothed = new Float32Array(heightMap.length);
    smoothed.set(heightMap); // Copy original
    
    for (let j = 1; j < resolution - 1; j++) {
        for (let i = 1; i < resolution - 1; i++) {
            const idx = j * resolution + i;
            
            if (needsSmoothing[idx]) {
                // Apply 3x3 Gaussian blur
                let sum = 0;
                const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // Normalized Gaussian
                let weightSum = 0;
                let wi = 0;
                
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        const nidx = (j + dj) * resolution + (i + di);
                        sum += heightMap[nidx] * weights[wi];
                        weightSum += weights[wi];
                        wi++;
                    }
                }
                
                smoothed[idx] = sum / weightSum;
            }
        }
    }
    
    heightMap.set(smoothed);
}

// Export functions to be added to OffsetGeneratorApp prototype
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sampleLanczos2,
        sampleBicubic,
        selectiveSmooth
    };
}
