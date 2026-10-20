export function generateId() { 
    return Date.now().toString(36) + Math.random().toString(36).substr(2); 
}

export function getWorldPos(screenX, screenY, camera) {
    return {
        x: (screenX - camera.x) / camera.zoom,
        y: (screenY - camera.y) / camera.zoom
    };
}

export function calcBounds(stroke) {
    if(stroke.type === 'rect' || stroke.type === 'circle') {
        const start = stroke.points[0], end = stroke.points[stroke.points.length-1];
        return { 
            minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), 
            minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) 
        };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
        if(p.x < minX) minX = p.x; if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y; if(p.y > maxY) maxY = p.y;
    });
    return { minX, maxX, minY, maxY };
}

export function rgbToHex(r, g, b) { 
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1); 
}

// Математика для "Заливки" (поиск клика по линии)
export function sqr(x) { return x * x; }
export function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }
export function distToSegmentSquared(p, v, w) {
    let l2 = dist2(v, w);
    if (l2 === 0) return dist2(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}