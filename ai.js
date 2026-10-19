const teeworlds = require("teeworlds");
const readline = require("readline");

const config = {
    host: "46.174.54.240",
    port: 8303,
    botNick: "DDNET-AI", 
    bridgeUrl: "http://localhost:3333/api/ask", 
    provider: "auto", 
    maxReplyLength: 200,
    replyDelay: 1000,
    partDelay: 2000,
    defaultPrefix: "!",
    owners: ["Your_Admin_Nick"], 
    admins: []
};

let client = null;
let aiEnabled = true;
let isProcessing = false; 
let clearTimer = null; 
let currentGuessGame = null; 
let lastHelpTime = 0;

const scores = new Map();
let activeBomb = null;
let bombTimer = null;

const floodTracker = new Map();
const mutedPlayers = new Map(); 
const manualIgnore = new Set(); 

// Функция для отправки в игру + дублирования в консоль
function sayToGame(text) {
    try {
        client.game.Say(text);
        console.log(`\x1b[35m[БОТ]\x1b[0m ${text}`);
    } catch(e) {}
}

function sendLongMessage(author, message) {
    const clean = message.replace(new RegExp(`^${author}\\s*[:,\\-]+\\s*`,'i'),'').replace(/^\S+\s*:\s*/,'').trim();
    const full = `${author}: ${clean}`;
    if(full.length<=config.maxReplyLength) { sayToGame(full); return; }
    const parts=[]; let rem=clean;
    while(rem.length>0) { let chunk; if(rem.length<=config.maxReplyLength-author.length-2) { chunk=rem; rem=''; } else { let splitAt=-1; for(const c of ['. ','! ','? ',', ','; ',': ',' - ',' ']) { const p=rem.lastIndexOf(c,config.maxReplyLength-author.length-2); if(p>splitAt) splitAt=p; } if(splitAt===-1) splitAt=config.maxReplyLength-author.length-2; chunk=rem.substring(0,splitAt+1).trim(); rem=rem.substring(splitAt+1).trim(); } parts.push(chunk); }
    let delay=0; for(let i=0;i<parts.length;i++) { const msg=i===0?`${author}: ${parts[i]}`:`${author}: ...${parts[i]}`; setTimeout(()=>{sayToGame(msg)}, delay); delay+=config.partDelay; }
}

function isOwner(author) { return config.owners.includes(author) || author === "ConsoleAdmin"; }
function isAdmin(author) { return config.owners.includes(author) || config.admins.includes(author) || author === "ConsoleAdmin"; }

function checkFlood(author, text) {
    const now = Date.now();
    if (manualIgnore.has(author)) return true;
    if (mutedPlayers.has(author)) {
        if (now < mutedPlayers.get(author)) return true; 
        else mutedPlayers.delete(author); 
    }
    if (!floodTracker.has(author)) floodTracker.set(author, { messages: [] });
    const tracker = floodTracker.get(author);
    tracker.messages = tracker.messages.filter(m => now - m.time < 10000);
    tracker.messages.push({ text: text.toLowerCase().trim(), time: now });
    
    if (tracker.messages.length > 4) {
        mutedPlayers.set(author, now + 60000);
        tracker.messages = []; 
        sayToGame(`${author}: Пожалуйста, не флудите.`);
        return true; 
    }
    return false;
}

function tryCalculate(text) {
    const match = text.match(/[-+*/().\d\s]+/g);
    if (!match) return null;
    const expr = match.sort((a, b) => b.length - a.length)[0].trim();
    if (expr.length < 3) return null; 
    if (!/[+\-*/]/.test(expr)) return null;
    try {
        const result = new Function('"use strict"; return (' + expr + ')')();
        if (result === undefined || isNaN(result) || !isFinite(result)) return null;
        return { expr: expr, result: Number.isInteger(result) ? result : result.toFixed(2) };
    } catch (e) { return null; }
}

function botAction(action, author) {
    try {
        if (action.includes("налево") || action === "left") sayToGame(`${author}: Выполняю движение влево.`);
        else if (action.includes("направо") || action === "right") sayToGame(`${author}: Выполняю движение вправо.`);
        else if (action.includes("прыгай") || action === "jump") sayToGame(`Выполняю прыжок.`);
        else if (action.includes("стреляй") || action === "shoot") sayToGame(`Произвожу выстрел.`);
        else sayToGame(`${author}: Неизвестная команда.`);
    } catch(e) { console.log("Ошибка выполнения:", e.message); }
}

async function processMessage(author, text) {
    if (!aiEnabled) return;
    const promptText = text.replace(new RegExp(config.botNick, "ig"), "").trim() || "Привет!";
    
    console.log(`\x1b[36m[ИИ]\x1b[0m Запрос от ${author}: "${promptText}"`);

    const hardPrompt = `Ты — вежливый и полезный игровой ассистент на сервере DDNet по имени ${config.botNick}. Игрок ${author} пишет: "${promptText}". Ответь четко, по делу и без лишних эмоций. Максимум 1-2 предложения.`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000);

        const bodyData = { prompt: hardPrompt };
        if (config.provider !== "auto") bodyData.provider = config.provider;

        const response = await fetch(config.bridgeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        let reply = data.answer || data.response || data.message || "";
        
        if (!reply || reply.includes('write_file') || reply.includes('"path"')) {
            const match = reply.match(/"content"\s*:\s*"([^"]+)"/);
            if (match) reply = match[1]; else return;
        }
        reply = reply.replace(/^["']|["']$/g, '').trim();
        
        if (reply.length > 2) {
            sendLongMessage(author, reply);
        }
    } catch (e) { 
        if (e.name === 'AbortError') console.error('\x1b[31m[ИИ] Ошибка: Таймаут\x1b[0m');
        else console.error('\x1b[31m[ИИ] Ошибка API:\x1b[0m', e.message); 
    }
}

function startClient() {
    client = new teeworlds.Client(config.host, config.port, config.botNick);
    
    client.on("connected", () => {
        console.log(`\x1b[32m[OK] Бот подключен к ${config.host}:${config.port}\x1b[0m`);
        setTimeout(() => {
            sayToGame(`${config.botNick} готов к работе. Введите ${config.defaultPrefix}help для списка команд.`);
        }, 2000);
    });

    client.on("disconnect", (reason) => { 
        console.log(`\x1b[31m[ERR] Соединение разорвано: ${reason}. Переподключение через 5 сек...\x1b[0m`);
        setTimeout(() => { startClient(); }, 5000);
    });

    client.on("message", async (msg) => {
        try {
            let text = String(msg.message ?? "").trim();
            const author = msg.author?.ClientInfo?.name ?? "Server";
            if (author === config.botNick) return;

            console.log(`\x1b[90m[ЧАТ]\x1b[0m ${author}: ${text}`);
            handleCommand(author, text);
            
        } catch (err) { isProcessing = false; }
    });
    client.connect();
}

async function handleCommand(author, text) {
    try {
        if (author === config.botNick && text.startsWith(`${config.botNick}:`)) return;

        if (text.toLowerCase().startsWith("!bot ")) {
            botAction(text.slice(5).toLowerCase().trim(), author);
            return;
        }

        // --- ВЛАДЕЛЬСКИЕ КОМАНДЫ ---
        if (text === "!restart") {
            if (!isOwner(author)) { sayToGame(`${author}: Эта команда доступна только владельцу бота.`); return; }
            sayToGame("Перезагрузка..."); 
            setTimeout(() => process.exit(1), 1500); 
            return;
        }
        if (text === "!stop") {
            if (!isOwner(author)) { sayToGame(`${author}: Эта команда доступна только владельцу бота.`); return; }
            sayToGame("Выключение..."); 
            setTimeout(() => process.exit(0), 1500); 
            return;
        }

        // --- ИГРЫ ---
        if (text === "!бомба" || text === "!bomb") {
            if (activeBomb) { sayToGame(`${author}: Бомба уже активирована игроком ${activeBomb}.`); return; }
            activeBomb = author;
            sayToGame(`[БОМБА] Передана игроку ${author}! У вас 5 секунд, чтобы отдать её: !передать [ник]`);
            if (bombTimer) clearTimeout(bombTimer);
            bombTimer = setTimeout(() => {
                if (activeBomb) { sayToGame(`[БУМ] Время вышло! Бомба взорвалась у ${activeBomb}.`); activeBomb = null; }
            }, 5000);
            return;
        }
        
        if (text.startsWith("!передать") || text.startsWith("!pass")) {
            if (!activeBomb) { sayToGame(`${author}: Нет активной бомбы.`); return; }
            if (activeBomb.toLowerCase() !== author.toLowerCase()) { sayToGame(`${author}: Бомба не у вас!`); return; }
            const target = text.split(" ")[1];
            if (!target || target.toLowerCase() === author.toLowerCase()) { sayToGame(`Укажите другого игрока: !передать Ник`); return; }
            
            activeBomb = target;
            setTimeout(() => { sayToGame(`[БОМБА] Игрок ${author} передал бомбу игроку ${target}! (5 сек)`); }, 500);

            if (bombTimer) clearTimeout(bombTimer);
            bombTimer = setTimeout(() => {
                if (activeBomb) { sayToGame(`[БУМ] Время вышло! Бомба взорвалась у ${activeBomb}.`); activeBomb = null; }
            }, 5000);
            return;
        }

        if (text === "!топ" || text === "!top") {
            if (scores.size === 0) { sayToGame(`Таблица лидеров пока пуста.`); return; }
            const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
            sayToGame(`[ТОП] Лучшие игроки: ${sorted.map((s, i) => `${i+1}) ${s[0]}: ${s[1]}`).join(' | ')}`);
            return;
        }

        if (text === "!balance" || text === "!баланс") {
            const bal = scores.get(author) || 0;
            sayToGame(`[БАЛАНС] У игрока ${author} на счету: ${bal} очков.`);
            return;
        }
        
        if (text === "!угадай") {
            if (currentGuessGame) { sayToGame(`${author}: Игра уже запущена.`); return; }
            currentGuessGame = { number: Math.floor(Math.random() * 100) + 1, tries: 0 };
            sayToGame(`[ИГРА] Я загадал число от 1 до 100. Введите: !число [ваше число]`);
            return;
        }
        if (text.startsWith("!число")) {
            if (!currentGuessGame) { sayToGame(`${author}: Сначала введите !угадай`); return; }
            const guess = parseInt(text.split(" ")[1]);
            if (isNaN(guess)) { sayToGame(`${author}: Введите число цифрами. Пример: !число 50`); return; }
            currentGuessGame.tries++;
            if (guess === currentGuessGame.number) {
                sayToGame(`[ПОБЕДА] Поздравляю, ${author}! Вы угадали число за ${currentGuessGame.tries} попыток.`);
                currentGuessGame = null;
            } else {
                sayToGame(`${author}: ${guess < currentGuessGame.number ? "Загаданное число больше" : "Загаданное число меньше"}.`);
            }
            return;
        }
        
        if (text === "!монетка" || text === "!coin") { 
            sayToGame(`[МОНЕТКА] Результат: ${Math.random() < 0.5 ? "Орел" : "Решка"}.`); return; 
        }
        
        if (text === "!рулетка" || text === "!roulette") { 
            if (Math.random() < 0.16) {
                sayToGame(`[РУЛЕТКА] Вы проиграли, ${author}.`);
                setTimeout(() => { try { client.game.Say(`/kill ${author}`); } catch(e) {} }, 500);
            } else {
                sayToGame(`[РУЛЕТКА] Удача! ${author} выжил и получает 10 очков.`);
                scores.set(author, (scores.get(author) || 0) + 10);
            }
            return; 
        }
        
        if (text.startsWith("!дуэль") || text.startsWith("!duel")) {
            const target = text.split(" ")[1];
            if (!target || target === author) { sayToGame(`Укажите игрока: !дуэль Ник`); return; }
            const bet = 10;
            if ((scores.get(author) || 0) < bet) { sayToGame(`${author}: Для дуэли требуется 10 очков. Ваш баланс: ${scores.get(author)||0}`); return; }
            const winner = Math.random() < 0.5 ? author : target;
            const loser = winner === author ? target : author;
            sayToGame(`[ДУЭЛЬ] ${author} вызывает ${target}! Ставка: 10 очков.`);
            setTimeout(() => {
                sayToGame(`[ДУЭЛЬ] Победитель: ${winner}. Очки переведены.`);
                scores.set(winner, (scores.get(winner) || 0) + bet);
                scores.set(loser, Math.max(0, (scores.get(loser) || 0) - bet));
            }, 2000);
            return;
        }
        
        if (text === "!слоты" || text === "!slots") {
            const emojis = ["[X]", "[O]", "[V]", "[!]", "[$]"]; 
            const s1 = emojis[Math.floor(Math.random() * emojis.length)];
            const s2 = emojis[Math.floor(Math.random() * emojis.length)];
            const s3 = emojis[Math.floor(Math.random() * emojis.length)];
            sayToGame(`[СЛОТЫ] ${author}: ${s1} | ${s2} | ${s3}`);
            if (s1 === s2 && s2 === s3) { sayToGame(`[ДЖЕКПОТ] Начислено 50 очков.`); scores.set(author, (scores.get(author) || 0) + 50); }
            else if (s1 === s2 || s2 === s3 || s1 === s3) { sayToGame(`[СЛОТЫ] Почти получилось! Начислено 5 очков.`); scores.set(author, (scores.get(author) || 0) + 5); }
            return;
        }

        // --- АДМИН КОМАНДЫ ---
        if (text.startsWith("!")) {
            
            // Проверка на админку
            if (text.startsWith("!admin") || text.startsWith("!clear") || text.startsWith("!vote") || text.startsWith("!votekick") || text.startsWith("!ignore") || text.startsWith("!unignore")) {
                if (!isAdmin(author)) { sayToGame(`${author}: У вас нет прав для этой команды.`); return; }
            }

            if (text === "!admin") { sayToGame(`Админ: !vote | !votekick | !ignore | !clear | !restart | !stop`); return; }
            
            if (text === "!clear") { sayToGame("Режим тишины активирован на 30 секунд."); aiEnabled = false; if (clearTimer) clearTimeout(clearTimer); clearTimer = setTimeout(() => { aiEnabled = true; clearTimer = null; }, 30000); return; }
            
            if (text.startsWith("!vote ")) { sayToGame(`/callvote ${text.slice(6).trim()}`); return; }
            if (text === "!vote") { sayToGame(`[ПОДСКАЗКА] Напишите текст. Пример: !vote Сменить карту`); return; }
            
            if (text.startsWith("!votekick ")) { sayToGame(`/callvote kick ${text.split(" ")[1]}`); return; }
            if (text === "!votekick") { sayToGame(`[ПОДСКАЗКА] Укажите ник. Пример: !votekick Ник`); return; }
            
            if (text.startsWith("!ignore ")) { manualIgnore.add(text.split(" ")[1]); sayToGame(`Игрок добавлен в черный список.`); return; }
            if (text === "!ignore") { sayToGame(`[ПОДСКАЗКА] Укажите ник. Пример: !ignore Ник`); return; }
            
            if (text.startsWith("!unignore ")) { manualIgnore.delete(text.split(" ")[1]); sayToGame(`Игрок удален из черного списка.`); return; }
            if (text === "!unignore") { sayToGame(`[ПОДСКАЗКА] Укажите ник. Пример: !unignore Ник`); return; }

            if (text.startsWith("!say ")) {
                const sayText = text.slice(5).trim();
                if (sayText) sayToGame(sayText);
                return;
            }
            if (text === "!say") { sayToGame(`[ПОДСКАЗКА] Напишите текст. Пример: !say Привет!`); return; }

            if (text === "!help" || text === "!помощь") { 
                if (Date.now() - lastHelpTime < 5000) return;
                lastHelpTime = Date.now();
                sayToGame(`Игры: !угадай | !бомба | !рулетка | !дуэль | !слоты | !монетка | !топ | !balance | Утилиты: !say | !calc | !roll | !time | !bot | Админ: !admin`);
                return; 
            }
            
            if (text === "!calc") { sayToGame(`[ПОДСКАЗКА] Напишите пример. Пример: !calc 2+2*2`); return; }
            if (text.startsWith("!calc ")) {
                const calc = tryCalculate(text.slice(6).trim());
                if (calc) { sayToGame(`${author}: ${calc.expr} = ${calc.result}`); return; }
                else { sayToGame(`[ОШИБКА] Не могу это посчитать. Пример: !calc 2+2`); return; }
            }
            if (text === "!roll") { sayToGame(`[КУБИК] Результат: ${Math.floor(Math.random() * 100) + 1}`); return; }
            if (text === "!time") { sayToGame(`[ВРЕМЯ] Сейчас: ${new Date().toLocaleTimeString('ru-RU')}`); return; }
            return;
        }

        // ИИ
        const lower = text.toLowerCase();
        const isMentioned = lower.includes(config.botNick.toLowerCase());
        const calc = tryCalculate(text);

        if (!isMentioned && !calc) return;

        if (calc) { sayToGame(`${author}: ${calc.expr} = ${calc.result}`); return; }
        if (checkFlood(author, text)) return;
        if (isProcessing) return;
        
        isProcessing = true;
        await processMessage(author, text);
        isProcessing = false;

    } catch(e) { isProcessing = false; console.error(e); }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log("Запуск настройки бота...");
rl.question("Введите IP:порт (например, 46.174.54.240:8303): ", (answer) => {
    if (answer && answer.includes(":")) {
        const parts = answer.split(":");
        config.host = parts[0].trim();
        config.port = parseInt(parts[1].trim()) || 8303;
    } else if (answer) { config.host = answer.trim(); }
    
    console.log(`\nПодключение к ${config.host}:${config.port}...`);
    console.log(`\x1b[33m[СИСТЕМА] Вы в консоли. Введите !help для меню.\x1b[0m\n`);
    
    startClient();
});

rl.on('line', async (line) => {
    if (!client || !client.game) return;
    const input = line.trim();
    if (!input) return;
    
    try {
        if (input.startsWith("!")) {
            await handleCommand("ConsoleAdmin", input);
        } 
        else if (input.startsWith("/")) {
            client.game.Say(input);
            console.log(`\x1b[32m[КОМАНДА]\x1b[0m Отправлено на сервер: ${input}`);
        } 
        else {
            client.game.Say(`${config.botNick}: ${input}`);
            console.log(`\x1b[32m[ЧАТ-БОТ]\x1b[0m Отправлено в чат: ${input}`);
        }
    } catch(e) {
        console.error("\x1b[31mОшибка отправки:\x1b[0m", e.message);
    }
});