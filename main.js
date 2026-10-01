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
        // УБРАНЫ СКОБКИ!
        statusEl.innerText = `Зум: ${Math.round(camera.zoom * 100)}% | ${Math.round(lastWorldPos.x)}, ${Math.round(lastWorldPos.y)}`;
    }
}

// === РЕНДЕР И ОТРИСОВКА (ДОБАВЛЕНЫ КРУГ И ЛИНИЯ) ===
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

// === АНТИ-ВАНДАЛИЗМ (ОБНОВЛЕНО ДЛЯ КРУГОВ И ЛИНИЙ) ===
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
    document.getElementById('colorPicker').value = hex; myColor = hex;
    setTool('brush');
}

// === НОВАЯ ЗАЛИВКА (ЗАКРАШИВАЕТ ТОЛЬКО СВОИ ФИГУРЫ) ===
function handleFill(worldPos) {
    const tCanvas = document.createElement('canvas');
    const tCtx = tCanvas.getContext('2d');
    
    // Идем с конца, чтобы кликать по самым верхним фигурам
    for (let i = myStrokes.length - 1; i >= 0; i--) {
        const s = myStrokes[i];
        if (s.points.length < 2) continue;
        
        tCtx.beginPath();
        const start = s.points[0];
        const end = s.points[s.points.length - 1];
        let hit = false;

        if (s.type === 'rect') {
            tCtx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
            hit = tCtx.isPointInPath(worldPos.x, worldPos.y);
        } else if (s.type === 'circle') {
            const radius = Math.hypot(end.x - start.x, end.y - start.y);
            tCtx.arc(start.x, start.y, radius, 0, Math.PI * 2);
            hit = tCtx.isPointInPath(worldPos.x, worldPos.y);
        } else {
            // Для линий и кистей проверяем попадание прямо в линию
            tCtx.lineWidth = s.size;
            tCtx.lineCap = 'round';
            tCtx.lineJoin = 'round';
            tCtx.moveTo(s.points[0].x, s.points[0].y);
            for (let j = 1; j < s.points.length; j++) tCtx.lineTo(s.points[j].x, s.points[j].y);
            hit = tCtx.isPointInStroke(worldPos.x, worldPos.y);
        }

        if (hit) {
            s.color = myColor; 
            socket.emit('update_stroke_color', { strokeId: s.strokeId, color: myColor });
            requestRedraw();
            return; // Закрасили 1 фигуру и остановились
        }
    }
    // Белый фон больше не трогаем!
}

function performUndo() {
    if(myStrokes.length > 0) {
        const removed = myStrokes.pop();
        socket.emit('undo_stroke', removed.strokeId);
        requestRedraw();
    }
}

// === УПРАВЛЕНИЕ ===
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

// === ЗУМ КОЛЕСИКОМ МЫШИ (НОВОЕ) ===
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
    if (key === 'c') { mode = 'draw'; setTool('circle'); } // Горячая клавиша C
    if (key === 'l') { mode = 'draw'; setTool('line'); }   // Горячая клавиша L
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

// ОБЩИЙ СТИЛЬ ДЛЯ КНОПОК РЕЖИМА
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

// ЛОГИКА НОВОЙ ПАЛИТРЫ
document.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', (e) => {
        myColor = e.target.getAttribute('data-c');
        document.getElementById('colorPicker').value = myColor;
        if(currentTool === 'eraser' || currentTool === 'picker') setTool('brush');
    });
});
document.getElementById('colorPicker').addEventListener('input', (e) => { myColor = e.target.value; if(currentTool === 'eraser' || currentTool === 'picker') setTool('brush'); });
document.getElementById('sizePicker').addEventListener('input', (e) => { mySize = e.target.value; });

// === ФИКС СКАЧИВАНИЯ ДЛЯ FIREFOX (КРАШИ) ===
document.getElementById('downloadBtn').addEventListener('click', () => {
    const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    
    tCtx.fillStyle = '#ffffff'; // ХОЛСТ ВСЕГДА БЕЛЫЙ ПРИ СКАЧИВАНИИ
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
        
        setTimeout(() => URL.revokeObjectURL(url), 100); // ОЧИСТКА ПАМЯТИ FIREFOX
    }, 'image/png');
});

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; updateStatusUI(); requestRedraw(); }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();