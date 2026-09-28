const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto'); // Для хэширования IP

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let activeUsers = {}; 

// === 1. ПОДКЛЮЧЕНИЕ К БАЗЕ ДАННЫХ ===
const mongoUri = process.env.MONGO_URI;

if (!mongoUri) {
    console.error("ОШИБКА: Переменная MONGO_URI не найдена в Render Environment!");
} else {
    mongoose.connect(mongoUri)
        .then(() => console.log('✅ Успешно подключено к MongoDB!'))
        .catch(err => console.error('❌ Ошибка подключения к БД:', err));
}

// === 2. СОЗДАЕМ СТРУКТУРУ ХРАНЕНИЯ ===
const StrokeSchema = new mongoose.Schema({
    type: { type: String, default: 'brush' }, // 'brush' или 'rect'
    points: Array,
    color: String,
    size: Number,
    isEraser: Boolean,
    userId: String
});
const Stroke = mongoose.model('Stroke', StrokeSchema);


// === 3. БАМПЛИМИТ (ОЧИСТКА ПО ПАМЯТИ) ===
const MAX_MEMORY_MB = 250; // Лимит в мегабайтах (на Render дается 512, оставляем запас)

async function checkMemoryLimit() {
    try {
        const memoryUsage = process.memoryUsage();
        const rssMB = Math.round(memoryUsage.rss / 1024 / 1024);
        
        console.log(`[SYS] Память сервера: ${rssMB} MB / ${MAX_MEMORY_MB} MB`);

        if (rssMB > MAX_MEMORY_MB) {
            console.log('⚠️ ДОСТИГНУТ БАМПЛИМИТ ПАМЯТИ! Очищаем БД и холсты...');
            await Stroke.deleteMany({}); // Стираем всё из базы
            io.emit('wipe_canvas');      // Заставляем браузеры очистить экраны
            
            // Если Node.js запущен с флагом --expose-gc, принудительно чистим мусор
            if (global.gc) { global.gc(); } 
        }
    } catch (err) {
        console.error("Ошибка при проверке памяти:", err);
    }
}
// Сервер проверяет память каждую минуту
setInterval(checkMemoryLimit, 60 * 1000);


// === Вспомогательная функция для получения IP ===
function getUserIdFromSocket(socket) {
    // x-forwarded-for нужен для Render, иначе будет IP балансировщика
    const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    // Создаем короткий хэш из IP, чтобы не светить реальные адреса, но держать уникальность
    return crypto.createHash('md5').update(ip).digest('hex').substring(0, 8);
}


// === 4. СОКЕТЫ (ОБЩЕНИЕ С ИГРОКАМИ) ===
io.on('connection', async (socket) => {
    // 1 IP = 1 профиль. Даже с разных вкладок будет один ID.
    const uniqueUserId = getUserIdFromSocket(socket);
    socket.userId = uniqueUserId; 

    console.log(`Художник подключился: Socket [${socket.id}] -> UserID [${uniqueUserId}]`);
    
    // Добавляем в онлайн только если такого ID еще нет
    if (!activeUsers[uniqueUserId]) {
        activeUsers[uniqueUserId] = { id: uniqueUserId, sockets: 1 };
    } else {
        activeUsers[uniqueUserId].sockets++;
    }
    
    io.emit('update_users', activeUsers); 

    // Выгружаем ВСЮ историю рисунков
    try {
        const allStrokes = await Stroke.find({});
        socket.emit('init_canvas', { strokes: allStrokes, myId: uniqueUserId });
    } catch (err) {
        console.error("Ошибка загрузки истории:", err);
    }

    socket.on('draw_stroke', async (stroke) => {
        stroke.userId = uniqueUserId;
        socket.broadcast.emit('new_stroke', stroke);
        
        try {
            const newStroke = new Stroke({
                type: stroke.type || 'brush',
                points: stroke.points,
                color: stroke.color,
                size: stroke.size,
                isEraser: stroke.isEraser,
                userId: uniqueUserId
            });
            await newStroke.save();
        } catch (err) {
            console.error("Ошибка сохранения линии:", err);
        }
    });

    socket.on('cursor_move', (pos) => {
        socket.broadcast.emit('cursor_update', { id: uniqueUserId, x: pos.x, y: pos.y, color: pos.color });
    });

    socket.on('disconnect', () => {
        if (activeUsers[uniqueUserId]) {
            activeUsers[uniqueUserId].sockets--;
            // Удаляем юзера из списка, только если он закрыл ВСЕ свои вкладки
            if (activeUsers[uniqueUserId].sockets <= 0) {
                delete activeUsers[uniqueUserId];
                io.emit('cursor_remove', uniqueUserId); 
            }
        }
        io.emit('update_users', activeUsers); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});