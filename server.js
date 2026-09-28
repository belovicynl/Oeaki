const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose'); // Подключаем переводчик для БД

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
// Так в базе будет выглядеть одна линия
const StrokeSchema = new mongoose.Schema({
    points: Array,
    color: String,
    size: Number,
    isEraser: Boolean
});
const Stroke = mongoose.model('Stroke', StrokeSchema);

// Так мы будем хранить таймер очистки (чтобы он пережил перезагрузку)
const SystemSchema = new mongoose.Schema({
    key: String,
    nextWipeTime: Number
});
const System = mongoose.model('System', SystemSchema);


// === 3. УМНАЯ ЛОГИКА ОЧИСТКИ ===
async function checkWipeTimer() {
    try {
        let sys = await System.findOne({ key: 'wipe_timer' });
        
        // Если таймера в базе еще нет — создаем его
        if (!sys) {
            const minTime = 24 * 60 * 60 * 1000;
            const maxTime = 48 * 60 * 60 * 1000;
            const delay = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
            
            sys = new System({ key: 'wipe_timer', nextWipeTime: Date.now() + delay });
            await sys.save();
            console.log(`Таймер создан. Очистка через ${(delay / 1000 / 60 / 60).toFixed(1)} часов.`);
            return;
        }

        // Если время пришло
        if (Date.now() >= sys.nextWipeTime) {
            console.log('Время вышло! Удаляем все рисунки из БД!');
            
            await Stroke.deleteMany({}); // Стираем всё из базы
            io.emit('wipe_canvas');      // Заставляем браузеры очистить экраны
            
            // Назначаем новое время (24-48 часов)
            const minTime = 24 * 60 * 60 * 1000;
            const maxTime = 48 * 60 * 60 * 1000;
            const delay = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
            
            sys.nextWipeTime = Date.now() + delay;
            await sys.save();
        }
    } catch (err) {
        console.error("Ошибка при проверке таймера:", err);
    }
}
// Сервер проверяет таймер каждую минуту
setInterval(checkWipeTimer, 60 * 1000);


// === 4. СОКЕТЫ (ОБЩЕНИЕ С ИГРОКАМИ) ===
io.on('connection', async (socket) => {
    console.log('Художник подключился:', socket.id);
    
    activeUsers[socket.id] = { id: socket.id };
    io.emit('update_users', activeUsers); 

    // Выгружаем ВСЮ историю рисунков из БД новому игроку
    try {
        const allStrokes = await Stroke.find({});
        socket.emit('init_canvas', allStrokes);
    } catch (err) {
        console.error("Ошибка загрузки истории:", err);
    }

    socket.on('draw_stroke', async (stroke) => {
        // Сразу отправляем линию другим игрокам (чтобы не было задержек)
        stroke.userId = socket.id;
        socket.broadcast.emit('new_stroke', stroke);
        
        // В фоновом режиме сохраняем линию в Базу Данных
        try {
            const newStroke = new Stroke({
                points: stroke.points,
                color: stroke.color,
                size: stroke.size,
                isEraser: stroke.isEraser
            });
            await newStroke.save();
        } catch (err) {
            console.error("Ошибка сохранения линии:", err);
        }
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
server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    // Запускаем проверку таймера один раз при старте сервера
    await checkWipeTimer(); 
});