export function drawShape(context, stroke) {
    if (stroke.points.length < 2) return;
    context.globalCompositeOperation = stroke.isEraser ? 'destination-out' : 'source-over';
    context.fillStyle = stroke.color;
    context.strokeStyle = stroke.isEraser ? 'rgba(0,0,0,1)' : stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    const start = stroke.points[0];
    const end = stroke.points[stroke.points.length - 1]; 

    context.beginPath();
    
    if (stroke.type === 'rect') {
        context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.fill();
    } else if (stroke.type === 'circle') {
        const cx = (start.x + end.x) / 2;
        const cy = (start.y + end.y) / 2;
        const rx = Math.abs(end.x - start.x) / 2;
        const ry = Math.abs(end.y - start.y) / 2;
        context.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        context.fill();
    } else if (stroke.type === 'line') {
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
    } else {
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
            context.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
}