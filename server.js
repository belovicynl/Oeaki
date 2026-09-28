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

function scheduleRandomWipe() {
    const minTime = 24 * 60 * 60 * 1000; // 24 часа
    const maxTime = 48 * 60 * 60 * 1000; // 48 часов
    const randomDelay = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
    
    // ВЕРНУЛ ЭТУ СТРОКУ! Теперь в консоли снова пишет время.
    const hours = (randomDelay / (1000 * 60 * 60)).toFixed(1);
    console.log(`Следующее очищение холста произойдет примерно через ${hours} часов.`);

    setTimeout(() => {
        console.log('Очищаем холст!');
        allStrokes = [];             
        io.emit('wipe_canvas');      
        scheduleRandomWipe();        
    }, randomDelay);
}
scheduleRandomWipe();

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