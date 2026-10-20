const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаем статику из текущей папки
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Роут для очистки БД
app.get('/wipe-db-my-secret-password-123', async (req, res) => {
    try {
        await Stroke.deleteMany({});
        io.emit('wipe_canvas');      
        res.send('База данных успешно очищена.');
    } catch (err) {
        res.status(500).send('Ошибка очистки БД: ' + err.message);
    }
});

// Подключение к MongoDB
const mongoUri = process.env.MONGO_URI;
if (mongoUri) {
    mongoose.connect(mongoUri)
        .then(() => console.log('MongoDB подключена'))
        .catch(err => console.error('Ошибка подключения к БД:', err));
} else {
    console.warn('ВНИМАНИЕ: MONGO_URI не задан. Данные не будут сохраняться в БД.');
}

const StrokeSchema = new mongoose.Schema({
    strokeId: { type: String, required: true },
    type: { type: String, default: 'brush' }, 
    points: Array,
    color: String,
    size: Number,
    isEraser: Boolean,
    userId: String
});
const Stroke = mongoose.model('Stroke', StrokeSchema);

// Генерация уникального ID пользователя на основе IP
function getUserIdFromSocket(socket) {
    try {
        let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'unknown';
        if (Array.isArray(ip)) ip = ip[0];
        ip = String(ip).split(',')[0].trim();
        return crypto.createHash('md5').update(ip).digest('hex').substring(0, 8);
    } catch (err) {
        console.error('Ошибка получения IP:', err);
        return crypto.randomBytes(4).toString('hex');
    }
}

// Работа с веб-сокетами
io.on('connection', async (socket) => {
    const uniqueUserId = getUserIdFromSocket(socket);
    
    // Отправка истории при подключении
    try {
        const allStrokes = await Stroke.find({});
        socket.emit('init_canvas', { strokes: allStrokes, myId: uniqueUserId });
    } catch (err) {
        console.error('Ошибка при загрузке штрихов:', err);
    }

    // Рисование нового штриха
    socket.on('draw_stroke', async (stroke) => {
        stroke.userId = uniqueUserId;
        socket.broadcast.emit('new_stroke', stroke);
        
        try {
            const newStroke = new Stroke({ ...stroke, userId: uniqueUserId });
            await newStroke.save();
        } catch (err) {
            console.error('Ошибка сохранения штриха:', err);
        }
    });

    // Отмена штриха (Undo)
    socket.on('undo_stroke', async (strokeId) => {
        socket.broadcast.emit('remove_stroke', strokeId);
        try {
            await Stroke.deleteOne({ strokeId: strokeId, userId: uniqueUserId });
        } catch (err) {
            console.error('Ошибка удаления штриха:', err);
        }
    });

    // Изменение цвета (Заливка)
    socket.on('update_stroke_color', async (data) => {
        socket.broadcast.emit('stroke_color_changed', data);
        try {
            await Stroke.updateOne({ strokeId: data.strokeId, userId: uniqueUserId }, { color: data.color });
        } catch (err) {
            console.error('Ошибка обновления цвета штриха:', err);
        }
    });

    // Перемещение курсора других пользователей
    socket.on('cursor_move', (pos) => {
        socket.broadcast.emit('cursor_update', { id: uniqueUserId, x: pos.x, y: pos.y, color: pos.color });
    });

    // Отключение пользователя
    socket.on('disconnect', () => {
        io.emit('cursor_remove', uniqueUserId); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту: ${PORT}`);
});