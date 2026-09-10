const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static('public'));

// --- ANTI-DDOS / RATE LIMITING ---
// Allow maximum 5 account creation/login requests per 1 minute per IP
const authLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5, // Limit each IP to 5 requests per windowMs
    message: { success: false, error: 'Too many requests from this IP, please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- PERSISTENT DATABASE SETUP ---
const DB_FILE = path.join(__dirname, 'database.json');

// Function to load players from JSON file
function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        // Initial default structure
        const defaultData = {
            'xonntixx': {
                password: '19210',
                callsign: 'ОСТАП',
                isAdmin: true,
                yuan: 1000,
                score: 0,
                hunger: 100,
                inventory: [],
                baits: { bread: 3, worm: 0, premium: 0 },
                activeBait: null,
                warnings: 0,
                currentHook: null,
                sessionToken: null
            }
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 4));
        return defaultData;
    }
    try {
        const rawData = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(rawData);
    } catch (err) {
        console.error('Error reading database file, starting empty:', err);
        return {};
    }
}

// Function to save players to JSON file
function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(players, null, 4));
    } catch (err) {
        console.error('Failed to save database:', err);
    }
}

// Initialize players from storage
const players = loadDatabase();

const CALLSIGNS = {
    'ОСТАП': { name: 'ОСТАП', bonusText: 'Удача (+30% зеленая зона, +30% редкая рыба)', zoneMod: 1.3, rareMod: 0.3, sellMod: 1.0 },
    'КОЧ': { name: 'КОЧ', bonusText: 'Узкоглазый (-20% скорость вращения стрелки)', zoneMod: 1.0, rareMod: 0.0, speedMod: 0.8, sellMod: 1.0 },
    'СЕМКА': { name: 'СЕМКА', bonusText: 'Жадина (+15% к стоимости продажи)', zoneMod: 1.0, rareMod: 0.0, sellMod: 1.15 },
    'ПАША': { name: 'ПАША', bonusText: 'Рускый хакер (+15% зеленая зона)', zoneMod: 1.15, rareMod: 0.0, sellMod: 1.0 }
};

const FISH_TYPES = [
    { id: 'dirty', displayName: 'ГРЯЗНЫЙ БЫЧОК 🚬', isTrophy: false, weightRange: [30, 70], probability: 0.40, zoneSize: 60, speed: 1.0 },
    { id: 'used', displayName: 'Б/У БЫЧОК 👟', isTrophy: false, weightRange: [70, 100], probability: 0.30, zoneSize: 50, speed: 1.2 },
    { id: 'chill', displayName: 'ЧИЛОВЫЙ БЫЧОК 😎', isTrophy: false, weightRange: [100, 300], probability: 0.15, zoneSize: 40, speed: 1.4 },
    { id: 'golden', displayName: 'ЗОЛОТОЙ БЫЧОК ✨', isTrophy: true, weightRange: [200, 800], probability: 0.10, zoneSize: 30, speed: 1.6 },
    { id: 'look', displayName: 'ЛУКБЫЧОК 🌱', isTrophy: true, weightRange: [2000, 4000], probability: 0.05, zoneSize: 22, speed: 1.9 }
];

const SHOP_BAITS = {
    'bread': { name: 'Хлеб', price: 50, zoneMultiplier: 1.25 },
    'worm': { name: 'Червяк', price: 150, zoneMultiplier: 1.5 },
    'premium': { name: 'Опарыш', price: 500, zoneMultiplier: 2.0 }
};

const SHOP_FOOD = {
    'snack': { name: 'Рис', price: 1, restore: 20 },
    'meal': { name: 'Рис (вареный)', price: 2, restore: 50 }
};

function calculatePrice(weight, isTrophy) {
    return isTrophy ? parseFloat((weight / 50).toFixed(2)) : parseFloat((weight / 100).toFixed(2));
}

function authByToken(nick, token) {
    if (!nick || !token || !players[nick]) return null;
    if (players[nick].sessionToken !== token) return null;
    return players[nick];
}

// APPLY RATE LIMITER TO LOGIN/REGISTER ENDPOINT
app.post('/api/login', authLimiter, (req, res) => {
    const { nick, password, callsign } = req.body;
    if (!nick || !password) return res.json({ success: false, error: 'Заполните все поля!' });

    // Sanitize username
    const cleanNick = nick.trim().toLowerCase();
    if (cleanNick.length < 3 || cleanNick.length > 16) {
        return res.json({ success: false, error: 'Никнейм должен быть от 3 до 16 символов!' });
    }

    const selectedCs = (callsign || 'ПАША').toUpperCase();
    const csData = CALLSIGNS[selectedCs] || CALLSIGNS['ПАША'];

    if (!players[cleanNick]) {
        players[cleanNick] = {
            password,
            callsign: csData.name,
            isAdmin: false,
            yuan: 0,
            score: 0,
            hunger: 100,
            inventory: [],
            baits: { bread: 0, worm: 0, premium: 0 },
            activeBait: null,
            warnings: 0,
            currentHook: null,
            sessionToken: null
        };
        saveDatabase(); // Save new registration
    } else if (players[cleanNick].password !== password) {
        return res.json({ success: false, error: 'Неверный пароль!' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    players[cleanNick].sessionToken = token;
    saveDatabase(); // Save active session

    const p = players[cleanNick];
    res.json({
        success: true,
        nick: cleanNick,
        token,
        callsign: p.callsign,
        callsignBonus: (CALLSIGNS[p.callsign] || CALLSIGNS['ПАША']).bonusText,
        isAdmin: !!p.isAdmin,
        yuan: p.yuan,
        score: p.score,
        hunger: p.hunger,
        inventory: p.inventory,
        baits: p.baits,
        activeBait: p.activeBait,
        warnings: p.warnings
    });
});

app.post('/api/sync', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Сессия недействительна' });

    res.json({
        yuan: p.yuan,
        score: p.score,
        hunger: p.hunger,
        inventory: p.inventory,
        baits: p.baits,
        activeBait: p.activeBait,
        callsign: p.callsign,
        callsignBonus: (CALLSIGNS[p.callsign] || CALLSIGNS['ПАША']).bonusText,
        warnings: p.warnings,
        isAdmin: !!p.isAdmin
    });
});

app.post('/api/buyBait', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Ошибка сессии' });

    const bait = SHOP_BAITS[req.body.baitId];
    if (!bait || p.yuan < bait.price) return res.json({ success: false, error: 'Недостаточно юаней!' });

    p.yuan = parseFloat((p.yuan - bait.price).toFixed(2));
    p.baits[req.body.baitId] = (p.baits[req.body.baitId] || 0) + 1;
    saveDatabase();

    res.json({ success: true, yuan: p.yuan, baits: p.baits });
});

app.post('/api/equipBait', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Ошибка сессии' });

    const baitId = req.body.baitId;
    if (baitId === null) {
        p.activeBait = null;
    } else if (p.baits[baitId] > 0) {
        p.activeBait = baitId;
    } else {
        return res.json({ success: false, error: 'Наживки нет в наличии!' });
    }
    saveDatabase();

    res.json({ success: true, activeBait: p.activeBait });
});

app.post('/api/buyFood', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Ошибка сессии' });

    const { foodId, amount } = req.body;
    const food = SHOP_FOOD[foodId];
    const qty = parseInt(amount) || 1;

    if (!food || qty <= 0) return res.json({ success: false, error: 'Неверные данные' });

    const totalPrice = food.price * qty;
    if (p.yuan < totalPrice) return res.json({ success: false, error: 'Недостаточно юаней!' });

    p.yuan = parseFloat((p.yuan - totalPrice).toFixed(2));
    p.hunger = Math.min(100, p.hunger + (food.restore * qty));
    saveDatabase();

    res.json({ success: true, yuan: p.yuan, hunger: p.hunger });
});

app.post('/api/cast', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Авторизуйтесь!' });

    if (p.hunger < 5) {
        return res.json({ success: false, error: 'Вы слишком голодны! Купите еду в магазине.' });
    }

    p.hunger = Math.max(0, p.hunger - 5);

    const cs = CALLSIGNS[p.callsign] || CALLSIGNS['ПАША'];

    let rand = Math.random() - (cs.rareMod || 0);
    let selectedType = FISH_TYPES[0];
    let cumulative = 0;
    for (let fish of FISH_TYPES) {
        cumulative += fish.probability;
        if (rand <= cumulative) { selectedType = fish; break; }
    }

    const weight = Math.floor(Math.random() * (selectedType.weightRange[1] - selectedType.weightRange[0] + 1)) + selectedType.weightRange[0];
    const price = calculatePrice(weight, selectedType.isTrophy);

    let zoneDegree = Math.floor(selectedType.zoneSize * (cs.zoneMod || 1.0));
    let speed = selectedType.speed * (cs.speedMod || 1.0);

    if (p.activeBait && p.baits[p.activeBait] > 0) {
        zoneDegree = Math.floor(zoneDegree * SHOP_BAITS[p.activeBait].zoneMultiplier);
        p.baits[p.activeBait] -= 1;
        if (p.baits[p.activeBait] <= 0) {
            p.activeBait = null;
        }
    }

    zoneDegree = Math.min(320, Math.max(15, zoneDegree));
    const startAngle = Math.floor(Math.random() * (360 - zoneDegree));

    const hookToken = crypto.randomBytes(8).toString('hex');

    p.currentHook = {
        hookToken,
        fish: {
            id: selectedType.id,
            displayName: selectedType.displayName,
            weight,
            price,
            isTrophy: selectedType.isTrophy
        },
        zoneStart: startAngle,
        zoneSize: zoneDegree,
        speed,
        requiredHits: 5,
        castTime: Date.now()
    };
    saveDatabase();

    res.json({
        success: true,
        hookToken,
        zoneStart: p.currentHook.zoneStart,
        zoneSize: p.currentHook.zoneSize,
        speed: p.currentHook.speed,
        requiredHits: 5,
        hunger: p.hunger,
        baits: p.baits,
        activeBait: p.activeBait
    });
});

app.post('/api/catch', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p || !p.currentHook) {
        return res.status(400).json({ success: false, reason: 'Нет активного заброса!' });
    }

    const { hookToken, clickTimestamps } = req.body;

    if (!hookToken || hookToken !== p.currentHook.hookToken) {
        p.currentHook = null;
        saveDatabase();
        return res.status(403).json({ success: false, reason: '🚨 Токен заброса недействителен или уже использован!' });
    }

    const now = Date.now();
    const activeHook = p.currentHook;
    p.currentHook = null;

    let isBotDetected = false;

    const elapsedTime = now - activeHook.castTime;
    const minRealisticTimeMs = 1200;

    if (elapsedTime < minRealisticTimeMs) {
        isBotDetected = true;
    }

    if (!Array.isArray(clickTimestamps) || clickTimestamps.length !== 5) {
        isBotDetected = true;
    } else {
        let intervals = [];
        for (let i = 1; i < clickTimestamps.length; i++) {
            intervals.push(clickTimestamps[i] - clickTimestamps[i - 1]);
        }

        const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
        const stdDev = Math.sqrt(variance);

        const hasImpossibleSpeed = intervals.some(dt => dt < 80);
        const invalidTimestamps = clickTimestamps.some(t => t < activeHook.castTime || t > now);

        if ((stdDev < 12) || hasImpossibleSpeed || invalidTimestamps) {
            isBotDetected = true;
        }
    }

    if (isBotDetected) {
        p.warnings = (p.warnings || 0) + 1;

        if (p.warnings >= 2) {
            p.yuan = parseFloat((p.yuan * 0.5).toFixed(2));
            p.inventory = [];
            p.warnings = 0;
            saveDatabase();
            return res.json({
                success: false,
                penalty: true,
                yuan: p.yuan,
                inventory: p.inventory,
                reason: `🚨 АНТИЧИТ: Зафиксирована автоподсечка/подмена запросов! Отнято 50% юаней и ВСЯ рыба.`
            });
        } else {
            saveDatabase();
            return res.json({
                success: false,
                warning: true,
                warningsCount: p.warnings,
                reason: `⚠️ ПРЕДУПРЕЖДЕНИЕ (1/2): Зафиксирована подозрительная активность или подмена токенов!`
            });
        }
    }

    const caughtFish = activeHook.fish;
    p.inventory.push(caughtFish);
    p.score += 1;
    saveDatabase();

    res.json({ success: true, fish: caughtFish, score: p.score, hunger: p.hunger });
});

app.post('/api/sellAll', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Необходима авторизация' });

    const cs = CALLSIGNS[p.callsign] || CALLSIGNS['ПАША'];
    let rawEarned = 0;
    p.inventory.forEach(f => rawEarned += f.price);

    const totalEarned = parseFloat((rawEarned * (cs.sellMod || 1.0)).toFixed(2));
    p.yuan = parseFloat((p.yuan + totalEarned).toFixed(2));
    p.inventory = [];
    saveDatabase();

    res.json({ success: true, earned: totalEarned, yuan: p.yuan });
});

app.post('/api/admin/getPlayers', (req, res) => {
    const admin = authByToken(req.body.nick, req.body.token);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Отказано' });

    const list = Object.keys(players).map(n => ({
        nick: n,
        callsign: players[n].callsign,
        yuan: players[n].yuan,
        score: players[n].score,
        hunger: players[n].hunger,
        warnings: players[n].warnings || 0,
        inventoryCount: players[n].inventory.length,
        isAdmin: !!players[n].isAdmin
    }));

    res.json({ success: true, players: list });
});

app.post('/api/admin/updatePlayer', (req, res) => {
    const admin = authByToken(req.body.nick, req.body.token);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Отказано' });

    const { targetNick, newYuan, newScore, deleteAccount } = req.body;
    if (!players[targetNick]) return res.json({ success: false, error: 'Игрок не найден' });

    if (deleteAccount) {
        if (targetNick === 'xonntixx') return res.json({ success: false, error: 'Нельзя удалить главного админа' });
        delete players[targetNick];
        saveDatabase();
        return res.json({ success: true });
    }

    if (newYuan !== undefined) players[targetNick].yuan = parseFloat(newYuan);
    if (newScore !== undefined) players[targetNick].score = parseInt(newScore);
    saveDatabase();

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));