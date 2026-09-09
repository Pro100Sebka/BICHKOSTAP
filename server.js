const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const players = {
    'xonntixx': {
        password: '19210',
        callsign: 'ОСТАП',
        isAdmin: true,
        yuan: 1000,
        score: 0,
        inventory: [],
        baits: { bread: 3, worm: 0, premium: 0 },
        activeBait: null,
        warnings: 0,
        currentHook: null,
        sessionToken: null
    }
};

const CALLSIGNS = {
    'ОСТАП': { name: 'ОСТАП', bonusText: 'Удача (+30% зеленая зона, +10% редкая рыба)', zoneMod: 1.3, rareMod: 0.3, sellMod: 1.0 },
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

function calculatePrice(weight, isTrophy) {
    return isTrophy ? parseFloat((weight / 50).toFixed(2)) : parseFloat((weight / 100).toFixed(2));
}

function authByToken(nick, token) {
    if (!nick || !token || !players[nick]) return null;
    if (players[nick].sessionToken !== token) return null;
    return players[nick];
}

app.post('/api/login', (req, res) => {
    const { nick, password, callsign } = req.body;
    if (!nick || !password) return res.json({ success: false, error: 'Заполните все поля!' });

    const selectedCs = (callsign || 'ПАША').toUpperCase();
    const csData = CALLSIGNS[selectedCs] || CALLSIGNS['ПАША'];

    if (!players[nick]) {
        players[nick] = {
            password,
            callsign: csData.name,
            isAdmin: false,
            yuan: 0,
            score: 0,
            inventory: [],
            baits: { bread: 0, worm: 0, premium: 0 },
            activeBait: null,
            warnings: 0,
            currentHook: null,
            sessionToken: null
        };
    } else if (players[nick].password !== password) {
        return res.json({ success: false, error: 'Неверный пароль!' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    players[nick].sessionToken = token;

    const p = players[nick];
    res.json({
        success: true,
        nick,
        token,
        callsign: p.callsign,
        callsignBonus: (CALLSIGNS[p.callsign] || CALLSIGNS['ПАША']).bonusText,
        isAdmin: !!p.isAdmin,
        yuan: p.yuan,
        score: p.score,
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

    res.json({ success: true, activeBait: p.activeBait });
});

app.post('/api/cast', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Авторизуйтесь!' });

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

    // Безопасный расчет параметров зоны
    zoneDegree = Math.min(320, Math.max(15, zoneDegree));
    const startAngle = Math.floor(Math.random() * (360 - zoneDegree));

    p.currentHook = {
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

    res.json({
        zoneStart: p.currentHook.zoneStart,
        zoneSize: p.currentHook.zoneSize,
        speed: p.currentHook.speed,
        requiredHits: 5,
        baits: p.baits,
        activeBait: p.activeBait
    });
});

app.post('/api/catch', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p || !p.currentHook) return res.status(400).json({ error: 'Неверное состояние подсечки' });

    const { clickTimestamps } = req.body;

    if (!Array.isArray(clickTimestamps) || clickTimestamps.length !== 5) {
        p.currentHook = null;
        return res.json({ success: false, reason: 'Ошибка передачи данных подсечки!' });
    }

    let intervals = [];
    for (let i = 1; i < clickTimestamps.length; i++) {
        intervals.push(clickTimestamps[i] - clickTimestamps[i - 1]);
    }

    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);

    const hasImpossibleSpeed = intervals.some(dt => dt < 90);
    const isBotDetected = (stdDev < 12) || hasImpossibleSpeed;

    if (isBotDetected) {
        p.currentHook = null;
        p.warnings = (p.warnings || 0) + 1;

        if (p.warnings >= 2) {
            const oldYuan = p.yuan;
            p.yuan = parseFloat((p.yuan * 0.5).toFixed(2));
            p.warnings = 0;
            return res.json({
                success: false,
                penalty: true,
                yuan: p.yuan,
                reason: `🚨 АНТИЧИТ: Автоподсечка! Было ${oldYuan} ¥, стало ${p.yuan} ¥ (-50%).`
            });
        } else {
            return res.json({
                success: false,
                warning: true,
                warningsCount: p.warnings,
                reason: `⚠️ ПРЕДУПРЕЖДЕНИЕ (1/2): Зафиксирована автоподсечка! При повторе отнимет 50% юаней.`
            });
        }
    }

    const caughtFish = p.currentHook.fish;
    p.inventory.push(caughtFish);
    p.score += 1;
    p.currentHook = null;

    res.json({ success: true, fish: caughtFish, score: p.score });
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
        return res.json({ success: true });
    }

    if (newYuan !== undefined) players[targetNick].yuan = parseFloat(newYuan);
    if (newScore !== undefined) players[targetNick].score = parseInt(newScore);

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));