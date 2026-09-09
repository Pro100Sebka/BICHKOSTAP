const express = require('express');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// База данных игроков
const players = {
    'xonntixx': {
        password: '19210',
        callsign: 'ОСТАП',
        isAdmin: true,
        yuan: 1000,
        score: 0,
        inventory: [],
        activeBait: null,
        currentHook: null,
        sessionToken: null
    }
};

const CALLSIGNS = {
    'ОСТАП': { name: 'ОСТАП', bonusText: 'Легендарная удача (+30% размер круга, +10% редкая рыба)', sizeMod: 1.3, rareMod: 0.1, timeMod: 1.0, sellMod: 1.0 },
    'СОКОЛ': { name: 'СОКОЛ', bonusText: 'Быстрые рефлексы (+25% времени на подсечку)', sizeMod: 1.0, rareMod: 0.0, timeMod: 1.25, sellMod: 1.0 },
    'ФАНТОМ': { name: 'ФАНТОМ', bonusText: 'Теневой барыга (+15% к стоимости продажи)', sizeMod: 1.0, rareMod: 0.0, timeMod: 1.0, sellMod: 1.15 },
    'ЩУКА': { name: 'ЩУКА', bonusText: 'Опытный рыбак (+15% к размеру круга)', sizeMod: 1.15, rareMod: 0.0, timeMod: 1.0, sellMod: 1.0 }
};

const FISH_TYPES = [
    { id: 'dirty', displayName: 'ГРЯЗНЫЙ БЫЧОК 🚬', isTrophy: false, weightRange: [30, 70], probability: 0.40, minigame: { clicks: 3, size: 60, time: 3200 } },
    { id: 'used', displayName: 'Б/У БЫЧОК 👟', isTrophy: false, weightRange: [70, 100], probability: 0.30, minigame: { clicks: 3, size: 55, time: 2800 } },
    { id: 'chill', displayName: 'ЧИЛОВЫЙ БЫЧОК 😎', isTrophy: false, weightRange: [100, 300], probability: 0.15, minigame: { clicks: 4, size: 45, time: 2400 } },
    { id: 'golden', displayName: 'ЗОЛОТОЙ БЫЧОК ✨', isTrophy: true, weightRange: [200, 800], probability: 0.10, minigame: { clicks: 4, size: 35, time: 2000 } },
    { id: 'look', displayName: 'ЛУКБЫЧОК 🌱', isTrophy: true, weightRange: [2000, 4000], probability: 0.05, minigame: { clicks: 5, size: 25, time: 1600 } }
];

const SHOP_BAITS = {
    'bread': { name: 'Хлеб', price: 50, sizeMultiplier: 1.2 },
    'worm': { name: 'Червяк', price: 150, sizeMultiplier: 1.5 },
    'premium': { name: 'Опарыш', price: 500, sizeMultiplier: 2.0 }
};

// Расчет цены строго по правилу: 100г обычных = 1 юань, 100г трофейных = 2 юаня
function calculatePrice(weight, isTrophy) {
    if (isTrophy) {
        return parseFloat((weight / 50).toFixed(2)); // 100g = 2 yuan
    } else {
        return parseFloat((weight / 100).toFixed(2)); // 100g = 1 yuan
    }
}

// Авторизация по токену
function authByToken(nick, token) {
    if (!nick || !token || !players[nick]) return null;
    if (players[nick].sessionToken !== token) return null;
    return players[nick];
}

// Регистрация / Вход
app.post('/api/login', (req, res) => {
    const { nick, password, callsign } = req.body;
    if (!nick || !password) return res.json({ success: false, error: 'Заполните ник и пароль!' });

    const selectedCallsign = (callsign || 'ЩУКА').toUpperCase();
    const csData = CALLSIGNS[selectedCallsign] || CALLSIGNS['ЩУКА'];

    if (!players[nick]) {
        players[nick] = {
            password,
            callsign: csData.name,
            isAdmin: false,
            yuan: 0,
            score: 0,
            inventory: [],
            activeBait: null,
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
        callsignBonus: (CALLSIGNS[p.callsign] || CALLSIGNS['ЩУКА']).bonusText,
        isAdmin: !!p.isAdmin,
        yuan: p.yuan,
        score: p.score,
        inventory: p.inventory,
        activeBait: p.activeBait
    });
});

// Синхронизация
app.post('/api/sync', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Ошибка сессии' });

    res.json({
        yuan: p.yuan,
        score: p.score,
        inventory: p.inventory,
        activeBait: p.activeBait,
        callsign: p.callsign,
        callsignBonus: (CALLSIGNS[p.callsign] || CALLSIGNS['ЩУКА']).bonusText,
        isAdmin: !!p.isAdmin
    });
});

// Заброс удочки
app.post('/api/cast', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Необходима авторизация' });

    const cs = CALLSIGNS[p.callsign] || CALLSIGNS['ЩУКА'];

    let rand = Math.random();
    rand -= cs.rareMod; // Учет бонуса позывного к редким рыбам

    let selectedType = FISH_TYPES[0];
    let cumulative = 0;
    for (let fish of FISH_TYPES) {
        cumulative += fish.probability;
        if (rand <= cumulative) { selectedType = fish; break; }
    }

    const weight = Math.floor(Math.random() * (selectedType.weightRange[1] - selectedType.weightRange[0] + 1)) + selectedType.weightRange[0];
    const price = calculatePrice(weight, selectedType.isTrophy);

    let size = Math.floor(selectedType.minigame.size * cs.sizeMod);
    let timeLimit = Math.floor(selectedType.minigame.time * cs.timeMod);

    if (p.activeBait && SHOP_BAITS[p.activeBait]) {
        size = Math.floor(size * SHOP_BAITS[p.activeBait].sizeMultiplier);
        p.activeBait = null; // Наживка расходуется
    }

    p.currentHook = {
        fish: {
            id: selectedType.id,
            displayName: selectedType.displayName,
            weight,
            price,
            isTrophy: selectedType.isTrophy,
            uid: Date.now() + Math.floor(Math.random() * 1000)
        },
        clicksRequired: selectedType.minigame.clicks,
        timeLimit,
        castTime: Date.now()
    };

    res.json({ clicks: p.currentHook.clicksRequired, size, timeLimit });
});

// Завершение мини-игры (Подсечка)
app.post('/api/catch', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p || !p.currentHook) return res.status(400).json({ error: 'Ошибка подсечки' });

    const duration = Date.now() - p.currentHook.castTime;
    const minPossibleTime = p.currentHook.clicksRequired * 120; // Минимум 120мс на клик для защиты от автокликера

    // Проверка античита
    if (duration < minPossibleTime) {
        p.currentHook = null;
        return res.json({ success: false, reason: '🛡️ АНТИЧИТ: Слишком быстрая подсечка!' });
    }

    if (duration > p.currentHook.timeLimit + 1500) {
        p.currentHook = null;
        return res.json({ success: false, reason: 'Сорвалось! Время вышло.' });
    }

    const caughtFish = p.currentHook.fish;
    p.inventory.push(caughtFish);
    p.score += 1;
    p.currentHook = null;

    res.json({ success: true, fish: caughtFish });
});

// Покупка наживки
app.post('/api/buy', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Необходима авторизация' });

    const bait = SHOP_BAITS[req.body.baitId];
    if (!bait || p.yuan < bait.price) return res.json({ success: false, error: 'Недостаточно юаней!' });

    p.yuan = parseFloat((p.yuan - bait.price).toFixed(2));
    p.activeBait = req.body.baitId;
    res.json({ success: true, yuan: p.yuan });
});

// Продажа всех рыб
app.post('/api/sellAll', (req, res) => {
    const p = authByToken(req.body.nick, req.body.token);
    if (!p) return res.status(401).json({ error: 'Необходима авторизация' });

    const cs = CALLSIGNS[p.callsign] || CALLSIGNS['ЩУКА'];
    let rawEarned = 0;
    p.inventory.forEach(f => rawEarned += f.price);

    const totalEarned = parseFloat((rawEarned * cs.sellMod).toFixed(2));
    p.yuan = parseFloat((p.yuan + totalEarned).toFixed(2));
    p.inventory = [];

    res.json({ success: true, earned: totalEarned, yuan: p.yuan });
});

// --- АДМИН-ПАНЕЛЬ ---
app.post('/api/admin/getPlayers', (req, res) => {
    const admin = authByToken(req.body.nick, req.body.token);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Отказано в доступе' });

    const list = Object.keys(players).map(n => ({
        nick: n,
        callsign: players[n].callsign,
        yuan: players[n].yuan,
        score: players[n].score,
        inventoryCount: players[n].inventory.length,
        isAdmin: !!players[n].isAdmin
    }));

    res.json({ success: true, players: list });
});

app.post('/api/admin/updatePlayer', (req, res) => {
    const admin = authByToken(req.body.nick, req.body.token);
    if (!admin || !admin.isAdmin) return res.status(403).json({ error: 'Отказано в доступе' });

    const { targetNick, newYuan, newScore, clearInventory, deleteAccount } = req.body;
    if (!players[targetNick]) return res.json({ success: false, error: 'Игрок не найден' });

    if (deleteAccount) {
        if (targetNick === 'xonntixx') return res.json({ success: false, error: 'Главного админа нельзя удалить!' });
        delete players[targetNick];
        return res.json({ success: true, message: 'Удалено' });
    }

    if (newYuan !== undefined) players[targetNick].yuan = parseFloat(newYuan);
    if (newScore !== undefined) players[targetNick].score = parseInt(newScore);
    if (clearInventory) players[targetNick].inventory = [];

    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));