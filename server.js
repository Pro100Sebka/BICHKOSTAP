const express = require('express');
const app = express();
const path = require('path');

app.use(express.json());
app.use(express.static('public'));

// База данных в оперативной памяти (при перезапуске сервера сбросится)
const players = {};

const FISH_TYPES = [
    { id: 'dirty', displayName: 'ГРЯЗНЫЙ БЫЧОК 🚬', weightRange: [30, 70], priceMultiplier: 0.5, class: 'rarity-common', probability: 0.4, minigame: { clicks: 3, size: 60, time: 3000 } },
    { id: 'used', displayName: 'Б/У БЫЧОК 👟', weightRange: [70, 100], priceMultiplier: 0.8, class: 'rarity-uncommon', probability: 0.3, minigame: { clicks: 3, size: 50, time: 2500 } },
    { id: 'chill', displayName: 'ЧИЛОВЫЙ БЫЧОК 😎', weightRange: [50, 80], priceMultiplier: 1.5, class: 'rarity-rare', probability: 0.15, minigame: { clicks: 4, size: 40, time: 2000 } },
    { id: 'golden', displayName: 'ЗОЛОТОЙ БЫЧОК ✨', weightRange: [200, 800], priceMultiplier: 5.0, class: 'rarity-epic', probability: 0.1, minigame: { clicks: 4, size: 30, time: 1800 } },
    { id: 'look', displayName: 'ЛУКБЫЧОК 🌱', weightRange: [2000, 4000], priceMultiplier: 15.0, class: 'rarity-legendary', isTrophy: true, probability: 0.05, minigame: { clicks: 5, size: 20, time: 1500 } }
];

const SHOP_BAITS = {
    'bread': { name: 'Хлеб', price: 50, sizeMultiplier: 1.2 },
    'worm': { name: 'Червяк', price: 150, sizeMultiplier: 1.5 },
    'premium': { name: 'Опарыш', price: 500, sizeMultiplier: 2.0 }
};

function getPlayer(nick) {
    if (!players[nick]) {
        players[nick] = { yuan: 0, score: 0, inventory: [], activeBait: null, currentHook: null };
    }
    return players[nick];
}

// Получить статус игрока
app.post('/api/sync', (req, res) => {
    const p = getPlayer(req.body.nick);
    res.json({ yuan: p.yuan, score: p.score, inventory: p.inventory, activeBait: p.activeBait });
});

// Заброс удочки
app.post('/api/cast', (req, res) => {
    const p = getPlayer(req.body.nick);
    
    let rand = Math.random();
    // Бонус Остапа
    if (req.body.nick.toLowerCase() === 'остап') rand -= 0.15; 
    
    let selectedType = FISH_TYPES[0];
    let cumulative = 0;
    for (let fish of FISH_TYPES) {
        cumulative += fish.probability;
        if (rand <= cumulative) { selectedType = fish; break; }
    }

    const weight = Math.floor(Math.random() * (selectedType.weightRange[1] - selectedType.weightRange[0] + 1)) + selectedType.weightRange[0];
    const price = parseFloat((weight * selectedType.priceMultiplier * 0.1).toFixed(1));

    let size = selectedType.minigame.size;
    if (p.activeBait) {
        size = Math.floor(size * SHOP_BAITS[p.activeBait].sizeMultiplier);
        p.activeBait = null; // Наживка тратится
    }

    p.currentHook = {
        fish: { id: selectedType.id, displayName: selectedType.displayName, weight, price, class: selectedType.class, uid: Date.now() },
        clicksRequired: selectedType.minigame.clicks,
        timeLimit: selectedType.minigame.time,
        castTime: Date.now()
    };

    res.json({ clicks: p.currentHook.clicksRequired, size, timeLimit: p.currentHook.timeLimit });
});

// Проверка улова
app.post('/api/catch', (req, res) => {
    const p = getPlayer(req.body.nick);
    if (!p.currentHook) return res.status(400).json({ error: "Не клюет!" });

    const timeTaken = Date.now() - p.currentHook.castTime;
    
    // Защита от автокликеров (сделал слишком быстро или не уложился во время)
    if (timeTaken > p.currentHook.timeLimit + 2000 || timeTaken < 100) {
        p.currentHook = null;
        return res.json({ success: false, reason: "Сорвалось или чит!" });
    }

    const caughtFish = p.currentHook.fish;
    p.inventory.push(caughtFish);
    p.score += 1;
    p.currentHook = null;

    res.json({ success: true, fish: caughtFish });
});

// Покупка наживки
app.post('/api/buy', (req, res) => {
    const p = getPlayer(req.body.nick);
    const bait = SHOP_BAITS[req.body.baitId];
    if (!bait || p.yuan < bait.price) return res.json({ success: false });

    p.yuan -= bait.price;
    p.activeBait = req.body.baitId;
    res.json({ success: true, yuan: p.yuan });
});

// Продажа всей рыбы
app.post('/api/sellAll', (req, res) => {
    const p = getPlayer(req.body.nick);
    let earned = 0;
    p.inventory.forEach(f => earned += f.price);
    p.yuan += earned;
    p.inventory = [];
    res.json({ success: true, earned, yuan: p.yuan });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));