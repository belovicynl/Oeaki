const socket = io();
const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// === ПЕРЕМЕННЫЕ ===
let redrawPending = false; 
let myId = null;
let mode = 'draw'; 
let currentTool = 'brush'; // 'brush', 'rect', 'eraser', 'picker'

let myColor = "#0088ff";
let mySize = 5;
let currentBgColor = "#ffffff";
let hideOthersGlobal = false;
let hiddenUsers = new Set(); 

let myStrokes = [];
let othersStrokes = [];
let otherCursors = {}; 

let camera = { x: window.innerWidth / 2, y: window.innerHeight / 2, zoom: 1 };
let isPanning = false;
let isDrawing = false;
let panStart = { x: 0, y: 0 };
let currentStroke = { type: 'brush', points: [] };

let lastCursorSend = 0;

// === БАЗОВЫЕ ФУНКЦИИ ===
function getWorldPos(screenX, screenY) {
    return {
        x: (screenX - camera.x) / camera.zoom,
        y: (screenY - camera.y) / camera.zoom
    };
}

function requestRedraw() {
    if (!redrawPending) {
        redrawPending = true;
        requestAnimationFrame(renderCore);
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

    if (stroke.type === 'rect') {
        const start = stroke.points[0];
        const end = stroke.points[stroke.points.length - 1];
        context.beginPath();
        context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
        context.fill();
    } else {
        context.beginPath();
        context.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
            context.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        context.stroke();
    }
    context.globalCompositeOperation = 'source-over';
}

function renderCore() {
    ctx.clearRect(0, 0, canvas.width, canvas.height); 
    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);

    if (!hideOthersGlobal) {
        othersStrokes.forEach(stroke => {
            if (stroke.userId !== myId && !hiddenUsers.has(stroke.userId)) drawShape(ctx, stroke);
        });
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width; tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    
    tCtx.save();
    tCtx.translate(camera.x, camera.y);
    tCtx.scale(camera.zoom, camera.zoom);
    
    myStrokes.forEach(stroke => drawShape(tCtx, stroke));
    if (currentStroke.points.length > 0) drawShape(tCtx, currentStroke);
    tCtx.restore();

    ctx.restore(); 
    ctx.drawImage(tempCanvas, 0, 0);

    ctx.save();
    ctx.translate(camera.x, camera.y);
    ctx.scale(camera.zoom, camera.zoom);
    if (!hideOthersGlobal) {
        for (let id in otherCursors) {
            if (hiddenUsers.has(id) || id === myId) continue; 
            const c = otherCursors[id];
            ctx.beginPath();
            ctx.arc(c.x, c.y, 5 / camera.zoom, 0, Math.PI * 2);
            ctx.fillStyle = c.color;
            ctx.fill();
        }
    }
    ctx.restore();

    redrawPending = false;
}

function updateZoomDisplay() {
    document.getElementById('zoomDisplay').innerText = Math.round(camera.zoom * 100) + '%';
}

// === СОКЕТЫ ===
socket.on('init_canvas', (data) => { 
    myId = data.myId; 
    othersStrokes = [];
    myStrokes = [];
    data.strokes.forEach(s => {
        if(s.userId === myId) myStrokes.push(s);
        else othersStrokes.push(s);
    });
    requestRedraw(); 
});

socket.on('new_stroke', (stroke) => { othersStrokes.push(stroke); requestRedraw(); });
socket.on('wipe_canvas', () => { myStrokes = []; othersStrokes = []; requestRedraw(); });
socket.on('cursor_update', (data) => { otherCursors[data.id] = data; requestRedraw(); });
socket.on('cursor_remove', (id) => { delete otherCursors[id]; requestRedraw(); });

socket.on('update_users', (users) => {
    const listDiv = document.getElementById('usersList');
    if(!listDiv) return;
    listDiv.innerHTML = '';
    let count = 0;

    for (let id in users) {
        count++;
        if (id === myId) continue; 

        const div = document.createElement('div');
        div.className = 'user-item';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !hiddenUsers.has(id); 
        
        checkbox.addEventListener('change', (e) => {
            if (e.target.checked) hiddenUsers.delete(id);
            else hiddenUsers.add(id);
            requestRedraw(); 
        });

        const label = document.createElement('label');
        label.innerText = 'Игрок ' + id; 

        div.appendChild(checkbox);
        div.appendChild(label);
        listDiv.appendChild(div);
    }
    document.getElementById('onlineCounter').innerText = `Онлайн: ${count}`;
});

// === ИСПРАВЛЕННАЯ ПИПЕТКА ===
function rgbToHex(r, g, b) {
    // Надежный способ перевода в HEX с сохранением нулей
    return "#" + (1 << 24 | r << 16 | g << 8 | b).toString(16).slice(1);
}

function pickColor(clientX, clientY) {
    const pixelData = ctx.getImageData(Math.round(clientX), Math.round(clientY), 1, 1).data;
    if(pixelData[3] === 0) { // Если пиксель прозрачный, берем цвет фона
        document.getElementById('colorPicker').value = currentBgColor;
        myColor = currentBgColor;
    } else {
        const hex = rgbToHex(pixelData[0], pixelData[1], pixelData[2]);
        document.getElementById('colorPicker').value = hex;
        myColor = hex;
    }
    setTool('brush'); // Сразу возвращаемся на кисть
}

// === УПРАВЛЕНИЕ ===
function handleStart(clientX, clientY, isTouch, e) {
    if (mode === 'pan' || (!isTouch && e.button === 1) || (isTouch && e.touches && e.touches.length > 1)) {
        isPanning = true;
        panStart = { x: clientX - camera.x, y: clientY - camera.y };
        canvas.style.cursor = 'grabbing';
    } 
    else if (mode === 'draw' && (isTouch || e.button === 0)) {
        if (currentTool === 'picker') {
            pickColor(clientX, clientY);
            return;
        }

        isDrawing = true;
        const worldPos = getWorldPos(clientX, clientY);
        currentStroke = { 
            type: currentTool === 'rect' ? 'rect' : 'brush', 
            points: [worldPos], 
            color: myColor, 
            size: mySize, 
            isEraser: currentTool === 'eraser' 
        };
    }
}

function handleMove(clientX, clientY, e) {
    if (isPanning) {
        camera.x = clientX - panStart.x;
        camera.y = clientY - panStart.y;
        requestRedraw();
        return;
    }

    if(e.target === canvas) {
        const worldPos = getWorldPos(clientX, clientY);
        const now = Date.now();
        if (now - lastCursorSend > 30) {
            socket.emit('cursor_move', { x: worldPos.x, y: worldPos.y, color: currentTool === 'eraser' ? '#aaaaaa' : myColor });
            lastCursorSend = now;
        }

        if (isDrawing) {
            currentStroke.points.push(worldPos);
            requestRedraw();
        }
    }
}

function handleEnd() {
    if (isPanning) {
        isPanning = false;
        canvas.style.cursor = mode === 'pan' ? 'grab' : 'crosshair';
    }
    if (isDrawing && currentStroke.points.length > 1) {
        if(currentStroke.type === 'rect') {
            currentStroke.points = [currentStroke.points[0], currentStroke.points[currentStroke.points.length-1]];
        }
        myStrokes.push(JSON.parse(JSON.stringify(currentStroke)));
        socket.emit('draw_stroke', currentStroke); 
    }
    isDrawing = false;
    currentStroke.points = [];
    requestRedraw();
}

canvas.addEventListener('mousedown', (e) => handleStart(e.clientX, e.clientY, false, e));
window.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY, e));
window.addEventListener('mouseup', handleEnd);

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); 
    handleStart(e.touches[0].clientX, e.touches[0].clientY, true, e);
}, { passive: false });

window.addEventListener('touchmove', (e) => {
    if(e.target === canvas) e.preventDefault();
    handleMove(e.touches[0].clientX, e.touches[0].clientY, e);
}, { passive: false });

window.addEventListener('touchend', handleEnd);

canvas.addEventListener('wheel', (e) => {
    const zoomSpeed = 0.1;
    const worldPosBefore = getWorldPos(e.clientX, e.clientY);
    
    if (e.deltaY < 0) camera.zoom *= (1 + zoomSpeed);
    else camera.zoom /= (1 + zoomSpeed);
    
    camera.zoom = Math.min(Math.max(0.1, camera.zoom), 10);
    updateZoomDisplay();
    
    const worldPosAfter = getWorldPos(e.clientX, e.clientY);
    camera.x += (worldPosAfter.x - worldPosBefore.x) * camera.zoom;
    camera.y += (worldPosAfter.y - worldPosBefore.y) * camera.zoom;
    
    requestRedraw();
});

// === ИНТЕРФЕЙС ===
document.getElementById('mobileMenuToggle').addEventListener('click', (e) => {
    const panel = document.querySelector('.ui-left');
    panel.classList.toggle('show');
    if(panel.classList.contains('show')) {
        e.target.innerText = '❌ ЗАКРЫТЬ';
        e.target.style.background = '#ff4444';
    } else {
        e.target.innerText = '🎨 ИНСТРУМЕНТЫ';
        e.target.style.background = '#333';
    }
});

document.getElementById('modeDraw').addEventListener('click', (e) => {
    mode = 'draw';
    e.target.classList.add('active-mode');
    document.getElementById('modePan').classList.remove('active-mode');
    canvas.style.cursor = 'crosshair';
});

document.getElementById('modePan').addEventListener('click', (e) => {
    mode = 'pan';
    e.target.classList.add('active-mode');
    document.getElementById('modeDraw').classList.remove('active-mode');
    canvas.style.cursor = 'grab';
});

const toolBtns = {
    'brush': document.getElementById('brushBtn'),
    'rect': document.getElementById('rectBtn'),
    'eraser': document.getElementById('eraserBtn'),
    'picker': document.getElementById('pickerBtn')
};

function setTool(newTool) {
    currentTool = newTool;
    for(let key in toolBtns) toolBtns[key].classList.remove('active-tool');
    toolBtns[newTool].classList.add('active-tool');
    if(mode === 'draw') canvas.style.cursor = 'crosshair';
}

toolBtns['brush'].addEventListener('click', () => setTool('brush'));
toolBtns['rect'].addEventListener('click', () => setTool('rect'));
toolBtns['eraser'].addEventListener('click', () => setTool('eraser'));
toolBtns['picker'].addEventListener('click', () => setTool('picker'));

document.getElementById('colorPicker').addEventListener('input', (e) => { 
    myColor = e.target.value; 
    if(currentTool === 'eraser' || currentTool === 'picker') setTool('brush');
});

document.getElementById('bgColorPicker').addEventListener('input', (e) => { 
    currentBgColor = e.target.value; 
    document.body.style.backgroundColor = currentBgColor; 
});

document.getElementById('sizePicker').addEventListener('input', (e) => { mySize = e.target.value; });

document.getElementById('hideOthersGlobal').addEventListener('change', (e) => {
    hideOthersGlobal = e.target.checked;
    requestRedraw();
});

document.getElementById('zoomIn').addEventListener('click', () => { camera.zoom = Math.min(camera.zoom * 1.5, 10); updateZoomDisplay(); requestRedraw(); });
document.getElementById('zoomOut').addEventListener('click', () => { camera.zoom = Math.max(camera.zoom / 1.5, 0.1); updateZoomDisplay(); requestRedraw(); });
document.getElementById('zoomReset').addEventListener('click', () => { camera.zoom = 1; camera.x = window.innerWidth / 2; camera.y = window.innerHeight / 2; updateZoomDisplay(); requestRedraw(); });

document.getElementById('downloadBtn').addEventListener('click', () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tCtx = tempCanvas.getContext('2d');
    
    tCtx.fillStyle = currentBgColor;
    tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
    tCtx.drawImage(canvas, 0, 0);

    const link = document.createElement('a');
    link.download = 'Oeaki_Art.jpg';
    link.href = tempCanvas.toDataURL('image/jpeg', 0.9);
    link.click();
});

// === ИНИЦИАЛИЗАЦИЯ ===
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    requestRedraw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();