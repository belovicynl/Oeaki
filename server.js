const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// === СЕКРЕТНАЯ ОЧИСТКА БАЗЫ (Введи это в браузере, чтобы всё стереть) ===
app.get('/wipe-db-my-secret-password-123', async (req, res) => {
    try {
        await Stroke.deleteMany({});
        io.emit('wipe_canvas');      
        res.send('✅ База данных и холст успешно очищены!');
    } catch (err) {
        res.status(500).send('❌ Ошибка при очистке: ' + err.message);
    }
});

// === ПОДКЛЮЧЕНИЕ К БД ===
const mongoUri = process.env.MONGO_URI;
if (mongoUri) {
    mongoose.connect(mongoUri)
        .then(() => console.log('✅ Успешно подключено к MongoDB!'))
        .catch(err => console.error('❌ Ошибка подключения к БД:', err));
}

// === СХЕМА БД ===
const StrokeSchema = new mongoose.Schema({
    strokeId: { type: String },
    type: { type: String, default: 'brush' }, 
    points: Array,
    color: String,
    size: Number,
    isEraser: Boolean,
    userId: String
});
const Stroke = mongoose.model('Stroke', StrokeSchema);

function getUserIdFromSocket(socket) {
    try {
        let ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || 'unknown';
        if (Array.isArray(ip)) ip = ip[0];
        ip = String(ip).split(',')[0].trim();
        return crypto.createHash('md5').update(ip).digest('hex').substring(0, 8);
    } catch (err) {
        return crypto.randomBytes(4).toString('hex');
    }
}

// === СОКЕТЫ ===
io.on('connection', async (socket) => {
    const uniqueUserId = getUserIdFromSocket(socket);
    
    try {
        const allStrokes = await Stroke.find({});
        socket.emit('init_canvas', { strokes: allStrokes, myId: uniqueUserId });
    } catch (err) {}

    socket.on('draw_stroke', async (stroke) => {
        stroke.userId = uniqueUserId;
        socket.broadcast.emit('new_stroke', stroke);
        
        try {
            const newStroke = new Stroke({
                strokeId: stroke.strokeId,
                type: stroke.type || 'brush',
                points: stroke.points,
                color: stroke.color,
                size: stroke.size,
                isEraser: stroke.isEraser,
                userId: uniqueUserId
            });
            await newStroke.save();
        } catch (err) {}
    });

    socket.on('undo_stroke', async (strokeId) => {
        socket.broadcast.emit('remove_stroke', strokeId);
        try {
            await Stroke.deleteOne({ strokeId: strokeId, userId: uniqueUserId });
        } catch (err) {}
    });

    socket.on('update_stroke_color', async (data) => {
        socket.broadcast.emit('stroke_color_changed', data);
        try {
            await Stroke.updateOne({ strokeId: data.strokeId, userId: uniqueUserId }, { color: data.color });
        } catch (err) {}
    });

    socket.on('cursor_move', (pos) => {
        socket.broadcast.emit('cursor_update', { id: uniqueUserId, x: pos.x, y: pos.y, color: pos.color });
    });

    socket.on('disconnect', () => {
        io.emit('cursor_remove', uniqueUserId); 
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});