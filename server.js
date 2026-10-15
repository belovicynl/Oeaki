const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');
const nodemailer = require('nodemailer'); // Подключаем почтальона

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

    // ... (тут остались все твои сокеты для рисовалки без изменений)
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
// --- ФОНОВЫЙ ПРОЦЕСС (Почта, интервал 5 минут, подробные логи) ---
// =========================================================================

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

const THREADS_TO_WATCH = [
    { board: 'rf', id: '5757010', lastCount: 0 },
    { board: 'rf', id: '5502595', lastCount: 0 }
];

// Настройка почтового клиента (автоматически определит Gmail, Yandex и др.)
const transporter = nodemailer.createTransport({
    service: EMAIL_USER && EMAIL_USER.includes('@yandex') ? 'Yandex' : 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
    }
});

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 10000 } = options; 
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(resource, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
}

async function sendEmailNotification(title, message) {
    if (!EMAIL_USER || !EMAIL_PASS) return;
    try {
        await transporter.sendMail({
            from: `"Тред Радар" <${EMAIL_USER}>`,
            to: EMAIL_USER, // Письмо летит самому себе
            subject: title,
            text: message
        });
        console.log(`[DEBUG] ПИСЬМО ОТПРАВЛЕНО НА ПОЧТУ!`);
    } catch (err) {
        console.log(`[DEBUG] ОШИБКА ОТПРАВКИ ПИСЬМА: ${err.message}`);
    }
}

async function checkThreads() {
    if (!EMAIL_USER || !EMAIL_PASS) {
        console.log('[DEBUG] Почта или пароль не настроены в Render Environment!');
        return;
    }

    console.log('\n[DEBUG] --- НАЧАЛО ПРОВЕРКИ (Раз в 5 минут) ---');

    for (let thread of THREADS_TO_WATCH) {
        try {
            const apiUrl = `https://2ch.su/${thread.board}/res/${thread.id}.json`;
            const threadHtmlUrl = `https://2ch.su/${thread.board}/res/${thread.id}.html`;
            
            const response = await fetchWithTimeout(apiUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json, text/javascript, */*; q=0.01',
                    'Accept-Language': 'ru-RU,ru;q=0.9',
                    'Referer': `https://2ch.su/${thread.board}/`
                },
                timeout: 10000 
            });

            if (!response.ok) {
                console.log(`[DEBUG] Тред ${thread.id}: ОШИБКА ИЛИ УДАЛЕН (код ${response.status})`);
                continue;
            }

            const data = await response.json();
            const currentPostCount = data.threads[0].posts.length;

            console.log(`[DEBUG] Тред ${thread.id}: сейчас ${currentPostCount} постов. (В памяти было: ${thread.lastCount})`);

            if (thread.lastCount === 0) {
                console.log(`[DEBUG] Первый запуск для ${thread.id}. Запоминаем.`);
                thread.lastCount = currentPostCount; 
                await sendEmailNotification(`🚀 Стартовый отчет /${thread.board}/`, `Скрипт успешно запущен.\nТред: ${thread.id}\nТекущее количество постов: ${currentPostCount}`);
                continue;
            }

            if (currentPostCount > thread.lastCount) {
                const newPostsCount = currentPostCount - thread.lastCount;
                console.log(`[DEBUG] Тред ${thread.id}: ЕСТЬ НОВЫЕ ПОСТЫ (+${newPostsCount})! Отправляю письмо.`);
                
                const title = `🚨 Бамп в треде ${thread.id}!`;
                let msg = `Новых постов: +${newPostsCount}\nВсего постов: ${currentPostCount}\n\nСсылка: ${threadHtmlUrl}`;
                
                if (currentPostCount >= 480) {
                    msg += `\n\n⚠️ ВНИМАНИЕ! СКОРО БАМПЛИМИТ! ПОРА ПЕРЕКАТЫВАТЬ!`;
                }
                
                await sendEmailNotification(title, msg);
                thread.lastCount = currentPostCount; 
            } else {
                console.log(`[DEBUG] Тред ${thread.id}: новых постов нет. Письмо не отправляем.`);
            }

        } catch (error) {
            console.log(`[DEBUG] Тред ${thread.id}: Ошибка сети / Cloudflare (${error.message})`);
        }
    }
    
    console.log('[DEBUG] --- ПРОВЕРКА ЗАВЕРШЕНА ---\n');
}

// Запускаем проверку ровно каждые 5 минут (300 000 миллисекунд)
setInterval(checkThreads, 300000);

// Делаем первую проверку сразу при старте
checkThreads();