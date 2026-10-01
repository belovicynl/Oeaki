const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

let redrawPending = false; 
let myId = null;
let mode = 'draw'; 
let currentTool = 'brush'; 

let myColor = "#000000";
let mySize = 3;
let currentBgColor = "#ffffff";

let myStrokes = [];
let othersStrokes = [];
let otherCursors = {}; 

// Случайный спавн при входе (радиус 2000px)
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

// Для Pinch-to-zoom на телефоне
let initialPinchDist = null;
let initialZoom = 1;

// Генератор уникальных ID для отмены (Undo)
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function getWorldPos(screenX, screenY) {
    return {
        x: (screenX - camera.x) / camera.zoom,
        y: (screenY - camera.y) / camera.zoom
    };
}

// === РЕНДЕР И ОТРИСОВКА ===
function drawShape(context, stroke) {
    if (stroke.points.length < 2) return;
    context.globalCompositeOperation = stroke.isEraser ? 'destination-out' : 'source-over';
    context.fillStyle = stroke.color;
    context.strokeStyle = stroke.isEraser ? 'rgba(0,0,0,1)' : stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    if (stroke.type === 'rect') {
        const start = stroke.points[0];
        const end = stroke.points[1];
        context.beginPath();
        context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.fill();
    } else {
        context.beginPath();
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

    // Чужие рисунки
    othersStrokes.forEach(stroke => drawShape(ctx, stroke));

    // Свои рисунки (на скрытом холсте для правильной работы ластика)
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

// === АНТИ-ВАНДАЛИЗМ (Приватные зоны) ===
function calcBounds(stroke) {
    if(stroke.type === 'rect') {
        const x1 = stroke.points[0].x, x2 = stroke.points[1].x;
        const y1 = stroke.points[0].y, y2 = stroke.points[1].y;
        return { minX: Math.min(x1, x2), maxX: Math.max(x1, x2), minY: Math.min(y1, y2), maxY: Math.max(y1, y2) };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    stroke.points.forEach(p => {
        if(p.x < minX) minX = p.x; if(p.x > maxX) maxX = p.x;
        if(p.y < minY) minY = p.y; if(p.y > maxY) maxY = p.y;
    });
    return { minX, maxX, minY, maxY };
}

function isPositionProtected(x, y) {
    const SAFE_ZONE = 30; // 30px защитное поле вокруг чужого
    for (let i = othersStrokes.length - 1; i >= 0; i--) {
        const b = othersStrokes[i].bounds;
        if (!b) continue;
        if (x >= b.minX - SAFE_ZONE && x <= b.maxX + SAFE_ZONE && y >= b.minY - SAFE_ZONE && y <= b.maxY + SAFE_ZONE) {
            return true; // Зона занята
        }
    }
    return false;
}

// === СОКЕТЫ ===
socket.on('init_canvas', (data) => { 
    myId = data.myId; 
    othersStrokes = []; myStrokes = [];
    data.strokes.forEach(s => {
        if (!s.strokeId) s.strokeId = 'legacy_' + Math.random().toString(36);
	s.bounds = calcBounds(s); // Предрасчет габаритов
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

// === ИНСТРУМЕНТЫ (Пипетка, Заливка, Отмена) ===
function rgbToHex(r, g, b) { return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1); }

function pickColor(x, y) {
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const hex = px[3] === 0 ? currentBgColor : rgbToHex(px[0], px[1], px[2]);
    document.getElementById('colorPicker').value = hex; myColor = hex;
    setTool('brush');
}

function handleFill(worldPos) {
    // Проверяем клик по СВОИМ прямоугольникам (с конца, чтобы брать верхние)
    for (let i = myStrokes.length - 1; i >= 0; i--) {
        const s = myStrokes[i];
        if (s.type === 'rect') {
            const minX = Math.min(s.points[0].x, s.points[1].x); const maxX = Math.max(s.points[0].x, s.points[1].x);
            const minY = Math.min(s.points[0].y, s.points[1].y); const maxY = Math.max(s.points[0].y, s.points[1].y);
            if (worldPos.x >= minX && worldPos.x <= maxX && worldPos.y >= minY && worldPos.y <= maxY) {
                s.color = myColor; // Перекрашиваем
                socket.emit('update_stroke_color', { strokeId: s.strokeId, color: myColor });
                requestRedraw();
                return;
            }
        }
    }
    // Если мимо квадратов — заливаем свой локальный фон
    currentBgColor = myColor;
    document.body.style.backgroundColor = currentBgColor;
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
        
        // Проверка привата! Если кликаем в чужую зону — блок.
        if (isPositionProtected(worldPos.x, worldPos.y)) return;

        isDrawing = true;
        currentStroke = { strokeId: generateId(), type: currentTool === 'rect' ? 'rect' : 'brush', points: [worldPos], color: myColor, size: mySize, isEraser: currentTool === 'eraser' };
    }
}

function handleMove(clientX, clientY, e) {
    if (isPanning) { camera.x = clientX - panStart.x; camera.y = clientY - panStart.y; requestRedraw(); return; }

    if(e.target === canvas) {
        const worldPos = getWorldPos(clientX, clientY);
        const now = Date.now();
        if (now - lastCursorSend > 30) { socket.emit('cursor_move', { x: worldPos.x, y: worldPos.y, color: currentTool === 'eraser' ? '#aaaaaa' : myColor }); lastCursorSend = now; }

        if (isDrawing) {
            // Если в процессе рисования линия залезла в чужой приват - обрываем линию
            if (isPositionProtected(worldPos.x, worldPos.y)) { handleEnd(); return; }
            currentStroke.points.push(worldPos);
            requestRedraw();
        }
    }
}

function handleEnd() {
    if (isPanning) { isPanning = false; canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair'; }
    if (isDrawing && currentStroke.points.length > 1) {
        if(currentStroke.type === 'rect') currentStroke.points = [currentStroke.points[0], currentStroke.points[currentStroke.points.length-1]];
        currentStroke.bounds = calcBounds(currentStroke);
        myStrokes.push(JSON.parse(JSON.stringify(currentStroke)));
        socket.emit('draw_stroke', currentStroke); 
    }
    isDrawing = false; currentStroke.points = []; requestRedraw();
}

// Привязка мыши
canvas.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY, false, e));
window.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY, e));
window.addEventListener('mouseup', handleEnd);

// Привязка пальцев (и щипка для зума)
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
        camera.zoom = Math.min(Math.max(0.1, initialZoom * (dist / initialPinchDist)), 10);
        requestRedraw();
    } else {
        handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
    }
}, { passive: false });

window.addEventListener('touchend', (e) => { initialPinchDist = null; handleEnd(); });

// === ГОРЯЧИЕ КЛАВИШИ ===
window.addEventListener('keydown', (e) => {
    if(e.ctrlKey && e.key === 'z') { performUndo(); return; }
    
    // Фокус с инпутов снимаем, чтобы текст не писался туда
    if(document.activeElement.tagName === 'INPUT') return; 

    const key = e.key.toLowerCase();
    if (key === 'b') { mode = 'draw'; setTool('brush'); }
    if (key === 'e') { mode = 'draw'; setTool('eraser'); }
    if (key === 'r') { mode = 'draw'; setTool('rect'); }
    if (key === 'f') { mode = 'draw'; setTool('fill'); }
    if (key === 'i') { mode = 'draw'; setTool('picker'); }
    if (key === 'h') { document.getElementById('modePan').click(); }
    
    // ЗУМ с клавиатуры (+, -, 0)
    if (key === '=' || key === '+') { camera.zoom = Math.min(camera.zoom * 1.2, 10); requestRedraw(); }
    if (key === '-') { camera.zoom = Math.max(camera.zoom / 1.2, 0.1); requestRedraw(); }
    if (key === '0') { 
        // Сброс зума, НО остаемся в тех координатах мира, где стояли
        camera.zoom = 1; requestRedraw(); 
    }
});

// === UI КНОПКИ ===
document.getElementById('mobileMenuToggle').addEventListener('click', (e) => { document.querySelector('.ui-left').classList.toggle('show'); });

document.getElementById('modeDraw').addEventListener('click', (e) => {
    mode = 'draw'; e.target.classList.add('active-mode'); document.getElementById('modePan').classList.remove('active-mode'); canvas.style.cursor = 'crosshair';
});
document.getElementById('modePan').addEventListener('click', (e) => {
    mode = 'pan'; e.target.classList.add('active-mode'); document.getElementById('modeDraw').classList.remove('active-mode'); canvas.style.cursor = 'grab';
});

const toolBtns = { 'brush': document.getElementById('brushBtn'), 'rect': document.getElementById('rectBtn'), 'eraser': document.getElementById('eraserBtn'), 'fill': document.getElementById('fillBtn'), 'picker': document.getElementById('pickerBtn') };
function setTool(newTool) {
    currentTool = newTool;
    for(let key in toolBtns) toolBtns[key].classList.remove('active-tool');
    toolBtns[newTool].classList.add('active-tool');
    if(mode !== 'draw') document.getElementById('modeDraw').click();
}
for(let k in toolBtns) toolBtns[key = k].addEventListener('click', () => setTool(key));

document.getElementById('undoBtn').addEventListener('click', performUndo);
document.getElementById('colorPicker').addEventListener('input', (e) => { myColor = e.target.value; if(currentTool === 'eraser' || currentTool === 'picker') setTool('brush'); });
document.getElementById('sizePicker').addEventListener('input', (e) => { mySize = e.target.value; });

document.getElementById('downloadBtn').addEventListener('click', () => {
    const tempCanvas = document.createElement('canvas'); tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    tCtx.fillStyle = currentBgColor; tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tCtx.drawImage(canvas, 0, 0);
    const link = document.createElement('a'); link.download = 'Oeaki_Art.png'; link.href = tempCanvas.toDataURL('image/png'); link.click();
});

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; requestRedraw(); }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();