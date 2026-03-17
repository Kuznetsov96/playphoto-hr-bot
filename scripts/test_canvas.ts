import { createCanvas } from 'canvas';
import fs from 'fs';

try {
    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'red';
    ctx.fillRect(0, 0, 200, 200);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync('canvas-test.png', buffer);
    console.log('✅ Canvas test passed. Image saved to canvas-test.png');
} catch (e) {
    console.error('❌ Canvas test failed:', e);
}
