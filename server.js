const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let allStrokes = []; 
let activeUsers = {}; 

// --- НОВАЯ ЛОГИКА ОЧИСТКИ ---
let nextWipeTime = 0; // Переменная, где будет храниться точное время следующей очистки

function calculateNextWipe() {
    const minTime = 24 * 60 * 60 * 1000; // 24 часа
    const maxTime = 48 * 60 * 60 * 1000; // 48 часов
    const randomDelay = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    
    // Записываем точную дату и время в будущем (Текущее время + задержка)
    nextWipeTime = Date.now() + randomDelay; 

    const hours = (randomDelay / (1000 * 60 * 60)).toFixed(1);
    console.log(`Следующее очищение холста запланировано через ${hours} часов.`);
}

// Задаем время при старте сервера
calculateNextWipe();

// Проверяем каждую минуту, не пришло ли время
setInterval(() => {
    // Если текущее время стало больше или равно запланированному времени
    if (Date.now() >= nextWipeTime) {
        console.log('Время вышло! Очищаем холст!');
        allStrokes = [];             
        io.emit('wipe_canvas');      
        calculateNextWipe(); // Назначаем новое время для следующей очистки
    }
}, 60 * 1000); // 60 * 1000 мс = 1 минута
// ----------------------------


io.on('connection', (socket) => {
    console.log('Художник подключился:', socket.id);
    
    activeUsers[socket.id] = { id: socket.id };
    io.emit('update_users', activeUsers); 

    socket.emit('init_canvas', allStrokes);

    socket.on('draw_stroke', (stroke) => {
        stroke.userId = socket.id;
        allStrokes.push(stroke); 
        socket.broadcast.emit('new_stroke', stroke);
    });

    socket.on('cursor_move', (pos) => {
        socket.broadcast.emit('cursor_update', { id: socket.id, x: pos.x, y: pos.y, color: pos.color });
    });

    socket.on('disconnect', () => {
        console.log('Художник отключился:', socket.id);
        delete activeUsers[socket.id];
        io.emit('update_users', activeUsers); 
        io.emit('cursor_remove', socket.id); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});