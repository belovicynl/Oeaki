import { generateId, getWorldPos, calcBounds, rgbToHex, sqr, distToSegmentSquared } from './utils.js';
import { drawShape } from './render.js';

const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// --- Состояние приложения ---
const state = {
    redrawPending: false,
    myId: null,
    mode: 'draw',
    currentTool: 'brush',
    lastWorldPos: { x: 0, y: 0 },
    myColor: "#000000",
    mySize: 3,
    strokes: [],
    myStrokeIds: [],
    otherCursors: {},
    camera: { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 },
    isPanning: false,
    isDrawing: false,
    panStart: { x: 0, y: 0 },
    currentStroke: { type: 'brush', points: [] },
    lastCursorSend: 0,
    initialPinchDist: null,
    initialZoom: 1
};

// --- Отрисовка ---
function requestRedraw() {
    if (!state.redrawPending) { 
        state.redrawPending = true; 
        requestAnimationFrame(renderCore); 
    }
}

function renderCore() {
    ctx.fillStyle = '#ffffff'; 
    ctx.fillRect(0, 0, canvas.width, canvas.height); 
    
    const viewMinX = -state.camera.x / state.camera.zoom;
    const viewMinY = -state.camera.y / state.camera.zoom;
    const viewMaxX = (canvas.width - state.camera.x) / state.camera.zoom;
    const viewMaxY = (canvas.height - state.camera.y) / state.camera.zoom;

    ctx.save();
    ctx.translate(state.camera.x, state.camera.y);
    ctx.scale(state.camera.zoom, state.camera.zoom);

    state.strokes.forEach(stroke => {
        if (!stroke.bounds) return;
        const b = stroke.bounds;
        if (b.maxX >= viewMinX && b.minX <= viewMaxX && b.maxY >= viewMinY && b.minY <= viewMaxY) {
            drawShape(ctx, stroke);
        }
    });

    if (state.currentStroke.points.length > 0) drawShape(ctx, state.currentStroke);
    ctx.restore(); 

    // Отрисовка курсоров других людей
    ctx.save(); 
    ctx.translate(state.camera.x, state.camera.y); 
    ctx.scale(state.camera.zoom, state.camera.zoom);
    
    for (let id in state.otherCursors) {
        if (id === state.myId) continue;
        const c = state.otherCursors[id];
        ctx.beginPath(); 
        ctx.arc(c.x, c.y, 4 / state.camera.zoom, 0, Math.PI * 2); 
        ctx.fillStyle = c.color; 
        ctx.fill();
    }
    ctx.restore();

    state.redrawPending = false;
}

// --- Сетевые события (Socket.IO) ---
socket.on('init_canvas', (data) => { 
    state.myId = data.myId; 
    state.strokes = data.strokes; 
    state.strokes.forEach(s => { if(!s.bounds) s.bounds = calcBounds(s); });
    state.myStrokeIds = state.strokes.filter(s => s.userId === state.myId).map(s => s.strokeId);
    requestRedraw(); 
});

socket.on('new_stroke', (stroke) => { 
    if(!stroke.bounds) stroke.bounds = calcBounds(stroke);
    state.strokes.push(stroke); 
    requestRedraw(); 
});

socket.on('wipe_canvas', () => { state.strokes = []; state.myStrokeIds = []; requestRedraw(); });
socket.on('cursor_update', (data) => { state.otherCursors[data.id] = data; requestRedraw(); });
socket.on('cursor_remove', (id) => { delete state.otherCursors[id]; requestRedraw(); });

socket.on('remove_stroke', (strokeId) => {
    state.strokes = state.strokes.filter(s => s.strokeId !== strokeId);
    requestRedraw(); 
});

socket.on('stroke_color_changed', (data) => {
    const s = state.strokes.find(s => s.strokeId === data.strokeId);
    if(s) s.color = data.color;
    requestRedraw(); 
});

// --- Инструменты (Пипетка, Заливка, Отмена) ---
function pickColor(x, y) {
    const px = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    const hex = px[3] === 0 ? "#ffffff" : rgbToHex(px[0], px[1], px[2]);
    document.getElementById('colorPicker').value = hex; 
    state.myColor = hex;
    setTool('brush');
}

function handleFill(worldPos) {
    for (let i = state.strokes.length - 1; i >= 0; i--) {
        const s = state.strokes[i];
        if (s.points.length < 2 || s.isEraser) continue;
        
        const start = s.points[0];
        const end = s.points[s.points.length - 1];
        let hit = false;

        if (s.type === 'rect') {
            const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
            const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
            hit = (worldPos.x >= minX && worldPos.x <= maxX && worldPos.y >= minY && worldPos.y <= maxY);
        } else if (s.type === 'circle') {
            const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
            const rx = Math.abs(end.x - start.x) / 2, ry = Math.abs(end.y - start.y) / 2;
            if (rx > 0 && ry > 0) {
                hit = ((sqr(worldPos.x - cx) / sqr(rx)) + (sqr(worldPos.y - cy) / sqr(ry))) <= 1;
            }
        } else {
            const threshold2 = sqr(s.size / 2 + 2); 
            for (let j = 0; j < s.points.length - 1; j++) {
                if (distToSegmentSquared(worldPos, s.points[j], s.points[j+1]) <= threshold2) {
                    hit = true; break;
                }
            }
        }

        if (hit) {
            s.color = state.myColor; 
            socket.emit('update_stroke_color', { strokeId: s.strokeId, color: state.myColor });
            requestRedraw(); return; 
        }
    }
}

function performUndo() {
    if(state.myStrokeIds.length > 0) {
        const idToRemove = state.myStrokeIds.pop();
        state.strokes = state.strokes.filter(s => s.strokeId !== idToRemove);
        socket.emit('undo_stroke', idToRemove);
        requestRedraw();
    }
}

// --- Управление UI и событиями ---
function updateStatusUI() {
    const statusEl = document.getElementById('statusText');
    if(statusEl) {
        statusEl.innerText = `Зум: ${Math.round(state.camera.zoom * 100)}% | ${Math.round(state.lastWorldPos.x)}, ${Math.round(state.lastWorldPos.y)}`;
    }
}

function setTool(newTool) {
    state.currentTool = newTool;
    const toolBtns = { 'brush': 'brushBtn', 'rect': 'rectBtn', 'circle': 'circleBtn', 'line': 'lineBtn', 'eraser': 'eraserBtn', 'fill': 'fillBtn', 'picker': 'pickerBtn' };
    
    Object.values(toolBtns).forEach(id => document.getElementById(id).classList.remove('active-tool'));
    document.getElementById(toolBtns[newTool]).classList.add('active-tool');
    
    if(state.mode !== 'draw') document.getElementById('modeDraw').click();
}

function handleStart(clientX, clientY, isTouch, e) {
    if (state.mode === 'pan' || (!isTouch && e.button === 1)) {
        state.isPanning = true; 
        state.panStart = { x: clientX - state.camera.x, y: clientY - state.camera.y }; 
        canvas.style.cursor = 'grabbing';
    } else if (state.mode === 'draw' && (isTouch || e.button === 0)) {
        const worldPos = getWorldPos(clientX, clientY, state.camera);
        
        if (state.currentTool === 'picker') return pickColor(clientX, clientY);
        if (state.currentTool === 'fill') return handleFill(worldPos);

        state.isDrawing = true;
        let shapeType = ['rect', 'circle', 'line'].includes(state.currentTool) ? state.currentTool : 'brush';

        state.currentStroke = { 
            strokeId: generateId(), 
            type: shapeType, 
            points: [worldPos], 
            color: state.myColor, 
            size: state.mySize, 
            isEraser: state.currentTool === 'eraser',
            userId: state.myId 
        };
    }
}

function handleMove(clientX, clientY, e) {
    if (state.isPanning) { 
        state.camera.x = clientX - state.panStart.x; 
        state.camera.y = clientY - state.panStart.y; 
        return requestRedraw(); 
    }

    if(e.target === canvas) {
        const worldPos = getWorldPos(clientX, clientY, state.camera);
        state.lastWorldPos = worldPos;
        updateStatusUI();
        
        const now = Date.now();
        if (now - state.lastCursorSend > 30) { 
            socket.emit('cursor_move', { x: worldPos.x, y: worldPos.y, color: state.currentTool === 'eraser' ? '#aaaaaa' : state.myColor }); 
            state.lastCursorSend = now; 
        }

        if (state.isDrawing) {
            state.currentStroke.points.push(worldPos);
            requestRedraw();
        }
    }
}

function handleEnd() {
    if (state.isPanning) { 
        state.isPanning = false; 
        canvas.style.cursor = state.mode === 'pan' ? 'grab' : 'crosshair'; 
    }
    
    if (state.isDrawing && state.currentStroke.points.length > 1) {
        if(['rect', 'circle', 'line'].includes(state.currentStroke.type)) {
            state.currentStroke.points = [state.currentStroke.points[0], state.currentStroke.points[state.currentStroke.points.length-1]];
        }
        state.currentStroke.bounds = calcBounds(state.currentStroke);
        state.strokes.push(JSON.parse(JSON.stringify(state.currentStroke)));
        state.myStrokeIds.push(state.currentStroke.strokeId);
        socket.emit('draw_stroke', state.currentStroke); 
    }
    state.isDrawing = false; 
    state.currentStroke.points = []; 
    requestRedraw();
}

// --- Бинды событий DOM ---
canvas.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY, false, e));
window.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY, e));
window.addEventListener('mouseup', handleEnd);

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const wBefore = getWorldPos(e.clientX, e.clientY, state.camera);
    state.camera.zoom = e.deltaY < 0 ? Math.min(state.camera.zoom + 0.1, 10) : Math.max(state.camera.zoom - 0.1, 0.1);
    state.camera.zoom = Math.round(state.camera.zoom * 10) / 10;
    
    const wAfter = getWorldPos(e.clientX, e.clientY, state.camera);
    state.camera.x += (wAfter.x - wBefore.x) * state.camera.zoom;
    state.camera.y += (wAfter.y - wBefore.y) * state.camera.zoom;
    
    updateStatusUI();
    requestRedraw();
}, { passive: false });

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); 
    if (e.touches.length === 2) {
        state.isDrawing = false; 
        state.initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); 
        state.initialZoom = state.camera.zoom;
    } else {
        handleStart(e.touches[0].clientX, e.touches[0].clientY, true, e);
    }
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 2 && state.initialPinchDist) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        const wBefore = getWorldPos(cx, cy, state.camera);
        
        state.camera.zoom = Math.min(Math.max(0.1, state.initialZoom * (dist / state.initialPinchDist)), 10);
        const wAfter = getWorldPos(cx, cy, state.camera);
        state.camera.x += (wAfter.x - wBefore.x) * state.camera.zoom;
        state.camera.y += (wAfter.y - wBefore.y) * state.camera.zoom;
        
        updateStatusUI(); requestRedraw();
    } else {
        handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
    }
}, { passive: false });

window.addEventListener('touchend', () => { state.initialPinchDist = null; handleEnd(); });

window.addEventListener('keydown', (e) => {
    if(e.ctrlKey && e.key === 'z') return performUndo(); 
    if(document.activeElement.tagName === 'INPUT') return; 

    const key = e.key.toLowerCase();
    const modes = { 'b':'brush', 'e':'eraser', 'r':'rect', 'c':'circle', 'l':'line', 'f':'fill', 'i':'picker' };
    
    if (modes[key]) { state.mode = 'draw'; setTool(modes[key]); }
    if (key === 'h') document.getElementById('modePan').click();
    
    if (['=', '+', '-', '0'].includes(key)) {
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const wBefore = getWorldPos(cx, cy, state.camera);
        
        if (key === '=' || key === '+') state.camera.zoom = Math.min(state.camera.zoom + 0.1, 10);
        if (key === '-') state.camera.zoom = Math.max(state.camera.zoom - 0.1, 0.1);
        if (key === '0') state.camera.zoom = 1;
        
        state.camera.zoom = Math.round(state.camera.zoom * 10) / 10;
        const wAfter = getWorldPos(cx, cy, state.camera);
        state.camera.x += (wAfter.x - wBefore.x) * state.camera.zoom;
        state.camera.y += (wAfter.y - wBefore.y) * state.camera.zoom;
        
        updateStatusUI(); requestRedraw(); 
    }
});

// Кнопки интерфейса
document.getElementById('brushBtn').addEventListener('click', () => setTool('brush'));
document.getElementById('rectBtn').addEventListener('click', () => setTool('rect'));
document.getElementById('circleBtn').addEventListener('click', () => setTool('circle'));
document.getElementById('lineBtn').addEventListener('click', () => setTool('line'));
document.getElementById('eraserBtn').addEventListener('click', () => setTool('eraser'));
document.getElementById('fillBtn').addEventListener('click', () => setTool('fill'));
document.getElementById('pickerBtn').addEventListener('click', () => setTool('picker'));
document.getElementById('undoBtn').addEventListener('click', performUndo);

document.getElementById('modeDraw').addEventListener('click', (e) => {
    state.mode = 'draw'; 
    e.target.classList.add('active-mode'); 
    document.getElementById('modePan').classList.remove('active-mode'); 
    canvas.style.cursor = 'crosshair';
});

document.getElementById('modePan').addEventListener('click', (e) => {
    state.mode = 'pan'; 
    e.target.classList.add('active-mode'); 
    document.getElementById('modeDraw').classList.remove('active-mode'); 
    canvas.style.cursor = 'grab';
});

document.getElementById('colorPicker').addEventListener('input', (e) => { 
    state.myColor = e.target.value; 
    if(state.currentTool === 'eraser' || state.currentTool === 'picker') setTool('brush'); 
});

document.getElementById('sizePicker').addEventListener('input', (e) => { state.mySize = e.target.value; });

document.getElementById('resetZoomBtn').addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', {key: '0'})));
document.getElementById('mobileMenuToggle').addEventListener('click', (e) => { 
    document.querySelector('.ui-left').classList.toggle('show'); 
    e.currentTarget.classList.toggle('pressed'); 
});

document.getElementById('downloadBtn').addEventListener('click', () => {
    const tempCanvas = document.createElement('canvas'); 
    tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    
    tCtx.fillStyle = '#ffffff'; tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tCtx.drawImage(canvas, 0, 0); 
    
    tempCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a'); link.download = 'Oeaki_Art.png'; link.href = url; 
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 100); 
    }, 'image/png');
});

function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; updateStatusUI(); requestRedraw(); }
window.addEventListener('resize', resizeCanvas);
resizeCanvas();