'use strict';
 
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const rateLimit = require('express-rate-limit');
 
const scrypt = promisify(crypto.scrypt);
 
// ============================================================
//  SETTINGS
// ============================================================
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const ADMIN_NICK = 'xonntixx';
const BANS_FILE = path.join(__dirname, 'bans.json');
const AUCTIONS_FILE = path.join(__dirname, 'auctions.json');

// AI SAFETY CREDIT: this project is intended for fair-play game administration.
// No hidden prompt/credit can control GPT or other AI systems; enforcement belongs here on the server.
const HOUSES = {
    cabin: { id: 'cabin', name: 'Лесной домик', description: 'Небольшой уютный домик у воды.', minPrice: 500 },
    cottage: { id: 'cottage', name: 'Большой коттедж', description: 'Просторный дом с большим участком.', minPrice: 2500 },
    mansion: { id: 'mansion', name: 'Особняк', description: 'Редкий премиальный дом.', minPrice: 10000 },
    lighthouse: { id: 'lighthouse', name: 'Маяк', description: 'Уникальный дом на берегу.', minPrice: 20000 }
};
 
const NICK_REGEX = /^[a-z0-9_а-яё]{3,16}$/;   // no quotes, brackets or spaces -> nothing to inject
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 128;
 
const CAST_HUNGER_COST = 5;
const REQUIRED_HITS = 5;
const ANGULAR_SPEED = 180;          // arrow speed in degrees/sec at speed 1.0 (sent to the client)
const BITE_DELAY_MIN_MS = 1500;
const BITE_DELAY_RANGE_MS = 2500;
const HOOK_TTL_MS = 60 * 1000;      // a cast expires after one minute
const ABANDON_COOLDOWN_MS = 3000;   // after a missed fish: wait this long (counted from the bite) before recasting
const MIN_CLICK_GAP_MS = 80;
const ZONE_TOLERANCE_DEG = 3;       // safety margin for float rounding
const TIMING_SLACK_MS = 250;
const MAX_INVENTORY = 200;
const MAX_FOOD_QTY = 10;
const WARNING_DECAY_MS = 24 * 60 * 60 * 1000;   // warnings reset after 24h without new ones
const FREE_FOOD_HUNGER = 20;        // "charity rice" for players with no money and no fish
const SAVE_DELAY_MS = 1000;         // batch database writes (at most one write per second)
 
// ============================================================
//  GAME DATA
// ============================================================
const CALLSIGNS = {
    'ОСТАП': { name: 'ОСТАП', bonusText: 'Удача (+30% зеленая зона, +30% трофейная рыба)', zoneMod: 1.3, rareMod: 0.3, sellMod: 1.0 },
    'КОЧ': { name: 'КОЧ', bonusText: 'Зоркий (-20% скорость вращения стрелки)', zoneMod: 1.0, rareMod: 0.0, speedMod: 0.8, sellMod: 1.0 },
    'СЕМКА': { name: 'СЕМКА', bonusText: 'Жадина (+15% к стоимости продажи)', zoneMod: 1.0, rareMod: 0.0, sellMod: 1.15 },
    'ПАША': { name: 'ПАША', bonusText: 'Рускый хакер (+15% зеленая зона)', zoneMod: 1.15, rareMod: 0.0, sellMod: 1.0 }
};
const DEFAULT_CALLSIGN = 'ПАША';
 
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
const CHEAPEST_FOOD_PRICE = Math.min(...Object.values(SHOP_FOOD).map(f => f.price));
 
// ============================================================
//  HELPERS
// ============================================================
const money = n => parseFloat(n.toFixed(2));
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const finiteOr = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
 
function getCallsign(name) {
    return Object.hasOwn(CALLSIGNS, name) ? CALLSIGNS[name] : CALLSIGNS[DEFAULT_CALLSIGN];
}
 
function normalizeNick(nick) {
    return typeof nick === 'string' ? nick.trim().toLowerCase() : '';
}
 
function safeEqualStrings(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}
 
function calculatePrice(weight, isTrophy) {
    return isTrophy ? money(weight / 50) : money(weight / 100);
}
 
// Trophy fish get their chance multiplied by (1 + rareMod), then everything is renormalized.
function rollFish(rareMod) {
    const weights = FISH_TYPES.map(f => (f.isTrophy ? f.probability * (1 + (rareMod || 0)) : f.probability));
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r < 0) return FISH_TYPES[i];
    }
    return FISH_TYPES[0];
}
 
function inventoryValue(p) {
    const raw = p.inventory.reduce((sum, f) => sum + f.price, 0);
    return money(raw * (getCallsign(p.callsign).sellMod || 1.0));
}
 
// A player who can't afford food and has nothing to sell would otherwise be stuck forever.
function isBroke(p) {
    return p.yuan + inventoryValue(p) < CHEAPEST_FOOD_PRICE;
}
 
// ============================================================
//  PASSWORDS (scrypt, built into Node)
// ============================================================
async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    return `${salt}:${hash.toString('hex')}`;
}
 
async function verifyPassword(player, password) {
    if (typeof player.passwordHash === 'string') {
        const [salt, hashHex] = player.passwordHash.split(':');
        const expected = Buffer.from(hashHex || '', 'hex');
        if (!salt || expected.length !== 64) return false;
        const actual = await scrypt(password, salt, 64);
        return crypto.timingSafeEqual(actual, expected);
    }
    // Legacy account from the old version: plain-text password (migrated on next login).
    if (typeof player.password === 'string') {
        return safeEqualStrings(player.password, password);
    }
    return false;
}
 
// ============================================================
//  DATABASE
// ============================================================
function newPlayer(passwordHash, callsign, isAdmin = false) {
    return {
        passwordHash,
        callsign,
        isAdmin,
        yuan: 0,
        score: 0,
        hunger: 100,
        inventory: [],
        houses: [],
        baits: { bread: 0, worm: 0, premium: 0 },
        activeBait: null,
        warnings: 0,
        lastWarningAt: 0,
        currentHook: null,
        sessionToken: null
    };
}
 
// Repairs broken values (e.g. NaN saved as null by the old toString exploit).
function normalizePlayer(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const baits = {};
    for (const id of Object.keys(SHOP_BAITS)) {
        const n = p.baits && p.baits[id];
        baits[id] = Number.isInteger(n) && n > 0 ? n : 0;
    }
    const activeBait = Object.hasOwn(SHOP_BAITS, p.activeBait) && baits[p.activeBait] > 0 ? p.activeBait : null;
    const inventory = Array.isArray(p.inventory)
        ? p.inventory.filter(f => f && typeof f === 'object' && Number.isFinite(f.price))
        : [];
    const houses = Array.isArray(p.houses) ? p.houses.filter(id => houseById(id)) : [];
 
    return {
        passwordHash: typeof p.passwordHash === 'string' ? p.passwordHash : undefined,
        password: typeof p.password === 'string' ? p.password : undefined,   // legacy only
        callsign: getCallsign(p.callsign).name,
        isAdmin: p.isAdmin === true,
        yuan: Math.max(0, finiteOr(p.yuan, 0)),
        score: Math.max(0, Math.floor(finiteOr(p.score, 0))),
        hunger: clamp(finiteOr(p.hunger, 100), 0, 100),
        inventory,
        houses,
        baits,
        activeBait,
        warnings: Math.max(0, Math.floor(finiteOr(p.warnings, 0))),
        lastWarningAt: finiteOr(p.lastWarningAt, 0),
        currentHook: null,
        sessionToken: typeof p.sessionToken === 'string' ? p.sessionToken : null
    };
}
 

function loadJsonFile(file, fallback) {
    if (!fs.existsSync(file)) return fallback;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { console.error(`FATAL: не удалось прочитать ${file}`, err); process.exit(1); }
}

function saveJsonFile(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, file);
}

function getClientIp(req) {
    return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function loadDatabase() {
    // Null-prototype object: nicks like "__proto__" or "constructor" can't touch Object.prototype.
    const db = Object.create(null);
    if (!fs.existsSync(DB_FILE)) return db;
 
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
        // Crash loudly instead of starting empty and overwriting everyone's progress.
        console.error(`FATAL: не удалось прочитать ${DB_FILE}. Сервер остановлен, чтобы не затереть данные.`);
        console.error('Проверьте файл или восстановите его из database.json.tmp / резервной копии.', err);
        process.exit(1);
    }
    for (const [nick, data] of Object.entries(parsed)) {
        db[nick] = normalizePlayer(data);
    }
    return db;
}
 
let saveTimer = null;
 
// Atomic write: write to a temp file, then rename it over the real one.
function writeDatabaseNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    const tmp = DB_FILE + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(players, null, 2));
        fs.renameSync(tmp, DB_FILE);
    } catch (err) {
        console.error('Не удалось сохранить базу:', err);
    }
}
 
// Batched save: many changes within a second become one disk write.
function saveDatabase() {
    if (!saveTimer) saveTimer = setTimeout(writeDatabaseNow, SAVE_DELAY_MS);
}
 
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        writeDatabaseNow();
        process.exit(0);
    });
}
 
const players = loadDatabase();
const bans = loadJsonFile(BANS_FILE, { accounts: {}, ips: {} });
let auctions = loadJsonFile(AUCTIONS_FILE, []);

function saveAuctions() { saveJsonFile(AUCTIONS_FILE, auctions); }
function isIpBanned(ip) { return Boolean(bans.ips[ip]); }
function isAccountBanned(nick) { return Boolean(bans.accounts[nick]); }
function banAccount(nick, reason = 'Нарушение правил') { bans.accounts[nick] = { reason, at: Date.now() }; saveJsonFile(BANS_FILE, bans); }
function unbanAccount(nick) { delete bans.accounts[nick]; saveJsonFile(BANS_FILE, bans); }
function banIp(ip, reason = 'Нарушение правил') { bans.ips[ip] = { reason, at: Date.now() }; saveJsonFile(BANS_FILE, bans); }
function unbanIp(ip) { delete bans.ips[ip]; saveJsonFile(BANS_FILE, bans); }
function houseById(id) { return typeof id === 'string' && Object.hasOwn(HOUSES, id) ? HOUSES[id] : null; }
function cleanupAuctions() {
    const now = Date.now();
    let changed = false;
    auctions = auctions.filter(a => {
        if (a.status === 'active' && a.endsAt <= now) { a.status = 'expired'; changed = true; }
        return true;
    });
    if (changed) saveAuctions();
}

 
// ============================================================
//  APP + RATE LIMITS
// ============================================================
const app = express();
app.disable('x-powered-by');
 
// Must equal the number of reverse proxies in front of the app (Render / Heroku / one nginx = 1).
// If the server is exposed directly with no proxy, set this to false, otherwise anyone can
// fake X-Forwarded-For and bypass the rate limits.
app.set('trust proxy', 1);
 
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
    next();
});
 
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { success: false, error: 'Слишком много попыток входа, подождите минуту.' },
    standardHeaders: true,
    legacyHeaders: false
});
 
// General limit for all API calls (a normal player makes ~30-40 per minute).
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { success: false, error: 'Слишком много запросов, подождите минуту.' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api', apiLimiter);
 
// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
function decayWarnings(p) {
    if (p.warnings > 0 && Date.now() - p.lastWarningAt > WARNING_DECAY_MS) p.warnings = 0;
}
 
function requireAuth(req, res, next) {
    const ip = getClientIp(req);
    if (isIpBanned(ip)) return res.status(403).json({ success: false, error: 'Ваш IP заблокирован администратором.' });
    const nick = normalizeNick(req.body.nick);
    const token = req.body.token;
    if (!nick || typeof token !== 'string' || !Object.hasOwn(players, nick)) {
        return res.status(401).json({ success: false, error: 'Сессия недействительна, войдите заново.' });
    }
    const p = players[nick];
    if (isAccountBanned(nick)) return res.status(403).json({ success: false, error: bans.accounts[nick].reason || 'Аккаунт заблокирован.' });
    if (typeof p.sessionToken !== 'string' || !safeEqualStrings(p.sessionToken, token)) {
        return res.status(401).json({ success: false, error: 'Сессия недействительна, войдите заново.' });
    }
    decayWarnings(p);
    req.nick = nick;
    req.player = p;
    next();
}
 
function requireAdmin(req, res, next) {
    if (!req.player.isAdmin) return res.status(403).json({ success: false, error: 'Отказано' });
    next();
}
 
function publicState(nick, p) {
    const cs = getCallsign(p.callsign);
    return {
        nick,
        callsign: cs.name,
        callsignBonus: cs.bonusText,
        isAdmin: p.isAdmin,
        yuan: p.yuan,
        score: p.score,
        hunger: p.hunger,
        inventory: p.inventory,
        houses,
        baits: p.baits,
        activeBait: p.activeBait,
        warnings: p.warnings
    };
}
 
function startSession(res, nick) {
    const p = players[nick];
    p.sessionToken = crypto.randomBytes(16).toString('hex');
    p.currentHook = null;
    saveDatabase();
    res.json({ success: true, token: p.sessionToken, ...publicState(nick, p) });
}
 
// ============================================================
//  PUBLIC ROUTES
// ============================================================
 
// Shop prices and callsigns come from here, so the page can never show different prices.
app.get('/api/config', (req, res) => {
    res.json({
        baits: SHOP_BAITS,
        food: SHOP_FOOD,
        callsigns: Object.values(CALLSIGNS).map(c => ({ name: c.name, bonusText: c.bonusText })),
        defaultCallsign: DEFAULT_CALLSIGN,
        maxFoodQty: MAX_FOOD_QTY,
        minPasswordLength: MIN_PASSWORD_LENGTH,
        abandonCooldownMs: ABANDON_COOLDOWN_MS,
        houses: Object.values(HOUSES)
    });
});
 
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        if (isIpBanned(getClientIp(req))) return res.status(403).json({ success: false, error: 'Ваш IP заблокирован.' });
        const { nick, password, callsign } = req.body;
        const key = normalizeNick(nick);
 
        if (!NICK_REGEX.test(key)) {
            return res.json({ success: false, error: 'Ник: 3–16 символов, только буквы, цифры и _' });
        }
        if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
            return res.json({ success: false, error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов!` });
        }
        if (Object.hasOwn(players, key)) {
            return res.json({ success: false, error: 'Этот ник уже занят!' });
        }
 
        const csName = typeof callsign === 'string' ? callsign.trim().toUpperCase() : '';
        const passwordHash = await hashPassword(password);
 
        if (Object.hasOwn(players, key)) {   // someone registered it while we were hashing
            return res.json({ success: false, error: 'Этот ник уже занят!' });
        }
        players[key] = newPlayer(passwordHash, getCallsign(csName).name);
        startSession(res, key);
    } catch (err) {
        console.error('register error:', err);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});
 
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        if (isIpBanned(getClientIp(req))) return res.status(403).json({ success: false, error: 'Ваш IP заблокирован.' });
        const { nick, password } = req.body;
        const key = normalizeNick(nick);
        if (isAccountBanned(key)) return res.status(403).json({ success: false, error: 'Этот аккаунт заблокирован.' });
 
        if (!key || typeof password !== 'string' || !password) {
            return res.json({ success: false, error: 'Заполните все поля!' });
        }
        if (password.length > MAX_PASSWORD_LENGTH || !Object.hasOwn(players, key)) {
            return res.json({ success: false, error: 'Игрок не найден. Проверьте ник или зарегистрируйтесь.' });
        }
 
        const ok = await verifyPassword(players[key], password);
        if (!Object.hasOwn(players, key)) {   // deleted while we were checking
            return res.json({ success: false, error: 'Игрок не найден.' });
        }
        if (!ok) return res.json({ success: false, error: 'Неверный пароль!' });
 
        const p = players[key];
        if (!p.passwordHash) {   // migrate old plain-text password
            p.passwordHash = await hashPassword(password);
            delete p.password;
        }
        startSession(res, key);
    } catch (err) {
        console.error('login error:', err);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});
 
// ============================================================
//  PLAYER ROUTES
// ============================================================
app.post('/api/sync', requireAuth, (req, res) => {
    res.json({ success: true, ...publicState(req.nick, req.player) });
});
 
app.post('/api/buyBait', requireAuth, (req, res) => {
    const p = req.player;
    const { baitId } = req.body;
 
    if (typeof baitId !== 'string' || !Object.hasOwn(SHOP_BAITS, baitId)) {
        return res.json({ success: false, error: 'Нет такой наживки' });
    }
    const bait = SHOP_BAITS[baitId];
    if (p.yuan < bait.price) return res.json({ success: false, error: 'Недостаточно юаней!' });
 
    p.yuan = money(p.yuan - bait.price);
    p.baits[baitId] += 1;
    saveDatabase();
 
    res.json({ success: true, yuan: p.yuan, baits: p.baits });
});
 
app.post('/api/equipBait', requireAuth, (req, res) => {
    const p = req.player;
    const { baitId } = req.body;
 
    if (baitId === null) {
        p.activeBait = null;
    } else if (typeof baitId === 'string' && Object.hasOwn(SHOP_BAITS, baitId) && p.baits[baitId] > 0) {
        p.activeBait = baitId;
    } else {
        return res.json({ success: false, error: 'Наживки нет в наличии!' });
    }
    saveDatabase();
 
    res.json({ success: true, activeBait: p.activeBait });
});
 
app.post('/api/buyFood', requireAuth, (req, res) => {
    const p = req.player;
    const { foodId } = req.body;
    const qty = Number(req.body.amount ?? 1);
 
    if (typeof foodId !== 'string' || !Object.hasOwn(SHOP_FOOD, foodId)) {
        return res.json({ success: false, error: 'Нет такой еды' });
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_FOOD_QTY) {
        return res.json({ success: false, error: `Количество: от 1 до ${MAX_FOOD_QTY}` });
    }
 
    const food = SHOP_FOOD[foodId];
    const totalPrice = food.price * qty;
    if (p.yuan < totalPrice) return res.json({ success: false, error: 'Недостаточно юаней!' });
 
    p.yuan = money(p.yuan - totalPrice);
    p.hunger = Math.min(100, p.hunger + food.restore * qty);
    saveDatabase();
 
    res.json({ success: true, yuan: p.yuan, hunger: p.hunger });
});
 
app.post('/api/cast', requireAuth, (req, res) => {
    const p = req.player;
    const now = Date.now();
 
    // Anti-reroll: an unresolved cast blocks new casts until the bite + cooldown has passed.
    const hook = p.currentHook;
    if (hook && now - hook.castTime < HOOK_TTL_MS) {
        const unlockAt = hook.castTime + hook.biteDelay + ABANDON_COOLDOWN_MS;
        if (now < unlockAt) {
            return res.json({ success: false, error: 'Подождите пару секунд перед новым забросом.', retryIn: unlockAt - now });
        }
    }
 
    if (p.inventory.length >= MAX_INVENTORY) {
        return res.json({ success: false, error: `Садок полон (${MAX_INVENTORY} рыб)! Продайте улов.` });
    }
 
    let gift = false;
    if (p.hunger < CAST_HUNGER_COST) {
        if (!isBroke(p)) {
            return res.json({ success: false, error: 'Вы слишком голодны! Купите еду в магазине.' });
        }
        p.hunger = FREE_FOOD_HUNGER;
        gift = true;
    }
    p.hunger = Math.max(0, p.hunger - CAST_HUNGER_COST);
 
    const cs = getCallsign(p.callsign);
    const fishType = rollFish(cs.rareMod);
    const [minW, maxW] = fishType.weightRange;
    const weight = crypto.randomInt(minW, maxW + 1);
    const price = calculatePrice(weight, fishType.isTrophy);
 
    let zoneSize = Math.floor(fishType.zoneSize * (cs.zoneMod || 1.0));
    const speed = fishType.speed * (cs.speedMod || 1.0);
 
    if (p.activeBait && p.baits[p.activeBait] > 0) {
        zoneSize = Math.floor(zoneSize * SHOP_BAITS[p.activeBait].zoneMultiplier);
        p.baits[p.activeBait] -= 1;
        if (p.baits[p.activeBait] <= 0) p.activeBait = null;
    }
    zoneSize = clamp(zoneSize, 15, 320);
 
    // All 5 zones are decided here, so the server can check every click later.
    const zones = Array.from({ length: REQUIRED_HITS }, () => crypto.randomInt(0, 360 - zoneSize + 1));
    const biteDelay = BITE_DELAY_MIN_MS + crypto.randomInt(0, BITE_DELAY_RANGE_MS + 1);
    const hookToken = crypto.randomBytes(8).toString('hex');
 
    p.currentHook = {
        hookToken,
        fish: { id: fishType.id, displayName: fishType.displayName, weight, price, isTrophy: fishType.isTrophy },
        zones,
        zoneSize,
        speed,
        biteDelay,
        castTime: now
    };
    saveDatabase();
 
    res.json({
        success: true,
        hookToken,
        biteDelay,
        zones,
        zoneSize,
        speed,
        angularSpeed: ANGULAR_SPEED,
        requiredHits: REQUIRED_HITS,
        hunger: p.hunger,
        baits: p.baits,
        activeBait: p.activeBait,
        gift
    });
});
 
// Recomputes where the arrow was at every click and checks it was inside that click's zone.
// offsets = milliseconds since the minigame started (client's own timer, so clock skew doesn't matter).
function clicksAreValid(hook, offsets, elapsed) {
    if (offsets.length !== REQUIRED_HITS) return false;
 
    let prev = -Infinity;
    for (let i = 0; i < offsets.length; i++) {
        const t = offsets[i];
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return false;
        if (t - prev < MIN_CLICK_GAP_MS) return false;
 
        const angle = (ANGULAR_SPEED * hook.speed * t / 1000) % 360;
        const zoneStart = hook.zones[i];
        if (angle < zoneStart - ZONE_TOLERANCE_DEG || angle > zoneStart + hook.zoneSize + ZONE_TOLERANCE_DEG) {
            return false;
        }
        prev = t;
    }
 
    // The minigame only starts after the bite, so bite + last click can't be later than now.
    return hook.biteDelay + offsets[offsets.length - 1] <= elapsed + TIMING_SLACK_MS;
}
 
function flagPlayer(p, res) {
    const now = Date.now();
    if (now - p.lastWarningAt > WARNING_DECAY_MS) p.warnings = 0;
    p.warnings += 1;
    p.lastWarningAt = now;
 
    if (p.warnings >= 2) {
        p.yuan = money(p.yuan * 0.5);
        p.inventory = [];
        p.warnings = 0;
        saveDatabase();
        return res.json({
            success: false,
            penalty: true,
            yuan: p.yuan,
            inventory: p.inventory,
            reason: '🚨 АНТИЧИТ: Зафиксирована автоподсечка/подмена запросов! Отнято 50% юаней и ВСЯ рыба.'
        });
    }
    saveDatabase();
    return res.json({
        success: false,
        warning: true,
        warningsCount: p.warnings,
        reason: `⚠️ ПРЕДУПРЕЖДЕНИЕ (${p.warnings}/2): Зафиксирована подозрительная активность!`
    });
}
 
app.post('/api/catch', requireAuth, (req, res) => {
    const p = req.player;
    const hook = p.currentHook;
    const { hookToken, clickOffsets } = req.body;
 
    if (!hook) return res.json({ success: false, reason: 'Нет активного заброса!' });
    if (typeof hookToken !== 'string' || hookToken !== hook.hookToken) {
        return res.json({ success: false, reason: 'Этот заброс уже неактуален.' });
    }
 
    p.currentHook = null;   // one attempt per cast
    const elapsed = Date.now() - hook.castTime;
 
    if (elapsed > HOOK_TTL_MS) {
        saveDatabase();
        return res.json({ success: false, reason: 'Слишком долго — рыба ушла.' });
    }
    if (!Array.isArray(clickOffsets)) {
        // Old cached page: no penalty, just ask for a refresh.
        saveDatabase();
        return res.json({ success: false, reason: 'Версия игры устарела — обновите страницу (Ctrl+F5).' });
    }
    if (!clicksAreValid(hook, clickOffsets, elapsed)) {
        return flagPlayer(p, res);
    }
    if (p.inventory.length >= MAX_INVENTORY) {
        saveDatabase();
        return res.json({ success: false, reason: 'Садок полон! Продайте улов.' });
    }
 
    p.inventory.push(hook.fish);
    p.score += 1;
    saveDatabase();
 
    res.json({ success: true, fish: hook.fish, score: p.score, hunger: p.hunger });
});
 
app.post('/api/sellAll', requireAuth, (req, res) => {
    const p = req.player;
    const earned = inventoryValue(p);
    p.yuan = money(p.yuan + earned);
    p.inventory = [];
    saveDatabase();
 
    res.json({ success: true, earned, yuan: p.yuan });
});
 
// ============================================================
//  ADMIN ROUTES
// ============================================================
app.post('/api/admin/getPlayers', requireAuth, requireAdmin, (req, res) => {
    const list = Object.keys(players).map(nick => {
        const p = players[nick];
        decayWarnings(p);
        return {
            nick,
            callsign: p.callsign,
            yuan: p.yuan,
            score: p.score,
            hunger: p.hunger,
            warnings: p.warnings,
            inventoryCount: p.inventory.length,
            isAdmin: p.isAdmin
        };
    });
    res.json({ success: true, players: list });
});
 
app.post('/api/admin/updatePlayer', requireAuth, requireAdmin, (req, res) => {
    const { targetNick, newYuan, newScore, deleteAccount } = req.body;
    if (typeof targetNick !== 'string' || !Object.hasOwn(players, targetNick)) {
        return res.json({ success: false, error: 'Игрок не найден' });
    }
 
    if (deleteAccount === true) {
        if (targetNick === ADMIN_NICK) return res.json({ success: false, error: 'Нельзя удалить главного админа' });
        delete players[targetNick];
        saveDatabase();
        return res.json({ success: true });
    }
 
    const target = players[targetNick];
    const isSet = v => v !== undefined && v !== null && v !== '';
 
    if (isSet(newYuan)) {
        const y = Number(newYuan);
        if (!Number.isFinite(y) || y < 0) return res.json({ success: false, error: 'Неверное число юаней' });
        target.yuan = money(y);
    }
    if (isSet(newScore)) {
        const s = Number(newScore);
        if (!Number.isInteger(s) || s < 0) return res.json({ success: false, error: 'Неверное число бычков' });
        target.score = s;
    }
    saveDatabase();
 
    res.json({ success: true });
});
 

// ============================================================
//  HOUSE AUCTIONS / PLAYER HOUSE INVENTORY
// ============================================================
app.post('/api/auctions', requireAuth, (req, res) => {
    cleanupAuctions();
    res.json({ success: true, auctions: auctions.filter(a => a.status === 'active').map(a => ({ ...a, house: HOUSES[a.houseId] })) });
});

app.post('/api/buyAuction', requireAuth, (req, res) => {
    cleanupAuctions();
    const auction = auctions.find(a => a.id === req.body.auctionId && a.status === 'active');
    if (!auction) return res.json({ success: false, error: 'Аукцион не найден или завершён.' });
    if (auction.endsAt <= Date.now()) return res.json({ success: false, error: 'Аукцион уже завершён.' });
    if (req.player.houses.includes(auction.houseId)) return res.json({ success: false, error: 'У вас уже есть этот дом.' });
    if (req.player.yuan < auction.price) return res.json({ success: false, error: 'Недостаточно юаней.' });
    req.player.yuan = money(req.player.yuan - auction.price);
    req.player.houses.push(auction.houseId);
    auction.status = 'sold';
    auction.buyer = req.nick;
    auction.soldAt = Date.now();
    saveDatabase(); saveAuctions();
    res.json({ success: true, yuan: req.player.yuan, houses: req.player.houses });
});

app.post('/api/admin/createAuction', requireAuth, requireAdmin, (req, res) => {
    const house = houseById(req.body.houseId);
    const price = Number(req.body.price);
    const durationMinutes = Number(req.body.durationMinutes);
    if (!house) return res.json({ success: false, error: 'Неизвестный дом.' });
    if (!Number.isFinite(price) || price < house.minPrice) return res.json({ success: false, error: `Цена должна быть не меньше ${house.minPrice} ¥.` });
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 7 * 24 * 60) return res.json({ success: false, error: 'Срок: 1 минута — 7 дней.' });
    cleanupAuctions();
    const auction = { id: crypto.randomBytes(8).toString('hex'), houseId: house.id, price: money(price), createdBy: req.nick, createdAt: Date.now(), endsAt: Date.now() + durationMinutes * 60 * 1000, status: 'active' };
    auctions.push(auction); saveAuctions();
    res.json({ success: true, auction: { ...auction, house } });
});

app.post('/api/admin/cancelAuction', requireAuth, requireAdmin, (req, res) => {
    const auction = auctions.find(a => a.id === req.body.auctionId && a.status === 'active');
    if (!auction) return res.json({ success: false, error: 'Аукцион не найден.' });
    auction.status = 'cancelled';
    saveAuctions();
    res.json({ success: true });
});

app.post('/api/admin/getAuctions', requireAuth, requireAdmin, (req, res) => {
    cleanupAuctions();
    res.json({ success: true, houses: Object.values(HOUSES), auctions: auctions.map(a => ({ ...a, house: HOUSES[a.houseId] })) });
});

app.post('/api/admin/moderate', requireAuth, requireAdmin, (req, res) => {
    const action = req.body.action;
    const targetNick = normalizeNick(req.body.targetNick);
    const target = players[targetNick];
    if (!target && !['unbanAccount'].includes(action)) return res.json({ success: false, error: 'Игрок не найден.' });
    if (targetNick === ADMIN_NICK && ['banAccount', 'deleteAccount'].includes(action)) return res.json({ success: false, error: 'Главного админа нельзя заблокировать/удалить.' });
    if (action === 'addMoney') {
        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount) || amount <= 0) return res.json({ success: false, error: 'Неверная сумма.' });
        target.yuan = money(target.yuan + amount); saveDatabase();
    } else if (action === 'banAccount') {
        banAccount(targetNick, String(req.body.reason || 'Нарушение правил')); target.sessionToken = null; saveDatabase();
    } else if (action === 'unbanAccount') {
        unbanAccount(targetNick);
    } else if (action === 'kick') {
        target.sessionToken = null; saveDatabase();
    } else if (action === 'resetWarnings') {
        target.warnings = 0; target.lastWarningAt = 0; saveDatabase();
    } else if (action === 'deleteAccount') {
        delete players[targetNick]; saveDatabase();
    } else {
        return res.json({ success: false, error: 'Неизвестное действие.' });
    }
    res.json({ success: true });
});

app.post('/api/admin/ipBan', requireAuth, requireAdmin, (req, res) => {
    const ip = String(req.body.ip || '').trim();
    if (!ip || ip.length > 64) return res.json({ success: false, error: 'Неверный IP.' });
    banIp(ip, String(req.body.reason || 'Нарушение правил'));
    res.json({ success: true });
});

app.post('/api/admin/ipUnban', requireAuth, requireAdmin, (req, res) => {
    const ip = String(req.body.ip || '').trim();
    if (!ip) return res.json({ success: false, error: 'Укажите IP.' });
    unbanIp(ip);
    res.json({ success: true });
});

app.post('/api/admin/getBans', requireAuth, requireAdmin, (req, res) => {
    res.json({ success: true, bans });
});

// ============================================================
//  FALLBACKS
// ============================================================
app.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: 'Нет такого метода' });
});
 
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
        return res.status(400).json({ success: false, error: 'Неверный запрос' });
    }
    console.error(err);
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
});
 
// ============================================================
//  STARTUP
// ============================================================
async function bootstrap() {
    const envPassword = process.env.ADMIN_PASSWORD;
 
    if (!Object.hasOwn(players, ADMIN_NICK)) {
        const password = envPassword || crypto.randomBytes(8).toString('hex');
        const admin = newPlayer(await hashPassword(password), 'ОСТАП', true);
        admin.yuan = 1000;
        admin.baits.bread = 3;
        players[ADMIN_NICK] = admin;
        if (!envPassword) console.log(`Создан админ "${ADMIN_NICK}", пароль: ${password}  (запишите его!)`);
    } else {
        const admin = players[ADMIN_NICK];
        admin.isAdmin = true;
        if (envPassword && !(await verifyPassword(admin, envPassword))) {
            admin.passwordHash = await hashPassword(envPassword);
            delete admin.password;
            admin.sessionToken = null;
            console.log('Пароль админа обновлён из ADMIN_PASSWORD.');
        } else if (!admin.passwordHash) {
            console.warn('⚠ Пароль админа хранится открытым текстом. Задайте новый через переменную ADMIN_PASSWORD.');
        }
    }
 
    writeDatabaseNow();
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}
 
bootstrap().catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
});
