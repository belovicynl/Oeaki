const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let redrawPending = false; 
let myId = null;
let mode = 'draw'; 
let currentTool = 'brush';
let lastWorldPos = { x: 0, y: 0 }; 

let myColor = "#000000";
let mySize = 3;
let currentBgColor = "#ffffff";

let myStrokes = [];
let othersStrokes = [];
let otherCursors = {}; 

const spawnRadius = 2000;
const randomAngle = Math.random() * Math.PI * 2;
const randomDist = Math.random() * spawnRadius;
let camera = { 
    x: (window.innerWidth / 2) - (Math.cos(randomAngle) * randomDist), 
    y: (window.innerHeight / 2) - (Math.sin(randomAngle) * randomDist), 
    zoom: 1 
};

let isPanning = false;
let isDrawing = false;
let panStart = { x: 0, y: 0 };
let currentStroke = { type: 'brush', points: [] };
let lastCursorSend = 0;

let initialPinchDist = null;
let initialZoom = 1;

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function getWorldPos(screenX, screenY) {
    return {
        x: (screenX - camera.x) / camera.zoom,
        y: (screenY - camera.y) / camera.zoom
    };
}

function updateStatusUI() {
    const statusEl = document.getElementById('statusText');
    if(statusEl) {
        statusEl.innerText = `Зум: ${Math.round(camera.zoom * 100)}% | ${Math.round(lastWorldPos.x)}, ${Math.round(lastWorldPos.y)}`;
    }
}

function drawShape(context, stroke) {
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
        const radius = Math.hypot(end.x - start.x, end.y - start.y);
        context.arc(start.x, start.y, radius, 0, Math.PI * 2);
        context.fill();
    } else if (stroke.type === 'line') {
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
    } else {
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) context.lineTo(stroke.points[i].x, stroke.points[i].y);
        context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
}

function requestRedraw() {
    if (!redrawPending) { redrawPending = true; requestAnimationFrame(renderCore); }
}

function renderCore() {
    ctx.clearRect(0, 0, canvas.width, canvas.height); 
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    othersStrokes.forEach(stroke => drawShape(ctx, stroke));

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.save(); tCtx.translate(camera.x, camera.y); tCtx.scale(camera.zoom, camera.zoom);
    
    myStrokes.forEach(stroke => drawShape(tCtx, stroke));
    if (currentStroke.points.length > 0) drawShape(tCtx, currentStroke);
    
    tCtx.restore();
    ctx.restore(); 
    ctx.drawImage(tempCanvas, 0, 0);

    ctx.save(); ctx.translate(camera.x, camera.y); ctx.scale(camera.zoom, camera.zoom);
    for (let id in otherCursors) {
        if (id === myId) continue;
        const c = otherCursors[id];
        ctx.beginPath(); ctx.arc(c.x, c.y, 4 / camera.zoom, 0, Math.PI * 2); ctx.fillStyle = c.color; ctx.fill();
    }
    ctx.restore();

    redrawPending = false;
}

function calcBounds(stroke) {
    if(stroke.type === 'rect') {
        const start = stroke.points[0], end = stroke.points[stroke.points.length-1];
        return { 
            minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x), 
            minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y) 
        };
    }
    if (stroke.type === 'circle') {
        const start = stroke.points[0], end = stroke.points[stroke.points.length-1];
        const r = Math.hypot(end.x - start.x, end.y - start.y);
        return { minX: start.x - r, maxX: start.x + r, minY: start.y - r, maxY: start.y + r };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
        if(p.x < minX) minX = p.x; if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y; if(p.y > maxY) maxY = p.y;
    });
    return { minX, maxX, minY, maxY };
}

function isPositionProtected(x, y) {
    const SAFE_ZONE = 30; 
    for (let i = othersStrokes.length - 1; i >= 0; i--) {
        const b = othersStrokes[i].bounds;
        if (!b) continue;
        if (x >= b.minX - SAFE_ZONE && x <= b.maxX + SAFE_ZONE && y >= b.minY - SAFE_ZONE && y <= b.maxY + SAFE_ZONE) {
            return true; 
        }
    }
    return false;
}

socket.on('init_canvas', (data) => { 
    myId = data.myId; 
    othersStrokes = []; myStrokes = [];
    data.strokes.forEach(s => {
        if (!s.strokeId) s.strokeId = 'legacy_' + Math.random().toString(36);
        s.bounds = calcBounds(s); 
        if(s.userId === myId) myStrokes.push(s); else othersStrokes.push(s);
    });
    requestRedraw(); 
});

socket.on('new_stroke', (stroke) => { stroke.bounds = calcBounds(stroke); othersStrokes.push(stroke); requestRedraw(); });
socket.on('wipe_canvas', () => { myStrokes = []; othersStrokes = []; document.body.style.backgroundColor = '#ffffff'; requestRedraw(); });
socket.on('cursor_update', (data) => { otherCursors[data.id] = data; requestRedraw(); });
socket.on('cursor_remove', (id) => { delete otherCursors[id]; requestRedraw(); });

socket.on('remove_stroke', (strokeId) => {
    othersStrokes = othersStrokes.filter(s => s.strokeId !== strokeId);
    requestRedraw();
});
socket.on('stroke_color_changed', (data) => {
    const s = othersStrokes.find(s => s.strokeId === data.strokeId);
    if(s) s.color = data.color;
    requestRedraw();
});

function rgbToHex(r, g, b) { return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1); }

function pickColor(x, y) {
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const hex = px[3] === 0 ? "#ffffff" : rgbToHex(px[0], px[1], px[2]);
    updateGlobalColor(hex); // ОБНОВЛЕНО
}

// Вспомогательные функции для математической заливки
function sqr(x) { return x * x; }
function dist2(v, w) { return sqr(v.x - w.x) + sqr(v.y - w.y); }
function distToSegmentSquared(p, v, w) {
    let l2 = dist2(v, w);
    if (l2 === 0) return dist2(p, v);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return dist2(p, { x: v.x + t * (w.x - v.x), y: v.y + t * (w.y - v.y) });
}

// НОВАЯ МАТЕМАТИЧЕСКАЯ ЗАЛИВКА
function handleFill(worldPos) {
    // Идем с конца, чтобы кликать по самым "верхним" слоям рисунка
    for (let i = myStrokes.length - 1; i >= 0; i--) {
        const s = myStrokes[i];
        if (s.points.length < 2) continue;
        
        const start = s.points[0];
        const end = s.points[s.points.length - 1];
        let hit = false;

        // Попали ли мы в квадрат?
        if (s.type === 'rect') {
            const minX = Math.min(start.x, end.x);
            const maxX = Math.max(start.x, end.x);
            const minY = Math.min(start.y, end.y);
            const maxY = Math.max(start.y, end.y);
            hit = (worldPos.x >= minX && worldPos.x <= maxX && worldPos.y >= minY && worldPos.y <= maxY);
        } 
        // Попали ли мы в круг?
        else if (s.type === 'circle') {
            const radius = Math.hypot(end.x - start.x, end.y - start.y);
            const dist = Math.hypot(worldPos.x - start.x, worldPos.y - start.y);
            hit = (dist <= radius);
        } 
        // Попали ли мы по линии/кисти?
        else {
            const threshold2 = sqr(s.size / 2 + 2); // Точный расчет толщины линии (+2px для легкого клика)
            for (let j = 0; j < s.points.length - 1; j++) {
                if (distToSegmentSquared(worldPos, s.points[j], s.points[j+1]) <= threshold2) {
                    hit = true;
                    break;
                }
            }
        }

        // Если клик успешный — красим именно эту фигуру и отправляем по сети
        if (hit) {
            s.color = myColor; 
            socket.emit('update_stroke_color', { strokeId: s.strokeId, color: myColor });
            requestRedraw();
            return; // Красим только одну фигуру (верхнюю) и останавливаемся
        }
    }
}

function performUndo() {
    if(myStrokes.length > 0) {
        const removed = myStrokes.pop();
        socket.emit('undo_stroke', removed.strokeId);
        requestRedraw();
    }
}

function handleStart(clientX, clientY, isTouch, e) {
    if (mode === 'pan' || (!isTouch && e.button === 1)) {
        isPanning = true; panStart = { x: clientX - camera.x, y: clientY - camera.y }; canvas.style.cursor = 'grabbing';
    } 
    else if (mode === 'draw' && (isTouch || e.button === 0)) {
        const worldPos = getWorldPos(clientX, clientY);
        
        if (currentTool === 'picker') { pickColor(clientX, clientY); return; }
        if (currentTool === 'fill') { handleFill(worldPos); return; }
        
        if (isPositionProtected(worldPos.x, worldPos.y)) return;

        isDrawing = true;
        
        let shapeType = 'brush';
        if (['rect', 'circle', 'line'].includes(currentTool)) shapeType = currentTool;

        currentStroke = { 
            strokeId: generateId(), 
            type: shapeType, 
            points: [worldPos], 
            color: myColor, 
            size: mySize, 
            isEraser: currentTool === 'eraser' 
        };
    }
}

function handleMove(clientX, clientY, e) {
    if (isPanning) { camera.x = clientX - panStart.x; camera.y = clientY - panStart.y; requestRedraw(); return; }

    if(e.target === canvas) {
        const worldPos = getWorldPos(clientX, clientY);
        lastWorldPos = worldPos;
        updateStatusUI();
        const now = Date.now();
        if (now - lastCursorSend > 30) { socket.emit('cursor_move', { x: worldPos.x, y: worldPos.y, color: currentTool === 'eraser' ? '#aaaaaa' : myColor }); lastCursorSend = now; }

        if (isDrawing) {
            if (isPositionProtected(worldPos.x, worldPos.y)) { handleEnd(); return; }
            currentStroke.points.push(worldPos);
            requestRedraw();
        }
    }
}

function handleEnd() {
    if (isPanning) { isPanning = false; canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair'; }
    if (isDrawing && currentStroke.points.length > 1) {
        if(['rect', 'circle', 'line'].includes(currentStroke.type)) {
            currentStroke.points = [currentStroke.points[0], currentStroke.points[currentStroke.points.length-1]];
        }
        currentStroke.bounds = calcBounds(currentStroke);
        myStrokes.push(JSON.parse(JSON.stringify(currentStroke)));
        socket.emit('draw_stroke', currentStroke); 
    }
    isDrawing = false; currentStroke.points = []; requestRedraw();
}

canvas.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY, false, e));
window.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY, e));
window.addEventListener('mouseup', handleEnd);

// ЗУМ МЫШКОЙ
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const wBefore = getWorldPos(e.clientX, e.clientY);
    
    const zoomIntensity = 0.1;
    if (e.deltaY < 0) camera.zoom = Math.min(camera.zoom * (1 + zoomIntensity), 10);
    else camera.zoom = Math.max(camera.zoom * (1 - zoomIntensity), 0.1);
    
    const wAfter = getWorldPos(e.clientX, e.clientY);
    camera.x += (wAfter.x - wBefore.x) * camera.zoom;
    camera.y += (wAfter.y - wBefore.y) * camera.zoom;
    
    updateStatusUI();
    requestRedraw();
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); 
    if (e.touches.length === 2) {
        isDrawing = false; initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); initialZoom = camera.zoom;
    } else {
        handleStart(e.touches[0].clientX, e.touches[0].clientY, true, e);
    }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && initialPinchDist) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const wBefore = getWorldPos(cx, cy);
        camera.zoom = Math.min(Math.max(0.1, initialZoom * (dist / initialPinchDist)), 10);
        const wAfter = getWorldPos(cx, cy);
        camera.x += (wAfter.x - wBefore.x) * camera.zoom;
        camera.y += (wAfter.y - wBefore.y) * camera.zoom;
        updateStatusUI(); 
        requestRedraw();
    } else {
        handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
    }
}, { passive: false });

window.addEventListener('touchend', (e) => { initialPinchDist = null; handleEnd(); });

window.addEventListener('keydown', (e) => {
    if(e.ctrlKey && e.key === 'z') { performUndo(); return; }
    if(document.activeElement.tagName === 'INPUT') return; 

    const key = e.key.toLowerCase();
    if (key === 'b') { mode = 'draw'; setTool('brush'); }
    if (key === 'e') { mode = 'draw'; setTool('eraser'); }
    if (key === 'r') { mode = 'draw'; setTool('rect'); }
    if (key === 'c') { mode = 'draw'; setTool('circle'); }
    if (key === 'l') { mode = 'draw'; setTool('line'); } 
    if (key === 'f') { mode = 'draw'; setTool('fill'); }
    if (key === 'i') { mode = 'draw'; setTool('picker'); }
    if (key === 'h') { document.getElementById('modePan').click(); }
    
    if (key === '=' || key === '+' || key === '-' || key === '0') {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const wBefore = getWorldPos(cx, cy);
        
        if (key === '=' || key === '+') camera.zoom = Math.min(camera.zoom * 1.2, 10);
        if (key === '-') camera.zoom = Math.max(camera.zoom / 1.2, 0.1);
        if (key === '0') camera.zoom = 1;
        
        const wAfter = getWorldPos(cx, cy);
        camera.x += (wAfter.x - wBefore.x) * camera.zoom;
        camera.y += (wAfter.y - wBefore.y) * camera.zoom;
        
        updateStatusUI(); 
        requestRedraw(); 
    }
});

document.getElementById('mobileMenuToggle').addEventListener('click', (e) => { document.querySelector('.ui-left').classList.toggle('show'); });

document.getElementById('modeDraw').addEventListener('click', (e) => {
    mode = 'draw'; e.target.classList.add('active-mode'); document.getElementById('modePan').classList.remove('active-mode'); canvas.style.cursor = 'crosshair';
});
document.getElementById('modePan').addEventListener('click', (e) => {
    mode = 'pan'; e.target.classList.add('active-mode'); document.getElementById('modeDraw').classList.remove('active-mode'); canvas.style.cursor = 'grab';
});

const toolBtns = { 
    'brush': document.getElementById('brushBtn'), 
    'rect': document.getElementById('rectBtn'), 
    'circle': document.getElementById('circleBtn'), 
    'line': document.getElementById('lineBtn'),
    'eraser': document.getElementById('eraserBtn'), 
    'fill': document.getElementById('fillBtn'), 
    'picker': document.getElementById('pickerBtn') 
};

function setTool(newTool) {
    currentTool = newTool;
    for(let key in toolBtns) toolBtns[key].classList.remove('active-tool');
    toolBtns[newTool].classList.add('active-tool');
    if(mode !== 'draw') document.getElementById('modeDraw').click();
}
for (let k in toolBtns) toolBtns[k].addEventListener('click', () => setTool(k));

document.getElementById('undoBtn').addEventListener('click', performUndo);

// === СИНХРОНИЗАЦИЯ ЦВЕТА (ОБА ВАРИАНТА ПАЛИТРЫ) ===
const colorPickerDesktop = document.getElementById('colorPickerDesktop');
const colorPickerMobile = document.getElementById('colorPickerMobile');

function updateGlobalColor(hex) {
    myColor = hex;
    colorPickerDesktop.value = hex;
    colorPickerMobile.value = hex;
    if(currentTool === 'eraser' || currentTool === 'picker') setTool('brush');
}

// Нажатие по квадратикам в мобильной палитре
document.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', (e) => {
        updateGlobalColor(e.target.getAttribute('data-c'));
    });
});

// Ручной выбор цвета на ПК и на телефоне
colorPickerDesktop.addEventListener('input', (e) => updateGlobalColor(e.target.value));
colorPickerMobile.addEventListener('input', (e) => updateGlobalColor(e.target.value));

document.getElementById('sizePicker').addEventListener('input', (e) => { mySize = e.target.value; });

document.getElementById('downloadBtn').addEventListener('click', () => {
    const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    
    tCtx.fillStyle = '#ffffff'; 
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tCtx.drawImage(canvas, 0, 0);
    
    tempCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); 
        link.download = 'Oeaki_Art.png'; 
        link.href = url; 
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        setTimeout(() => URL.revokeObjectURL(url), 100); 
    }, 'image/png');
});

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; updateStatusUI(); requestRedraw(); }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();