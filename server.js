const express = require("express");
const path = require("path");
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rarities = [
    { id: 'dirty', name: 'Грязный бычок', chance: 38, minWeight: 30, maxWeight: 70, trophyMin: 100, points: 1, class: 'rarity-common', targetSize: 100, speed: 2 },
    { id: 'used', name: 'б/у бычок', chance: 30, minWeight: 70, maxWeight: 100, trophyMin: 150, points: 2, class: 'rarity-uncommon', targetSize: 85, speed: 2.3 },
    { id: 'chill', name: 'Чиловый бычок', chance: 20, minWeight: 50, maxWeight: 80, trophyMin: 100, points: 3, class: 'rarity-rare', targetSize: 75, speed: 2.6 },
    { id: 'golden', name: 'Золотой бычок', chance: 9, minWeight: 200, maxWeight: 800, trophyMin: 1000, points: 10, class: 'rarity-epic', targetSize: 55, speed: 3.2 },
    { id: 'look', name: 'Лукбычок', chance: 3, minWeight: 2000, maxWeight: 4000, trophyMin: 5000, points: 25, class: 'rarity-legendary', targetSize: 40, speed: 4.0 }
];

app.post("/api/catch", (req, res) => {
    let roll = Math.random() * 100;
    let caughtItem = rarities[0];

    for (let i = 0; i < rarities.length; i++) {
        if (roll < rarities[i].chance) {
            caughtItem = rarities[i];
            break;
        }
        roll -= rarities[i].chance;
    }

    const isTrophy = Math.random() < 0.10;
    let weight = isTrophy 
        ? Math.round(caughtItem.trophyMin + Math.random() * (caughtItem.trophyMin * 0.3))
        : Math.round(caughtItem.minWeight + Math.random() * (caughtItem.maxWeight - caughtItem.minWeight));

    // 100 гр = 1 юань, трофейные 100 гр = 2 юаня
    const pricePer100g = isTrophy ? 2 : 1;
    const price = Math.round((weight / 100) * pricePer100g * 10) / 10;

    res.json({
        id: caughtItem.id,
        name: caughtItem.name,
        displayName: isTrophy ? `🏆 ${caughtItem.name}` : caughtItem.name,
        weight: weight,
        price: price,
        points: caughtItem.points,
        class: caughtItem.class,
        isTrophy: isTrophy,
        targetSize: caughtItem.targetSize,
        speed: caughtItem.speed
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Сервер запущен на порту " + PORT);
});