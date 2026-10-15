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

app.get('/wipe-db-my-secret-password-123', async (req, res) => {
    try {
        await Stroke.deleteMany({});
        io.emit('wipe_canvas');      
        res.send('ОК');
    } catch (err) {
        res.status(500).send('ERR: ' + err.message);
    }
});

const mongoUri = process.env.MONGO_URI;
if (mongoUri) {
    mongoose.connect(mongoUri)
        .then(() => console.log('MongoDB connected'))
        .catch(err => console.error('DB error:', err));
}

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
    console.log(`Port: ${PORT}`);
});

// =========================================================================
// --- ФОНОВЫЙ ПРОЦЕСС (Скрытый чекер + ОТЛАДКА) ---
// =========================================================================

const SIMPLEPUSH_KEY = process.env.SIMPLEPUSH_KEY;

const THREADS_TO_WATCH = [
    { board: 'rf', id: '5757010', lastCount: 0 },
    { board: 'rf', id: '5502595', lastCount: 0 }
];

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 10000 } = options; 
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    const response = await fetch(resource, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

async function sendPushNotification(title, message) {
    if (!SIMPLEPUSH_KEY) return; 

    try {
        const payload = {
            key: SIMPLEPUSH_KEY,
            title: title,
            msg: message
        };

        await fetchWithTimeout('https://api.simplepush.io/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            timeout: 5000 
        });
    } catch (err) {
        console.log(`[DEBUG] Ошибка отправки пуша в Simplepush: ${err.message}`);
    }
}

async function checkThreads() {
    if (!SIMPLEPUSH_KEY) {
        console.log('[DEBUG] Ключ Simplepush не найден в настройках Render!');
        return;
    }

    for (let thread of THREADS_TO_WATCH) {
        try {
            const apiUrl = `https://2ch.su/${thread.board}/res/${thread.id}.json`;
            const threadHtmlUrl = `https://2ch.su/${thread.board}/res/${thread.id}.html`;
            
            console.log(`[DEBUG] Проверяю тред ${thread.id}...`);

            const response = await fetchWithTimeout(apiUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': `https://2ch.su/${thread.board}/`
                },
                timeout: 10000 
            });

            if (!response.ok) {
                console.log(`[DEBUG] Двач заблокировал запрос к ${thread.id}! Код ошибки: ${response.status}`);
                continue;
            }

            const data = await response.json();
            const currentPostCount = data.threads[0].posts.length;

            console.log(`[DEBUG] Тред ${thread.id}: сейчас ${currentPostCount} постов. (В памяти было: ${thread.lastCount})`);

            if (thread.lastCount === 0) {
                thread.lastCount = currentPostCount; 
                console.log(`[DEBUG] Первый запуск. Запомнил стартовое кол-во для ${thread.id}. Жду бампов.`);
                continue;
            }

            if (currentPostCount > thread.lastCount) {
                const newPostsCount = currentPostCount - thread.lastCount;
                console.log(`[DEBUG] ЕСТЬ НОВЫЕ ПОСТЫ (+${newPostsCount})! Пытаюсь отправить пуш...`);
                
                const title = `🚨 Бамп в /${thread.board}/!`;
                const msg = `Новых постов: +${newPostsCount}\nВсего постов стало: ${currentPostCount}\n\nСсылка: ${threadHtmlUrl}`;
                
                await sendPushNotification(title, msg);
                thread.lastCount = currentPostCount; 
                console.log(`[DEBUG] Пуш успешно отправлен на телефон!`);
            }
        } catch (error) {
            console.log(`[DEBUG] Ошибка/Таймаут при проверке ${thread.id}: ${error.message}`);
        }
    }
}

// Запуск раз в 45 секунд
setInterval(checkThreads, 45000);
checkThreads();