const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Vô hiệu hóa cache trình duyệt để luôn tải mã mới nhất
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Quản lý dữ liệu lịch sử phiên cược từ cổng API thông thường
let currentSessionId = null;
let localCountdown = 50;
let snapshotted30 = false;
let snapshotted20 = false;
let frozenSnapshots = new Map();
let consecLosses = 0;
let currentPrediction = null;
let prevSessionRecord = null;
let lastTickTime = Date.now();
let lastActiveConfig = null;
let isRestarting = false;

// ===== CẤU HÌNH THÔNG BÁO & ĐIỀU KHIỂN VIA TELEGRAM =====
let telegramToken = process.env.TELEGRAM_TOKEN || '8440277821:AAF8UYv52S_7ZU1YJnvy3Ve8ZOU-T7UFcw0';
let telegramChatId = process.env.TELEGRAM_CHAT_ID || '8528261750';
let lastTelegramUpdateId = 0;

function sendTelegramMessage(text, customChatId = null, customToken = null) {
  const token = customToken || telegramToken;
  const chatId = customChatId || telegramChatId;
  if (!token || !chatId) return;

  try {
    const https = require('https');
    const data = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {});
    });

    req.on('error', (e) => {
      console.error('[Telegram API Error]', e.message);
    });

    req.write(data);
    req.end();
  } catch (e) {
    console.error('[Telegram Exception]', e.message);
  }
}

async function pollTelegramUpdates() {
  const token = telegramToken;
  if (!token) return;

  try {
    const https = require('https');
    const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastTelegramUpdateId + 1}&timeout=5`;
    
    https.get(url, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              lastTelegramUpdateId = update.update_id;
              if (update.message && update.message.text) {
                handleTelegramCommand(update.message);
              }
            }
          }
        } catch(e) {}
      });
    }).on('error', () => {});
  } catch(e) {}
}

async function handleTelegramCommand(msg) {
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();

  // Xử lý gửi mã Captcha trực tiếp từ Telegram nếu bot đang chờ Captcha
  if (botState.waitingCaptcha && captchaResolver && !cmd.startsWith('/')) {
    const code = text.trim();
    captchaResolver(code);
    sendTelegramMessage(`📥 Đã nhận mã Captcha: <b>${code}</b>. Đang gửi xác thực...`, chatId);
    return;
  }

  if (cmd === '/startbot' || cmd === '/config' || cmd === '/login') {
    if (botState.running || isStarting) {
      sendTelegramMessage(`⚠️ Bot đang trong trạng thái chạy hoặc đang khởi động!`, chatId);
      return;
    }

    // Nếu người dùng truyền tài khoản và mật khẩu trực tiếp: /startbot [user] [pass] [baseBet] [capital]
    if (parts.length >= 3) {
      const username = parts[1];
      const password = parts[2];
      const baseBet = parseFloat(parts[3]) || 1000;
      const capital = parseFloat(parts[4]) || 500000;
      const proxyServer = parts[5] || 'tJQmIDJXpAvfVWs0JSkTD1Drhfi5jULd';

      saveBotConfig({ username, password, baseBet, capital, proxyServer, proxyUser: '', proxyPass: '', telegramToken, telegramChatId });
      
      sendTelegramMessage(`🚀 Nhận thông tin đăng nhập từ Telegram! Đang khởi động bot cho tài khoản "<b>${username}</b>"...`, chatId);
      startPuppeteerBot(username, password, baseBet, capital, proxyServer, '', '')
        .catch(err => sendTelegramMessage(`❌ Lỗi khởi động: ${err.message}`, chatId));
      return;
    }

    // Nếu không truyền tài khoản, đọc từ bộ nhớ hoặc đĩa
    let cfgToRun = lastActiveConfig;
    if (!cfgToRun && fs.existsSync(BOT_CONFIG_PATH)) {
      try {
        cfgToRun = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf8'));
      } catch(e) {}
    }

    if (cfgToRun && cfgToRun.username && cfgToRun.password) {
      sendTelegramMessage(`🚀 Đang khởi động bot cho tài khoản đã lưu "<b>${cfgToRun.username}</b>"...`, chatId);
      startPuppeteerBot(
        cfgToRun.username,
        cfgToRun.password,
        cfgToRun.baseBet || 1000,
        cfgToRun.capital || 500000,
        cfgToRun.proxyServer || '',
        cfgToRun.proxyUser || '',
        cfgToRun.proxyPass || ''
      ).catch(err => sendTelegramMessage(`❌ Lỗi khởi động: ${err.message}`, chatId));
    } else {
      sendTelegramMessage(
        `<b>⚠️ CHƯA CÓ CẤU HÌNH TÀI KHOẢN!</b>\n\n` +
        `👉 Bạn có thể nhập tài khoản trực tiếp trên Telegram theo cú pháp:\n` +
        `<code>/startbot [Tài_Khoản] [Mật_Khẩu] [Cược_Gốc] [Vốn]</code>\n\n` +
        `<b>Ví dụ:</b>\n` +
        `<code>/startbot nguyennhan111 mypass123 10 500000</code>`,
        chatId
      );
    }
  } else if (cmd === '/captcha' || cmd === '/c') {
    if (!botState.waitingCaptcha || !captchaResolver) {
      sendTelegramMessage(`ℹ️ Hiện tại game không yêu cầu mã Captcha nào.`, chatId);
    } else if (parts.length >= 2) {
      const code = parts[1];
      captchaResolver(code);
      sendTelegramMessage(`📥 Đã nhận mã Captcha: <b>${code}</b>. Đang gửi xác thực...`, chatId);
    } else {
      sendTelegramMessage(`⚠️ Vui lòng nhập mã Captcha theo cú pháp: <code>/c [Mã_Captcha]</code>`, chatId);
    }
  } else if (cmd === '/stopbot') {
    if (!botState.running) {
      sendTelegramMessage(`ℹ️ Bot hiện tại đang dừng sẵn rồi.`, chatId);
    } else {
      sendTelegramMessage(`🛑 Nhận lệnh Telegram! Đang tiến hành tắt bot...`, chatId);
      await stopPuppeteerBot();
      sendTelegramMessage(`✅ <b>[ĐÃ TẮT BOT THÀNH CÔNG]</b>\nTrình duyệt ngầm đã được đóng hoàn toàn. Bot đã dừng toàn bộ hoạt động cược.`, chatId);
    }
  } else if (cmd === '/status') {
    const runningStr = botState.running ? "🟢 ĐANG CHẠY NGẦM 24/7" : "🔴 ĐANG DỪNG HOẠT ĐỘNG";
    const sessionStr = botState.currentSession ? `#${botState.currentSession}` : "Chờ dữ liệu...";
    const timerStr = botState.timerVal !== null ? `${botState.timerVal}s` : "--s";
    const predStr = botState.prediction || "---";
    const amountStr = (botState.amount || 0).toLocaleString() + "đ";
    const stageStr = `Tay ${botState.stage || 1}`;
    const profit = botState.profit || 0;
    const profitStr = (profit >= 0 ? "+" : "") + profit.toLocaleString() + "đ";

    const reply = `<b>📊 TRẠNG THÁI HỆ THỐNG</b>\n\n` +
      `• Trạng thái: <b>${runningStr}</b>\n` +
      `• Phiên hiện tại: <b>${sessionStr}</b> (${timerStr})\n` +
      `• Dự đoán: <b>${predStr}</b>\n` +
      `• Mức cược: <b>${amountStr}</b> (${stageStr})\n` +
      `• Tổng lợi nhuận: <b>${profitStr}</b>`;
    sendTelegramMessage(reply, chatId);
  } else if (cmd === '/history') {
    const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
    if (!fs.existsSync(filePath)) {
      sendTelegramMessage(`ℹ️ Chưa có dữ liệu lịch sử phiên nào.`, chatId);
      return;
    }
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      const records = lines.map(line => { try { return JSON.parse(line); } catch(e) { return null; } }).filter(Boolean);
      const recent = records.slice(-5).reverse();

      if (recent.length === 0) {
        sendTelegramMessage(`ℹ️ Chưa có dữ liệu lịch sử phiên nào.`, chatId);
        return;
      }

      let historyText = `<b>📜 LỊCH SỬ 5 PHIÊN GẦN NHẤT:</b>\n\n`;
      for (const r of recent) {
        const pred = r.du_doan || "---";
        const result = r.ket_qua || "---";
        const win = pred === result ? "✅ THẮNG" : (pred !== "---" && result !== "---" ? "❌ THUA" : "➖");
        historyText += `• <b>#${r.phien}</b>: Ra <b>${result}</b> (${r.xuc_xac || ''} = ${r.tong_diem || ''}đ) | Dự đoán: <b>${pred}</b> -> ${win}\n`;
      }
      sendTelegramMessage(historyText, chatId);
    } catch(e) {
      sendTelegramMessage(`❌ Lỗi đọc lịch sử: ${e.message}`, chatId);
    }
  } else if (cmd === '/algo' || cmd === '/debug') {
    const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
    let historyList = [];
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf8');
        const lines = data.trim().split('\n').filter(Boolean);
        const records = lines.map(line => { try { return JSON.parse(line); } catch(e) { return null; } }).filter(Boolean);
        historyList = records.map(r => r.ket_qua === 'Tài' ? 'T' : 'X');
      } catch(e) {}
    }

    const info = analyzeToolMrTin8PP(historyList);
    let text = `<b>🔬 CHI TIẾT THUẬT TOÁN 8 PHƯƠNG PHÁP</b>\n\n` +
      `• Tổng lịch sử nạp: <b>${info.historyCount} phiên</b>\n` +
      `• Bầu chọn: <b>Tài (${info.votes.Tai}/8)</b> vs <b>Xỉu (${info.votes.Xiu}/8)</b>\n` +
      `• Độ tin cậy: <b>${info.confidence}</b>\n` +
      `🎯 <b>DỰ ĐOÁN CUỐI: ${info.prediction.toUpperCase()}</b>\n\n` +
      `<b>Chi tiết từng phương pháp:</b>\n`;

    for (let i = 0; i < info.details.length; i++) {
      const d = info.details[i];
      const icon = d.prediction === info.prediction ? "✅" : "❌";
      text += `${i + 1}. <b>${d.name}</b>: ${d.prediction} ${icon}\n`;
    }

    sendTelegramMessage(text, chatId);
  } else if (cmd === '/start' || cmd === '/help') {
    const reply = `<b>🤖 BOT DỰ ĐOÁN TÀI XỈU SUNWIN</b>\n\n` +
      `<b>Danh sách lệnh hỗ trợ:</b>\n` +
      `🔹 <code>/startbot [User] [Pass] [Cược] [Vốn]</code> - Bật bot (Nhập nick hoặc dùng nick đã lưu)\n` +
      `🔹 /stopbot - Dừng hoạt động bot cược\n` +
      `🔹 /status - Xem trạng thái bot, phiên cược & lợi nhuận\n` +
      `🔹 /algo - Xem chi tiết phân tích 8 phương pháp ToolMrTin\n` +
      `🔹 /history - Xem lịch sử 5 phiên gần nhất\n` +
      `🔹 <code>/c [Mã_Captcha]</code> - Gửi mã Captcha khi game yêu cầu\n` +
      `🔹 /help - Hiển thị hướng dẫn này`;
    sendTelegramMessage(reply, chatId);
  }
}

setInterval(pollTelegramUpdates, 3000);

// === THUẬT TOÁN TOOLMRTIN - 8 PHƯƠNG PHÁP CHÍNH XÁC THEO SMALI ===
function analyzeToolMrTin8PP(history) {
  const n = history.length;

  function k_fallback() {
    if (n === 0) return Math.random() < 0.5 ? "T" : "X";
    let t_cnt = 0;
    for (let i = 0; i < n; i++) { if (history[i] === "T") t_cnt++; }
    const x_cnt = n - t_cnt;
    if (t_cnt > x_cnt) return "T";
    if (x_cnt > t_cnt) return "X";
    return Math.random() < 0.5 ? "T" : "X";
  }

  function method_b() {
    if (n < 5) return k_fallback();
    const last = history[n - 1];
    let cnt_same = 0, cnt_T = 0;
    for (let i = 0; i < n - 1; i++) {
      if (history[i] === last) {
        cnt_same++;
        if (history[i + 1] === "T") cnt_T++;
      }
    }
    let prob = cnt_same > 0 ? cnt_T / cnt_same : 0.5;
    if (n >= 3) {
      const prev = history[n - 2];
      let match = 0, t_after = 0;
      for (let i = 0; i < n - 2; i++) {
        if (history[i] === prev && history[i + 1] === last) {
          match++;
          if (history[i + 2] === "T") t_after++;
        }
      }
      if (match >= 3) {
        const prob2 = t_after / match;
        prob = (prob + prob2) / 2.0;
      }
    }
    return prob >= 0.5 ? "T" : "X";
  }

  function method_c() {
    if (n < 8) return k_fallback();
    for (let gap = 2; gap <= 6; gap++) {
      const windowLen = Math.min(gap * 3, n);
      let matches = 0;
      for (let i = n - 1; i >= n - windowLen; i--) {
        if (i >= gap && history[i] === history[i - gap]) {
          matches++;
        }
      }
      const ratio = matches / windowLen;
      if (ratio >= 0.7) {
        const idx = ((n - 1) % gap) - gap + 1;
        if (idx >= 0 && idx < n) {
          return history[idx];
        }
      }
    }
    return k_fallback();
  }

  function method_d() {
    if (n < 5) return k_fallback();
    if (n >= 12) {
      const steps = [1, 1, 2, 3, 5];
      let pos = n - 1;
      let ok = true;
      for (let s = 0; s < steps.length; s++) {
        const step = steps[s];
        if (pos - step + 1 < 0) { ok = false; break; }
        const val = history[pos];
        for (let j = 0; j < step; j++) {
          if (history[pos - j] !== val) { ok = false; break; }
        }
        if (!ok) break;
        pos -= step;
      }
      if (ok) {
        return history[n - 1] === "T" ? "X" : "T";
      }
    }
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (history[i] === history[n - 1]) streak++;
      else break;
    }
    if ([2, 3, 5, 8].includes(streak)) {
      return history[n - 1] === "T" ? "X" : "T";
    }
    return k_fallback();
  }

  function method_e() {
    if (n < 4) return k_fallback();
    let tt = 0, tx = 0, xt = 0, xx = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = history[i], b = history[i + 1];
      if (a === "T" && b === "T") tt++;
      else if (a === "T" && b === "X") tx++;
      else if (a === "X" && b === "T") xt++;
      else if (a === "X" && b === "X") xx++;
    }
    if (history[n - 1] === "T") {
      return tt >= tx ? "T" : "X";
    } else {
      return xt >= xx ? "T" : "X";
    }
  }

  function method_f() {
    if (n < 6) return k_fallback();
    const windowLen = Math.min(6, n);
    const mid = n - windowLen;
    const prev_cnt = Math.min(6, mid);
    let t1 = 0, t2 = 0;
    for (let i = mid; i < n; i++) { if (history[i] === "T") t1++; }
    for (let i = mid - prev_cnt; i < mid; i++) { if (i >= 0 && history[i] === "T") t2++; }
    const r1 = t1 / windowLen;
    const r2 = prev_cnt > 0 ? t2 / prev_cnt : 0.5;
    const diff = r1 - r2;
    if (diff > 0.3) return "T";
    if (diff < -0.3) return "X";
    if (r1 > 0.6) return "X";
    if (r1 < 0.4) return "T";
    return k_fallback();
  }

  function method_g() {
    if (n < 6) return k_fallback();
    const a = history[n - 1], b = history[n - 2], c = history[n - 3], d = history[n - 4];
    if (a !== b && b !== c && c !== d) return a === "T" ? "X" : "T";
    if (a === b && b !== c && c === d) return a === "T" ? "X" : "T";
    if (a === b && b === c) return a === "T" ? "X" : "T";
    return k_fallback();
  }

  function method_h() {
    if (n === 0) return Math.random() < 0.5 ? "T" : "X";
    let streak = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (history[i] === history[n - 1]) streak++;
      else break;
    }
    if (streak >= 3) return history[n - 1] === "T" ? "X" : "T";
    return k_fallback();
  }

  function method_i() {
    if (n === 0) return "T";
    let t_w = 0.0, x_w = 0.0;
    for (let i = 0; i < n; i++) {
      const w = Math.pow(1.15, i);
      if (history[i] === "T") t_w += w;
      else x_w += w;
    }
    return t_w >= x_w ? "T" : "X";
  }

  const methods = [
    { name: "PP7-Streak", res: method_h() },
    { name: "PP6-Luat", res: method_g() },
    { name: "PP8-ExpW", res: method_i() },
    { name: "PP4-Markov", res: method_e() },
    { name: "PP3-Fibo", res: method_d() },
    { name: "PP2-ChuKy", res: method_c() },
    { name: "PP5-2Nua", res: method_f() },
    { name: "PP1-XS-DK", res: method_b() }
  ];

  let sT = 0.0, sX = 0.0;
  for (const m of methods) {
    if (m.res === "T") sT += 1.0;
    else sX += 1.0;
  }
  const winner = sT >= sX ? "Tài" : "Xỉu";
  const confidence = (Math.max(sT, sX) / (sT + sX || 1) * 100).toFixed(1);

  return {
    prediction: winner,
    confidence: confidence + "%",
    historyCount: n,
    votes: { Tai: sT, Xiu: sX },
    details: methods.map(m => ({ name: m.name, prediction: m.res === "T" ? "Tài" : "Xỉu" }))
  };
}

function predictToolMrTin8PP(history) {
  const analysis = analyzeToolMrTin8PP(history || []);
  return analysis.prediction;
}

function getEnsemblePrediction(historyList) {
  return predictToolMrTin8PP(historyList || []);
}

function loadHistoryAndSync() {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  if (!fs.existsSync(filePath)) return;
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    const records = lines.map(line => JSON.parse(line));
    if (records.length === 0) return;

    let prev = null;
    let tempLosses = 0;
    for (let i = 0; i < records.length; i++) {
      const curr = records[i];
      if (curr.snap_30 || curr.snap_20) {
        const pred = getEnsemblePrediction(curr, prev, tempLosses);
        if (curr.ket_qua && curr.ket_qua !== '---') {
          if (pred === curr.ket_qua) {
            tempLosses = 0;
          } else {
            tempLosses++;
          }
        }
      }
      prev = curr;
    }
    consecLosses = tempLosses;
    prevSessionRecord = records[records.length - 1];
    console.log(`[🔋 Khởi động] Đồng bộ dữ liệu thành công. ConsecLosses: ${consecLosses}`);
  } catch (e) {
    console.error('Lỗi đồng bộ lịch sử khởi động:', e.message);
  }
}

function saveCompletedRecord(record) {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  let records = [];
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      records = lines.map(line => {
        try { return JSON.parse(line); } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) {
      console.error('[❌] Lỗi đọc file lịch sử:', e.message);
    }
  }
  records = records.filter(r => parseInt(r.phien) !== parseInt(record.phien));
  records.push(record);
  try {
    const output = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.writeFileSync(filePath, output, 'utf8');
  } catch (err) {
    console.error('[❌] Lỗi ghi file lịch sử:', err.message);
  }
}

// ======================== API BOT DÀNH CHO ĐIỆN THOẠI ========================
let activeBrowser = null;
let activePage = null;
let isStarting = false;

let captchaResolver = null;
let captchaRejecter = null;

let botState = {
  running: false,
  waitingCaptcha: false,
  currentSession: "---",
  timerVal: null,
  prediction: "---",
  amount: 0,
  stage: 1,
  profit: 0,
  logs: []
};

// ===== TỰ ĐỘNG PHỤC HỒI SAU KHI RAILWAY RESTART =====
const BOT_CONFIG_PATH = process.env.DATA_PATH
  ? process.env.DATA_PATH.replace('taixiu_data_history.json', 'bot_config.json')
  : path.join(__dirname, 'bot_config.json');

function saveBotConfig(cfg) {
  try { fs.writeFileSync(BOT_CONFIG_PATH, JSON.stringify(cfg)); } catch(e) {}
}

function clearBotConfig() {
  try { if (fs.existsSync(BOT_CONFIG_PATH)) fs.unlinkSync(BOT_CONFIG_PATH); } catch(e) {}
}

async function autoRestartBot() {
  try {
    if (!fs.existsSync(BOT_CONFIG_PATH)) return;
    const cfg = JSON.parse(fs.readFileSync(BOT_CONFIG_PATH, 'utf8'));
    if (!cfg || !cfg.username || !cfg.password) return;
    
    // Tự động chuyển đổi sang Proxy API Key mới nếu phát hiện key cũ
    if (cfg.proxyServer === 'uYgNEoVcjzsCBzznJdw8HzVZr5FCnIvm') {
      cfg.proxyServer = 'tJQmIDJXpAvfVWs0JSkTD1Drhfi5jULd';
      saveBotConfig(cfg); // lưu đè lại cấu hình mới
    }
    
    console.log(`[🔄 AUTO-RESTART] Phát hiện cấu hình cũ, tự động khởi động lại bot cho tài khoản: "${cfg.username}"`);
    await new Promise(r => setTimeout(r, 3000)); // chờ server sẵn sàng
    startPuppeteerBot(cfg.username, cfg.password, cfg.baseBet || 1000, cfg.capital || 500000, cfg.proxyServer || '', cfg.proxyUser || '', cfg.proxyPass || '')
      .catch(err => console.log(`[AUTO-RESTART LỖI] ${err.message}`));
  } catch(e) {
    console.log(`[AUTO-RESTART] Không đọc được cấu hình cũ: ${e.message}`);
  }
}

function addServerLog(msg) {
  const time = new Date().toLocaleTimeString();
  const formatted = `[${time}] ${msg}`;
  console.log(formatted);
  botState.logs.push(formatted);
  if (botState.logs.length > 40) botState.logs.shift();

  if (msg.includes('Dự đoán phiên #')) {
    sendTelegramMessage(`🎯 <b>[DỰ ĐOÁN PHIÊN MỚI]</b>\n${msg}`);
  } else if (msg.includes('thành công!') && msg.includes('Đặt cược')) {
    sendTelegramMessage(`✅ <b>[XÁC NHẬN CƯỢC]</b>\n${msg}`);
  } else if (msg.includes('CẢNH BÁO') || msg.includes('WEBGL CRASH') || msg.includes('PAGE CRASHED')) {
    sendTelegramMessage(`⚠️ <b>[CẢNH BÁO HỆ THỐNG]</b>\n${msg}`);
  }
}

async function handleBotCrash() {
  if (isRestarting) return;
  isRestarting = true;
  try {
    addServerLog(`🔄 Đang dọn dẹp Chromium bị lỗi và tự động phục hồi...`);
    await stopPuppeteerBot();
    await new Promise(r => setTimeout(r, 8000)); // Chờ 8 giây giải phóng RAM
    if (lastActiveConfig) {
      addServerLog(`🚀 Tiến hành khởi chạy lại bot...`);
      await startPuppeteerBot(
        lastActiveConfig.username,
        lastActiveConfig.password,
        lastActiveConfig.baseBet,
        lastActiveConfig.capital,
        lastActiveConfig.proxyServer,
        lastActiveConfig.proxyUser,
        lastActiveConfig.proxyPass
      );
    }
  } catch(e) {
    addServerLog(`❌ Lỗi phục hồi bot: ${e.message}`);
  } finally {
    isRestarting = false;
  }
}

async function resolveTinProxy(apiKey) {
  const get = (url) => new Promise((resolve) => {
    const https = require('https');
    console.log(`[TinProxy Request] GET ${url}`);
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ error: e.message, raw: data }); }
      });
    }).on('error', (err) => resolve({ error: err.message }));
  });

  // TinProxy trả về code:1 khi thành công (không phải success:true)
  let res = await get(`https://api.tinproxy.com/proxy/get-current-proxy?api_key=${apiKey}`);
  addServerLog(`[TinProxy API Response] ${JSON.stringify(res).substring(0, 300)}`);

  if (res && res.code === 1 && res.data) {
    // Sử dụng HTTP proxy vì Chromium hỗ trợ xác thực username/password tốt hơn SOCKS5
    const http = res.data.http_ipv4 || res.data.proxy || res.data.socks_ipv4;
    const auth = res.data.authentication || {};
    if (http) {
      return {
        proxy: http,
        username: auth.username || "",
        password: auth.password || ""
      };
    }
  }

  addServerLog(`[TinProxy] Lỗi hoặc định dạng không nhận diện được: code=${res && res.code}, message=${res && res.message}`);
  return null;
}

async function checkProxyWorking(proxyStr) {
  return new Promise((resolve) => {
    const http = require('http');
    const [host, port] = proxyStr.split(':');
    const req = http.request({
      host,
      port: parseInt(port),
      path: 'http://web.sunwin.best/',
      method: 'CONNECT',
      timeout: 4000
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function getFreeVNProxy() {
  const get = (url) => new Promise((resolve) => {
    const https = require('https');
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(''));
  });

  try {
    const rawData = await get('https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=VN&ssl=all&anonymity=all');
    const lines = rawData.trim().split(/\r?\n/).filter(line => line.includes(':'));
    for (const p of lines.slice(0, 10)) {
      const proxy = p.trim();
      const ok = await checkProxyWorking(proxy);
      if (ok) return proxy;
    }
  } catch(e) {}
  return null;
}

async function startPuppeteerBot(username, password, baseBet, capital, proxyServer, proxyUser, proxyPass) {
  lastActiveConfig = { username, password, baseBet, capital, proxyServer, proxyUser, proxyPass };

  if (activeBrowser) {
    await stopPuppeteerBot();
  }

  botState.running = true;
  botState.logs = [];
  addServerLog("🚀 Khởi động trình duyệt ảo Chromium ngầm...");

  try {
    let finalProxy = proxyServer ? proxyServer.trim() : "";
    let finalProxyUser = proxyUser || "";
    let finalProxyPass = proxyPass || "";

    // Tự động nhận diện TinProxy API Key
    if (finalProxy && !finalProxy.includes(':') && finalProxy.length > 25) {
      addServerLog("🔑 Phát hiện mã TinProxy API Key. Đang tự động kết nối lấy IP...");
      const resolved = await resolveTinProxy(finalProxy);
      if (resolved) {
        addServerLog(`✅ TinProxy cấp địa chỉ: "${resolved.proxy}" | User: "${resolved.username}"`);
        finalProxy = resolved.proxy;
        if (resolved.username) finalProxyUser = resolved.username;
        if (resolved.password) finalProxyPass = resolved.password;
        
        // Chờ 10 giây để TinProxy đồng bộ IP của máy chủ
        addServerLog("⏳ Chờ 10 giây để TinProxy đồng bộ IP của máy chủ...");
        await new Promise(r => setTimeout(r, 10000));
      } else {
        addServerLog("⚠️ Proxy TinProxy hết hạn. Đang quét danh sách Proxy Việt Nam miễn phí sống...");
        const freeVN = await getFreeVNProxy();
        if (freeVN) {
          addServerLog(`✅ Đã chọn Proxy VN sống: "${freeVN}"`);
          finalProxy = freeVN;
          finalProxyUser = "";
          finalProxyPass = "";
        } else {
          addServerLog("⚠️ Không tìm thấy Proxy VN miễn phí hoạt động. Tự động kết nối trực tiếp (Direct Connection)...");
          finalProxy = "";
          finalProxyUser = "";
          finalProxyPass = "";
        }
      }
    }

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,720',
      '--disable-service-workers',
      '--disable-features=ServiceWorker,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessChecks,PrivateNetworkAccessRespectPreflight',
      '--disable-web-security',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--disable-gpu-program-cache',
      '--disable-gpu-shader-disk-cache',
      '--proxy-bypass-list=raw.githubusercontent.com,githubusercontent.com',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-ipc-flooding-protection'
    ];

    if (finalProxy) {
      addServerLog(`🌐 Sử dụng Proxy kết nối: "${finalProxy}"`);
      launchArgs.push(`--proxy-server=${finalProxy}`);
    }

    activeBrowser = await puppeteer.launch({
      headless: true,
      args: launchArgs
    });

    activeBrowser.on('disconnected', () => {
      if (botState.running && !isRestarting) {
        addServerLog("⚠️ Trình duyệt ảo bị ngắt kết nối hoặc đóng bất ngờ. Đang khôi phục tự động...");
        handleBotCrash();
      }
    });

    activePage = await activeBrowser.newPage();

    activePage.on('error', err => {
      addServerLog(`⚠️ [PAGE CRASHED/OOM] Trình duyệt bị sập hoặc hết RAM: ${err.message}. Đang khôi phục tự động...`);
      handleBotCrash();
    });

    await activePage.setViewport({ width: 1280, height: 720 });

    if (finalProxy && finalProxyUser && finalProxyPass) {
      addServerLog(`🔐 Thực hiện xác thực Proxy: User = "${finalProxyUser}"`);
      await activePage.authenticate({
        username: finalProxyUser,
        password: finalProxyPass
      });
    }

    // Đăng ký bắt lỗi console từ trình duyệt ảo
    activePage.on('console', async msg => {
      try {
        const textParts = [];
        for (const arg of msg.args()) {
          try {
            const val = await arg.jsonValue();
            if (val instanceof Error) {
              textParts.push(val.stack || val.message);
            } else if (typeof val === 'object' && val !== null) {
              textParts.push(JSON.stringify(val));
            } else {
              textParts.push(String(val));
            }
          } catch (e) {
            textParts.push(arg.toString()); // Fallback JSHandle
          }
        }
        const text = textParts.length > 0 ? textParts.join(' ') : msg.text();
        addServerLog(`[BROWSER CONSOLE] ${text}`);

        if (text.includes('loseContext') || text.includes('context lost') || text.includes('CONTEXT_LOST_WEBGL')) {
          addServerLog("⚠️ [WEBGL CRASH] Phát hiện lỗi sập luồng đồ họa WebGL trong game. Tiến hành hồi sinh bot...");
          handleBotCrash();
        }
      } catch (e) {
        const text = msg.text();
        addServerLog(`[BROWSER CONSOLE] ${text}`);
        if (text.includes('loseContext') || text.includes('context lost') || text.includes('CONTEXT_LOST_WEBGL')) {
          addServerLog("⚠️ [WEBGL CRASH] Phát hiện lỗi sập luồng đồ họa WebGL trong game. Tiến hành hồi sinh bot...");
          handleBotCrash();
        }
      }
    });
    activePage.on('pageerror', err => {
      addServerLog(`[BROWSER ERROR] ${err.stack || err.toString()}`);
    });
    activePage.on('requestfailed', request => {
      addServerLog(`❌ [REQUEST FAILED] ${request.url()} - ${request.failure()?.errorText || 'Unknown error'}`);
    });
    activePage.on('response', response => {
      try {
        const url = response.url();
        const status = response.status();
        if (url.includes('staticmt.net') || url.includes('.bin') || url.includes('.png') || url.includes('.json') || url.includes('distributor') || url.includes('configs')) {
          const length = response.headers()['content-length'] || 'unknown';
          const cache = response.fromCache() ? ' (from cache)' : '';
          addServerLog(`📥 [RESPONSE] ${url.substring(0, 90)}... - Status: ${status} - Size: ${length}${cache}`);
        }
      } catch (e) {}
    });

    // ===== CDP-LEVEL NETWORK INTERCEPTION (chặn cả Service Worker requests) =====
    const cdpSession = await activePage.target().createCDPSession();
    
    // Bắt buộc Chromium bypass Service Worker ở tầng Network Protocol
    try {
      await cdpSession.send('Network.enable');
      await cdpSession.send('Network.setBypassServiceWorker', { bypass: true });
      addServerLog("🔧 [CDP] Đã kích hoạt bypass Service Worker thành công.");
    } catch (e) {
      addServerLog(`⚠️ [CDP] Cảnh báo không thể set bypass Service Worker: ${e.message}`);
    }

    // Đọc config thật từ file local, gán thêm tracking_url: ""
    let localConfigObj = {};
    try {
      const rawLocal = fs.readFileSync(path.join(__dirname, 'real_config.json'), 'utf8');
      localConfigObj = JSON.parse(rawLocal);
      localConfigObj.tracking_url = "";
    } catch (err) {
      addServerLog(`❌ Lỗi đọc real_config.json: ${err.message}`);
    }
    const MOCK_CONFIG = JSON.stringify(localConfigObj);

    const CONFIG_PATTERNS = [
      { urlPattern: '*gitlab*' },
      { urlPattern: '*swebv363*' },
      { urlPattern: '*configs5533647*' },
      { urlPattern: '*configs-v363*' },
      { urlPattern: '*all-in-one-363*' },
      { urlPattern: '*dev-yon*' },
      { urlPattern: '*web_s_config*' }
    ];
    await cdpSession.send('Fetch.enable', { patterns: CONFIG_PATTERNS });
    cdpSession.on('Fetch.requestPaused', async ({ requestId, request }) => {
      try {
        const b64 = Buffer.from(MOCK_CONFIG).toString('base64');
        await cdpSession.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Headers', value: '*' }
          ],
          body: b64
        });
        addServerLog(`🔧 [CDP] Đã mock config request: ${request.url.substring(0, 80)}...`);
      } catch (e) {
        try { await cdpSession.send('Fetch.continueRequest', { requestId }); } catch(e2) {}
      }
    });

    // ===== TRIPLE-LAYER JS DEFENSE AGAINST NULL CONFIG =====
    await activePage.evaluateOnNewDocument((mockConfigStr) => {
      const MOCK = JSON.parse(mockConfigStr);
      const CONFIG_URL_KEYWORDS = ['swebv363', 'gitlab', 'configs5533647', 'all-in-one-363', 'dev-yon', 'web_s_config'];
      const isConfigUrl = (url) => {
        const s = typeof url === 'string' ? url : (url && url.url) || '';
        return CONFIG_URL_KEYWORDS.some(k => s.includes(k));
      };

      // Layer 1: Block SW registration completely
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
        navigator.serviceWorker.register = function(scriptURL, options) {
          console.log('[BOT] Blocked SW registration:', scriptURL);
          return Promise.resolve({ scope: options?.scope || '/', unregister: () => Promise.resolve(true), update: () => Promise.resolve(), addEventListener: () => {}, removeEventListener: () => {} });
        };
      }

      // Layer 2: Patch Response.prototype.json — intercepts the response parsing stage
      // This works REGARDLESS of whether fetch goes through SW, CDP, or direct network
      const origResponseJson = Response.prototype.json;
      Response.prototype.json = function() {
        const responseUrl = this.url || '';
        return origResponseJson.call(this).then(data => {
          if (data === null || data === undefined) {
            if (isConfigUrl(responseUrl)) {
              console.log('[BOT] Response.json() returned null for config URL, replacing with mock. URL:', responseUrl);
              return MOCK;
            }
          }
          return data;
        }).catch(err => {
          if (isConfigUrl(responseUrl)) {
            console.log('[BOT] Response.json() threw error for config URL, returning mock. URL:', responseUrl);
            return MOCK;
          }
          throw err;
        });
      };

      // Layer 3: Patch window.fetch as tertiary fallback
      const origFetch = window.fetch;
      window.fetch = function(url, opts) {
        const urlStr = typeof url === 'string' ? url : (url && url.url) || '';
        if (isConfigUrl(urlStr)) {
          console.log('[BOT MOCK FETCH] Intercepted config URL:', urlStr);
          return Promise.resolve(new Response(JSON.stringify(MOCK), {
            status: 200,
            url: urlStr,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          }));
        }
        return origFetch.apply(this, arguments);
      };

      // Layer 4: Backstop JSON.parse — if null sneaks through, replace it
      const origJSONParse = JSON.parse;
      JSON.parse = function(text, ...args) {
        const result = origJSONParse(text, ...args);
        if (result === null && typeof text === 'string' && text.trim() === 'null') {
          // Only replace top-level nulls during scene initialization window
          if (window.__botConfigInterceptActive) {
            console.log('[BOT] JSON.parse got literal null, returning mock config');
            return MOCK;
          }
        }
        return result;
      };
      // Layer 5: Presave and Intercept localStorage for 'S_GAME_CONFIG'
      try {
        localStorage.setItem('S_GAME_CONFIG', mockConfigStr);
      } catch(e) {}
      
      const origGetItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function(key) {
        const val = origGetItem.apply(this, arguments);
        if (key === 'S_GAME_CONFIG') {
          if (!val || val === 'null' || val === 'undefined') {
            console.log('[BOT] Intercepted localStorage.getItem for S_GAME_CONFIG returning null, supplying mock instead.');
            return mockConfigStr;
          }
        }
        return val;
      };

      // Activate interception from page start until scene is fully loaded
      window.__botConfigInterceptActive = true;

    }, MOCK_CONFIG);

    addServerLog("🔧 CDP + JS fetch patch đã cài đặt. Mock config GitLab sẵn sàng.");
    addServerLog("🧭 Đang truy cập trang chủ game Sunwin...");
    let loaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await activePage.goto('https://web.sunwin.best/?affId=Sunwin', { waitUntil: 'domcontentloaded', timeout: 60000 });
        loaded = true;
        break;

      } catch (e) {
        addServerLog(`⚠️ Thử truy cập lần ${attempt} thất bại: ${e.message}`);
        if (attempt < 3) {
          addServerLog("⏳ Chờ 3 giây trước khi thử kết nối lại...");
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw e;
        }
      }
    }

    addServerLog(`🔗 Địa chỉ thực tế của trang: ${activePage.url()}`);

    addServerLog("🔍 Đang kiểm tra giao diện trang chủ...");
    const buttonSelector = await activePage.evaluate(() => {
      const elList = Array.from(document.querySelectorAll('a, button, div, span'));
      console.log(`[BOT] Tìm thấy ${elList.length} phần tử HTML trên landing page.`);
      const targetBtn = elList.find(el => {
        const txt = el.textContent.trim().toLowerCase();
        return txt.includes('chơi nhanh bản web') || txt.includes('bản web') || txt.includes('chơi trên web') || txt.includes('web game') || txt.includes('vào game');
      });
      if (targetBtn) {
        console.log(`[BOT] Phát hiện nút chuyển game: "${targetBtn.textContent.trim()}". Gán ID click...`);
        targetBtn.id = 'bot-landing-btn';
        return '#bot-landing-btn';
      }
      return null;
    });

    if (buttonSelector) {
      addServerLog("🎯 Tiến hành click chuột thật (Puppeteer native click)...");
      await activePage.click(buttonSelector);
      // Chờ 1s và click dự phòng lại lần nữa nếu cần
      await new Promise(r => setTimeout(r, 1000));
      try { await activePage.click(buttonSelector); } catch(e) {}
    } else {
      addServerLog("⚠️ Không tìm thấy nút chuyển game ngoài Landing page.");
    }

    addServerLog("⏳ Đang chờ hệ thống game tải (Cocos Creator Engine)...");
    let ccReady = false;
    let activeFrame = activePage;
    for (let i = 0; i < 60; i++) {
      const allFrames = activePage.frames();
      if (i % 10 === 0) {
        addServerLog(`ℹ️ [Chu kỳ ${i}] Tổng số frames đang chạy trong trang: ${allFrames.length}`);
        allFrames.forEach((f, idx) => {
          addServerLog(`   - Frame ${idx + 1}: URL = "${f.url()}"`);
        });
      }
      
      for (const frame of allFrames) {
        const checkRes = await frame.evaluate(() => {
          try {
            return {
              hasCC: !!(window.cc),
              hasScene: !!(window.cc && cc.director && cc.director.getScene()),
              url: window.location.href
            };
          } catch(e) {
            return { hasCC: false, hasScene: false, error: e.message };
          }
        });
        
        if (checkRes.hasCC) {
          addServerLog(`🎯 Phát hiện window.cc trong frame: "${checkRes.url}". Có scene: ${checkRes.hasScene}`);
          if (checkRes.hasScene) {
            ccReady = true;
            activeFrame = frame;
            break;
          }
        }
      }
      if (ccReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ccReady) {
      const pubDir = path.join(__dirname, 'public');
      if (!fs.existsSync(pubDir)) {
        fs.mkdirSync(pubDir, { recursive: true });
      }
      const screenshotPath = path.join(pubDir, 'error_screen.png');
      await activePage.screenshot({ path: screenshotPath });
      addServerLog(`📸 Đã chụp màn hình lỗi lưu vào thư mục public/error_screen.png`);
      throw new Error("Không thể tải engine game. Vui lòng kiểm tra lại đường truyền.");
    }
    addServerLog(`🎮 Đã tìm thấy Engine Cocos tại Frame: "${activeFrame === activePage ? 'Trang chính' : activeFrame.url()}"`);

    // Bước trung gian: Click vào nút game trong landing page Cocos để vào sảnh thật
    addServerLog("🎯 Đang click vào biểu tượng game để vào sảnh chính...");
    const landingClickResult = await activeFrame.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        if (!scene) return "Không tìm thấy scene";
        
        const forceClick = (node) => {
          if (!node) return;
          try { node.emit('click', node); } catch(e) {}
          try { node.emit(cc.Node.EventType.TOUCH_START); node.emit(cc.Node.EventType.TOUCH_END); } catch(e) {}
          const comps = node._components || node.components || [];
          for (const c of comps) {
            if (c && c.clickEvents && c.clickEvents.length > 0) {
              try { cc.Component.EventHandler.emitEvents(c.clickEvents, {}); } catch(e) {}
            }
          }
          for (const child of (node.children || [])) forceClick(child);
        };

        // Tìm nút game: ico-game-pack hoặc bất kỳ node con đang active của Canvas
        const findEntryBtn = (root) => {
          const search = (node) => {
            if (!node) return null;
            const nameLower = (node.name || '').toLowerCase();
            if (nameLower.includes('game') || nameLower.includes('ico') || nameLower.includes('play') || nameLower.includes('enter')) {
              return node;
            }
            for (const child of (node.children || [])) {
              const r = search(child);
              if (r) return r;
            }
            return null;
          };
          return search(root);
        };
        
        const btn = findEntryBtn(scene);
        if (btn) {
          forceClick(btn);
          return `Đã click node "${btn.name}" để vào sảnh game`;
        }
        // Fallback: click tất cả children của Canvas
        for (const child of (scene.children || [])) forceClick(child);
        return `Đã click tất cả ${scene.children.length} node con của Canvas`;
      } catch(e) {
        return "Lỗi: " + e.message;
      }
    });
    addServerLog(`🎯 Kết quả click Landing: ${landingClickResult}`);

    // Chờ sảnh game thật load (có btn_login)
    addServerLog("⏳ Đang chờ sảnh game thật load sau khi click (tối đa 20s)...");
    await new Promise(r => setTimeout(r, 3000));

    addServerLog("🔑 Đang tìm nút Đăng nhập trên Header (chờ tối đa 90s)...");
    let btnHeaderFound = false;
    for (let attempt = 1; attempt <= 90; attempt++) {
      if (attempt % 10 === 0) {
        addServerLog(`⏳ Vẫn đang chờ sảnh game tải tài nguyên (giây thứ ${attempt}/90)...`);
      }
      const headerClickResult = await activeFrame.evaluate(() => {
        try {
          const scene = cc.director.getScene();
          if (!scene) return { success: false, msg: "Không tìm thấy scene" };
          
          const findHeaderLoginBtn = (root) => {
            const found = [];
            const search = (node) => {
              if (!node) return;
              const nameLower = (node.name || "").toLowerCase();
              if (nameLower === "btn_login" || nameLower === "btn_dangnhap" || nameLower === "login_btn") {
                found.push(node);
              }
              for (const child of (node.children || [])) search(child);
            };
            search(root);
            
            // Ưu tiên nút đang active trong hierarchy
            const activeBtn = found.find(n => {
              let curr = n;
              while(curr) {
                if (curr.active === false) return false;
                curr = curr.parent;
              }
              return true;
            });
            return activeBtn || found[0];
          };

          const forceClickCocosNode = (node) => {
            if (!node) return;
            const trigger = (target) => {
              if (!target) return;
              try { target.emit('click', target); } catch(e) {}
              try {
                target.emit(cc.Node.EventType.TOUCH_START);
                target.emit(cc.Node.EventType.TOUCH_END);
              } catch(e) {}
              const comps = target._components || target.components || [];
              for (const c of comps) {
                if (c && c.clickEvents && c.clickEvents.length > 0) {
                  try { cc.Component.EventHandler.emitEvents(c.clickEvents, {}); } catch(e) {}
                }
              }
            };
            trigger(node);
            for (const child of (node.children || [])) {
              trigger(child);
            }
          };

          const btnHeader = findHeaderLoginBtn(scene);
          if (btnHeader) {
            window._lastHeaderBtn = btnHeader; // Lưu lại để phân biệt nút submit sau
            forceClickCocosNode(btnHeader);
            return { success: true, msg: `Tìm thấy nút "${btnHeader.name}" (parent: ${btnHeader.parent ? btnHeader.parent.name : 'null'}). Đã click.` };
          }
          return { success: false, msg: "Chưa thấy nút đăng nhập." };
        } catch(e) {
          return { success: false, msg: "Lỗi tìm nút Header: " + e.message };
        }
      });

      if (headerClickResult.success) {
        addServerLog(`👉 Kết quả click Header: ${headerClickResult.msg}`);
        btnHeaderFound = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!btnHeaderFound) {
      addServerLog("⚠️ Không tìm thấy nút Đăng nhập trên Header sau 90s chờ đợi.");
      try {
        const pubDir = path.join(__dirname, 'public');
        if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
        const screenshotPath = path.join(pubDir, 'lobby_not_found.png');
        await activePage.screenshot({ path: screenshotPath });
        addServerLog(`📸 Đã lưu màn hình sảnh bị kẹt vào public/lobby_not_found.png`);
      } catch(e) {
        addServerLog(`⚠️ Không thể chụp màn hình lỗi: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 3000));

    // Chẩn đoán: Quét và in ra các node đang chạy để gỡ lỗi
    const debugInfo = await activeFrame.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        if (!scene) return "Không tìm thấy scene";
        const topNodes = (scene.children || []).map(n => `${n.name}(active:${n.active})`);
        
        let related = [];
        const findByName = (node, depth=0) => {
          if (depth > 6) return;
          for (const child of (node.children || [])) {
            const nameLower = (child.name || "").toLowerCase();
            if (nameLower.includes('login') || nameLower.includes('dangnhap') || nameLower.includes('pop') || nameLower.includes('form') || nameLower.includes('box') || nameLower.includes('btn')) {
              related.push(`${" ".repeat(depth * 2)}- ${child.name} (active:${child.active}, parent:${child.parent ? child.parent.name : 'null'})`);
            }
            findByName(child, depth+1);
          }
        };
        findByName(scene);
        return `Top Nodes: ${topNodes.join(', ')}\nRelated Nodes:\n${related.join('\n')}`;
      } catch(e) {
        return "Lỗi debug: " + e.message;
      }
    });
    addServerLog(`🔍 [BOT LOGIN SCAN] Kết quả quét Scene:\n${debugInfo}`);

    // Kiểm tra xem captcha có active không
    const captchaActive = await activeFrame.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        const findEditBoxDeep = (node) => {
          if (!node) return null;
          const comps = node._components || node.components || [];
          for (const c of comps) {
            if (c && ('string' in c || '_string' in c) && ('placeholder' in c || '_placeholder' in c)) return c;
          }
          for (const child of (node.children || [])) {
            const r = findEditBoxDeep(child);
            if (r) return r;
          }
          return null;
        };
        const findInputNode = (node, targetName) => {
          if (!node) return null;
          if (node.name === targetName) {
            // Tìm EditBox trực tiếp trên node
            const editBox = findEditBoxDeep(node);
            if (editBox) return { node, editBox };
          }
          for (const child of (node.children || [])) {
            const r = findInputNode(child, targetName);
            if (r) return r;
          }
          return null;
        };
        const capResult = findInputNode(scene, "lb_edit_box_capcha");
        if (!capResult) return false;
        let curr = capResult.node;
        while (curr) {
          if (curr.active === false) return false;
          curr = curr.parent;
        }
        return true;
      } catch(e) { return false; }
    });

    let captchaCode = "";
    if (captchaActive) {
      addServerLog("🛡️ Phát hiện cổng game yêu cầu mã Captcha! Đang chụp màn hình...");
      const pubDir = path.join(__dirname, 'public');
      if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });

      const screenshotPath = path.join(pubDir, 'captcha.png');
      await activePage.screenshot({ path: screenshotPath });

      botState.waitingCaptcha = true;
      addServerLog("⏳ Đang chờ người dùng điền mã Captcha trên điện thoại...");

      captchaCode = await new Promise((resolve, reject) => {
        captchaResolver = resolve;
        captchaRejecter = reject;
      });

      botState.waitingCaptcha = false;
      captchaResolver = null;
      captchaRejecter = null;
      addServerLog(`📥 Nhận được mã Captcha: "${captchaCode}". Đang tự động điền và đăng nhập...`);
    }

    addServerLog("✍️ Đang tự động đăng nhập...");
    const loginResult = await activeFrame.evaluate((user, pass, capVal) => {
      try {
        const scene = cc.director.getScene();
        if (!scene) return { success: false, reason: "Không tìm thấy scene" };

        const findEditBoxDeep = (node) => {
          if (!node) return null;
          const comps = node._components || node.components || [];
          for (const c of comps) {
            if (c && ('string' in c || '_string' in c) && ('placeholder' in c || '_placeholder' in c)) return c;
          }
          for (const child of (node.children || [])) {
            const r = findEditBoxDeep(child);
            if (r) return r;
          }
          return null;
        };

        const findInputNode = (node, targetName) => {
          if (!node) return null;
          if (node.name === targetName) {
            const editBox = findEditBoxDeep(node);
            if (editBox) return { node, editBox };
            // Nếu không có EditBox trực tiếp, trả về node để log
            return { node, editBox: null };
          }
          for (const child of (node.children || [])) {
            const r = findInputNode(child, targetName);
            if (r) return r;
          }
          return null;
        };

        const forceClickCocosNode = (node) => {
          if (!node) return;
          const trigger = (target) => {
            if (!target) return;
            try { target.emit('click', target); } catch(e) {}
            try {
              target.emit(cc.Node.EventType.TOUCH_START);
              target.emit(cc.Node.EventType.TOUCH_END);
            } catch(e) {}
            const comps = target._components || target.components || [];
            for (const c of comps) {
              if (c && c.clickEvents && c.clickEvents.length > 0) {
                try { cc.Component.EventHandler.emitEvents(c.clickEvents, {}); } catch(e) {}
              }
            }
          };
          trigger(node);
          for (const child of (node.children || [])) {
            trigger(child);
          }
        };

        const findSubmitLoginBtn = (root) => {
          const btnLogins = [];
          const search = (node) => {
            if (!node) return;
            if (node.name === "btn_login") btnLogins.push(node);
            for (const child of (node.children || [])) search(child);
          };
          search(root);
          const headerBtn = window._lastHeaderBtn;
          const submitBtn = btnLogins.find(btn => btn !== headerBtn && btn.parent && btn.parent.name !== "unlogged_in_node");
          if (submitBtn) return submitBtn;
          return btnLogins.find(btn => btn !== headerBtn && btn.active) || btnLogins.find(btn => btn !== headerBtn) || btnLogins[0];
        };

        const usrResult = findInputNode(scene, "lb_edit_box_ten");
        const pwdResult = findInputNode(scene, "lb_edit_box_password");
        const capResult = findInputNode(scene, "lb_edit_box_capcha");

        if (!usrResult || !pwdResult || !usrResult.editBox || !pwdResult.editBox) {
          const usrFound = !!usrResult;
          const usrHasBox = usrResult && !!usrResult.editBox;
          const pwdFound = !!pwdResult;
          const pwdHasBox = pwdResult && !!pwdResult.editBox;
          return { success: false, reason: `Không tìm thấy linh kiện: usr(node=${usrFound},box=${usrHasBox}) pwd(node=${pwdFound},box=${pwdHasBox})` };
        }

        usrResult.editBox.string = user;
        usrResult.node.emit('text-changed', usrResult.editBox);
        if (usrResult.editBox._updateString) usrResult.editBox._updateString();

        pwdResult.editBox.string = pass;
        pwdResult.node.emit('text-changed', pwdResult.editBox);
        if (pwdResult.editBox._updateString) pwdResult.editBox._updateString();

        if (capResult && capVal) {
          capResult.editBox.string = capVal;
          capResult.node.emit('text-changed', capResult.editBox);
          if (capResult.editBox._updateString) capResult.editBox._updateString();
        }

        const btnSubmit = findSubmitLoginBtn(scene);
        if (!btnSubmit) return { success: false, reason: "Không tìm thấy nút Đăng nhập của popup" };

        forceClickCocosNode(btnSubmit);
        return { success: true };
      } catch (e) {
        return { success: false, reason: e.message };
      }
    }, username, password, captchaCode);

    if (!loginResult.success) {
      addServerLog(`⚠️ Thử đăng nhập dự phòng (HTML): ${loginResult.reason}`);
      await activeFrame.evaluate((user, pass) => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const userInput = inputs.find(i => i.type === 'text' || i.placeholder.toLowerCase().includes('tên') || i.placeholder.toLowerCase().includes('tài khoản'));
        const passInput = inputs.find(i => i.type === 'password' || i.placeholder.toLowerCase().includes('mật khẩu'));
        if (userInput && passInput) {
          userInput.value = user;
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          passInput.value = pass;
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const elList = Array.from(document.querySelectorAll('button, div, span, a'));
        const loginBtn = elList.find(el => {
          const txt = el.textContent.trim().toLowerCase();
          return txt === 'đăng nhập' || txt === 'login' || txt === 'vào game' || txt === 'xác nhận';
        });
        if (loginBtn) loginBtn.click();
      }, username, password);
    }

    addServerLog("⏳ Đăng nhập hoàn tất, đang chờ game chuyển tiếp tải chính thức...");
    await new Promise(r => setTimeout(r, 15000));

    addServerLog("🎮 Đang tự động tìm và mở bảng cược Tài Xỉu...");
    await activeFrame.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        const findNodeByName = (node, targetName) => {
          if (!node) return null;
          if (node.name === targetName) return node;
          for (const child of (node.children || [])) {
            const r = findNodeByName(child, targetName);
            if (r) return r;
          }
          return null;
        };

        const forceClickCocosNode = (node) => {
          if (!node) return;
          const trigger = (target) => {
            if (!target) return;
            try { target.emit('click', target); } catch(e) {}
            try {
              target.emit(cc.Node.EventType.TOUCH_START);
              target.emit(cc.Node.EventType.TOUCH_END);
            } catch(e) {}
            const comps = target._components || target.components || [];
            for (const c of comps) {
              if (c && c.clickEvents && c.clickEvents.length > 0) {
                try { cc.Component.EventHandler.emitEvents(c.clickEvents, {}); } catch(e) {}
              }
            }
          };
          trigger(node);
          for (const child of (node.children || [])) {
            trigger(child);
          }
        };

        const btnTaiXiu = findNodeByName(scene, "ico_taixiu") || 
                          findNodeByName(scene, "taixiu") || 
                          findNodeByName(scene, "ico_tx") || 
                          findNodeByName(scene, "btn_taixiu");
        if (btnTaiXiu) forceClickCocosNode(btnTaiXiu);
      } catch(e) {}
    });

    await new Promise(r => setTimeout(r, 2000));

    addServerLog("🎲 Đang chờ bảng cược Tài Xỉu đồng bộ dữ liệu...");
    let txReady = false;
    for (let i = 0; i < 60; i++) {
      txReady = await activeFrame.evaluate(() => {
        try {
          const scene = cc.director.getScene();
          const findNode = (n) => {
            if (!n) return null;
            if (n.name === 'prefab_taixiu') return n;
            for (const child of (n.children || [])) { const r = findNode(child); if (r) return r; }
            return null;
          };
          return !!findNode(scene);
        } catch(e) { return false; }
      });
      if (txReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (!txReady) {
      const sceneStructure = await activeFrame.evaluate(() => {
        try {
          const scene = cc.director.getScene();
          const nodes = [];
          const scan = (node, depth) => {
            if (!node) return;
            if (node.active) {
              nodes.push("  ".repeat(depth) + node.name);
            }
            for (const child of (node.children || [])) {
              scan(child, depth + 1);
            }
          };
          scan(scene, 0);
          return nodes.slice(0, 150).join('\n');
        } catch(e) { return "Lỗi quét: " + e.message; }
      });
      addServerLog("🔍 [DEBUG SCENE STRUCTURE]:\n" + sceneStructure);
      throw new Error("Không phát hiện bảng Tài Xỉu, bot đã tự động dừng.");
    }

    addServerLog("🎲 Đã phát hiện bàn cược Tài Xỉu! Tiến hành tiêm mã cược v3.5...");

    // Tiêm mã cược vào trang game
    await activePage.evaluate((bBet, cap, serverPort) => {
      window._syncLog = (msg) => {
        fetch(`http://localhost:${serverPort}/api/bot/log`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ message: msg })
        }).catch(()=>{});
      };

      window._syncState = (st) => {
        fetch(`http://localhost:${serverPort}/api/bot/update-state`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(st)
        }).catch(()=>{});
      };

      (() => {
        const cc = window.cc;
        if (cc && cc.game) {
          if (cc.game.config) cc.game.config.autoPause = false;
          cc.game.pause = function() {};
          window._syncLog("🔓 Đã mở khóa auto-pause game thành công.");
        }

        let txMain=null, nodeTai=null, nodeXiu=null, labelTimerNode=null;

        function findRoot(n) {
          if (!n) return null;
          if (n.name === 'prefab_taixiu') return n;
          for (const c of (n.children||[])) { const r=findRoot(c); if(r) return r; }
          return null;
        }

        function initComponent() {
          try {
            if (!cc || !cc.director) return false;
            const scene = cc.director.getScene();
            if (!scene) return false;
            const root = findRoot(scene);
            if (!root) return false;
            txMain = root.getComponent("TaiXiuGameView");
            if (!txMain) {
              const w = (n) => {
                if (txMain) return;
                const c = n.getComponent("TaiXiuGameView");
                if (c) { txMain=c; return; }
                for (const ch of (n.children||[])) w(ch);
              };
              w(root);
            }
            if (txMain) {
              nodeTai = txMain.btn_bet_tai?.node || txMain.btn_bet_tai;
              nodeXiu = txMain.btn_bet_xiu?.node || txMain.btn_bet_xiu;
            }
            return (txMain && nodeTai && nodeXiu);
          } catch(e) { return false; }
        }

        function toCleanNumber(val) {
          if (val===null||val===undefined) return 0;
          if (typeof val==='object') {
            if (typeof val.string==='string'||typeof val.string==='number') val=val.string;
            else if (val.node&&(typeof val.node.string==='string'||typeof val.node.string==='number')) val=val.node.string;
            else { try { const lbl=val.getComponent?val.getComponent(cc.Label):null; val=(lbl&&lbl.string)?lbl.string:0; } catch(e){val=0;} }
          }
          if (typeof val==='string') { const p=parseInt(val.replace(/[^0-9-]/g,'')); return isNaN(p)?0:p; }
          if (typeof val==='number') return isNaN(val)?0:val;
          return 0;
        }

        function getCountdownTime() {
          if (!txMain) return null;
          if (typeof txMain._timeRest==='number') return txMain._timeRest;
          if (typeof txMain.timeRest==='number') return txMain.timeRest;
          if (txMain.lblTime?.string) { const v=parseInt(txMain.lblTime.string); if(!isNaN(v)) return v; }
          if (labelTimerNode?.string) { const v=parseInt(labelTimerNode.string); if(!isNaN(v)) return v; }
          let foundVal=null;
          function search(node) {
            if (foundVal!==null||!node) return;
            const label=node.getComponent(cc.Label);
            if (label?.string) {
              const v=parseInt(label.string.trim());
              if (!isNaN(v)&&v>=0&&v<=55) {
                const name=node.name.toLowerCase();
                if (name.includes("time")||name.includes("timer")||name.includes("count")||name.includes("sec")||name.includes("giay")||
                    node.parent?.name.toLowerCase().includes("time")||node.parent?.name.toLowerCase().includes("count")) {
                  labelTimerNode=label; foundVal=v; return;
                }
              }
            }
            for (const ch of (node.children||[])) search(ch);
          }
          search(txMain.node);
          return foundVal;
        }

        function triggerButtonClick(btnComponent) {
          if (!btnComponent) return;
          let btn=btnComponent;
          if (btnComponent._components) {
            for (let c of btnComponent._components) {
              if (c&&typeof c==='object'&&('clickEvents'in c||'interactable'in c)) { btn=c; break; }
            }
          }
          if (btn?.clickEvents) cc.Component.EventHandler.emitEvents(btn.clickEvents,{});
          const targetNode=btn.node||btnComponent.node||btnComponent;
          if (targetNode&&typeof targetNode.emit==='function') {
            targetNode.emit(cc.Node.EventType.TOUCH_START);
            setTimeout(()=>targetNode.emit(cc.Node.EventType.TOUCH_END),20);
          }
        }

        function findConfirmButtonComponent() {
          if (!txMain) return null;
          let foundBtn=null;
          function search(node) {
            if (foundBtn||!node||!node.activeInHierarchy) return;
            let btnComp=null;
            if (node._components) { for(let c of node._components){if(c&&typeof c==='object'&&('clickEvents'in c||'interactable'in c)){btnComp=c;break;}} }
            if (btnComp) {
              const name=node.name.toLowerCase(); let txt="";
              const getText=(n)=>{if(n._components){for(let c of n._components){if(c?.string)txt+=c.string.toLowerCase()+" ";}}for(const ch of(n.children||[]))getText(ch);};
              getText(node);
              if (txt.includes("đồng ý")||txt.includes("xác nhận")||txt.includes("đặt cược")||txt.includes("đặt")||
                  name.includes("dongy")||name.includes("confirm")||name.includes("agree")||name.includes("bet")||name.includes("dong_y")) {
                foundBtn=btnComp; return;
              }
            }
            for(const ch of(node.children||[])) search(ch);
          }
          search(txMain.node); return foundBtn;
        }

        function getLocalSessionResult(phienId) {
          if (!txMain) return null;
          const resultsArray=Array.isArray(txMain._results)?txMain._results:[];
          const historyArray=(txMain.taiXiuSessionHistoryView&&Array.isArray(txMain.taiXiuSessionHistoryView._result))?txMain.taiXiuSessionHistoryView._result:[];
          for (let x of [...resultsArray,...historyArray]) {
            if (!x) continue;
            const sId=String(x.sessionID??x.session??'');
            if (sId===String(phienId)) {
              const d1=parseInt(x.d1||0),d2=parseInt(x.d2||0),d3=parseInt(x.d3||0),sum=d1+d2+d3;
              if(d1>=1&&d1<=6&&d2>=1&&d2<=6&&d3>=1&&d3<=6) return {phien:sId,ket_qua:sum>=11?'Tài':'Xỉu',xuc_xac:`${d1}-${d2}-${d3}`,tong_diem:sum};
            }
          }
          return null;
        }

        function getLatestSessionResultFallback() {
          if (!txMain) return null;
          const all=[...(Array.isArray(txMain._results)?txMain._results:[]),...((txMain.taiXiuSessionHistoryView&&Array.isArray(txMain.taiXiuSessionHistoryView._result))?txMain.taiXiuSessionHistoryView._result:[])];
          for(let i=all.length-1;i>=0;i--) {
            const x=all[i]; if(!x)continue;
            const d1=parseInt(x.d1||0),d2=parseInt(x.d2||0),d3=parseInt(x.d3||0),sum=d1+d2+d3;
            if(d1>=1&&d1<=6&&d2>=1&&d2<=6&&d3>=1&&d3<=6) return sum>=11?'Tài':'Xỉu';
          }
          return null;
        }

        function setMoney(amount) {
          if (!txMain) return;
          txMain._inputingMoney=amount;
          if(txMain.txt_bet_tai_amount?.node?.parent?.active){txMain.txt_bet_tai_amount.string=amount.toString();if(txMain.txt_bet_tai_amount._updateString)txMain.txt_bet_tai_amount._updateString();}
          else if(txMain.txt_bet_xiu_amount?.node?.parent?.active){txMain.txt_bet_xiu_amount.string=amount.toString();if(txMain.txt_bet_xiu_amount._updateString)txMain.txt_bet_xiu_amount._updateString();}
        }

        let running=true, baseBet=bBet, curBet=bBet, stage=1, totalProfit=0;
        let currentSessionId=null;
        let snap30=null, snap20=null;
        let placed=false, lastPred=null, lastAmt=0, activeSession=null;
        let moneyFlow=[];

        function getSnapFromFlow(targetSec) {
          if (moneyFlow.length===0) return null;
          let best=moneyFlow[0],minDiff=Math.abs(best.second-targetSec);
          for(let i=1;i<moneyFlow.length;i++){const diff=Math.abs(moneyFlow[i].second-targetSec);if(diff<minDiff){minDiff=diff;best=moneyFlow[i];}}
          if(minDiff<=3) return {tien_tai:best.tien_tai,tien_xiu:best.tien_xiu,nguoi_tai:best.nguoi_tai,nguoi_xiu:best.nguoi_xiu,timestamp:best.timestamp};
          return null;
        }

        function getHistoryArray() {
          if (!txMain) return [];
          const resultsArray = Array.isArray(txMain._results) ? txMain._results : [];
          const historyViewArray = (txMain.taiXiuSessionHistoryView && Array.isArray(txMain.taiXiuSessionHistoryView._result)) ? txMain.taiXiuSessionHistoryView._result : [];
          
          const map = new Map();
          for (const x of [...resultsArray, ...historyViewArray]) {
            if (!x) continue;
            const sId = parseInt(x.sessionID ?? x.session ?? 0);
            if (!sId) continue;
            const d1 = parseInt(x.d1 || 0), d2 = parseInt(x.d2 || 0), d3 = parseInt(x.d3 || 0), sum = d1 + d2 + d3;
            if (d1 >= 1 && d1 <= 6 && d2 >= 1 && d2 <= 6 && d3 >= 1 && d3 <= 6) {
              map.set(sId, sum >= 11 ? 'T' : 'X');
            }
          }

          const sortedSessionIds = Array.from(map.keys()).sort((a, b) => a - b);
          return sortedSessionIds.map(id => map.get(id));
        }

        function predictToolMrTin8PP(history) {
          const n = history.length;
          function k_fallback() {
            if (n === 0) return Math.random() < 0.5 ? "T" : "X";
            let t_cnt = 0;
            for (let i = 0; i < n; i++) { if (history[i] === "T") t_cnt++; }
            const x_cnt = n - t_cnt;
            if (t_cnt > x_cnt) return "T";
            if (x_cnt > t_cnt) return "X";
            return Math.random() < 0.5 ? "T" : "X";
          }
          function method_b() {
            if (n < 5) return k_fallback();
            const last = history[n - 1];
            let cnt_same = 0, cnt_T = 0;
            for (let i = 0; i < n - 1; i++) {
              if (history[i] === last) {
                cnt_same++;
                if (history[i + 1] === "T") cnt_T++;
              }
            }
            let prob = cnt_same > 0 ? cnt_T / cnt_same : 0.5;
            if (n >= 3) {
              const prev = history[n - 2];
              let match = 0, t_after = 0;
              for (let i = 0; i < n - 2; i++) {
                if (history[i] === prev && history[i + 1] === last) {
                  match++;
                  if (history[i + 2] === "T") t_after++;
                }
              }
              if (match >= 3) {
                const prob2 = t_after / match;
                prob = (prob + prob2) / 2.0;
              }
            }
            return prob >= 0.5 ? "T" : "X";
          }
          function method_c() {
            if (n < 8) return k_fallback();
            for (let gap = 2; gap <= 6; gap++) {
              const windowLen = Math.min(gap * 3, n);
              let matches = 0;
              for (let i = n - 1; i >= n - windowLen; i--) {
                if (i >= gap && history[i] === history[i - gap]) matches++;
              }
              const ratio = matches / windowLen;
              if (ratio >= 0.7) {
                const idx = ((n - 1) % gap) - gap + 1;
                if (idx >= 0 && idx < n) return history[idx];
              }
            }
            return k_fallback();
          }
          function method_d() {
            if (n < 5) return k_fallback();
            if (n >= 12) {
              const steps = [1, 1, 2, 3, 5];
              let pos = n - 1;
              let ok = true;
              for (let s = 0; s < steps.length; s++) {
                const step = steps[s];
                if (pos - step + 1 < 0) { ok = false; break; }
                const val = history[pos];
                for (let j = 0; j < step; j++) {
                  if (history[pos - j] !== val) { ok = false; break; }
                }
                if (!ok) break;
                pos -= step;
              }
              if (ok) return history[n - 1] === "T" ? "X" : "T";
            }
            let streak = 1;
            for (let i = n - 2; i >= 0; i--) {
              if (history[i] === history[n - 1]) streak++;
              else break;
            }
            if ([2, 3, 5, 8].includes(streak)) return history[n - 1] === "T" ? "X" : "T";
            return k_fallback();
          }
          function method_e() {
            if (n < 4) return k_fallback();
            let tt = 0, tx = 0, xt = 0, xx = 0;
            for (let i = 0; i < n - 1; i++) {
              const a = history[i], b = history[i + 1];
              if (a === "T" && b === "T") tt++;
              else if (a === "T" && b === "X") tx++;
              else if (a === "X" && b === "T") xt++;
              else if (a === "X" && b === "X") xx++;
            }
            if (history[n - 1] === "T") return tt >= tx ? "T" : "X";
            else return xt >= xx ? "T" : "X";
          }
          function method_f() {
            if (n < 6) return k_fallback();
            const windowLen = Math.min(6, n);
            const mid = n - windowLen;
            const prev_cnt = Math.min(6, mid);
            let t1 = 0, t2 = 0;
            for (let i = mid; i < n; i++) { if (history[i] === "T") t1++; }
            for (let i = mid - prev_cnt; i < mid; i++) { if (i >= 0 && history[i] === "T") t2++; }
            const r1 = t1 / windowLen;
            const r2 = prev_cnt > 0 ? t2 / prev_cnt : 0.5;
            const diff = r1 - r2;
            if (diff > 0.3) return "T";
            if (diff < -0.3) return "X";
            if (r1 > 0.6) return "X";
            if (r1 < 0.4) return "T";
            return k_fallback();
          }
          function method_g() {
            if (n < 6) return k_fallback();
            const a = history[n - 1], b = history[n - 2], c = history[n - 3], d = history[n - 4];
            if (a !== b && b !== c && c !== d) return a === "T" ? "X" : "T";
            if (a === b && b !== c && c === d) return a === "T" ? "X" : "T";
            if (a === b && b === c) return a === "T" ? "X" : "T";
            return k_fallback();
          }
          function method_h() {
            if (n === 0) return Math.random() < 0.5 ? "T" : "X";
            let streak = 1;
            for (let i = n - 2; i >= 0; i--) {
              if (history[i] === history[n - 1]) streak++;
              else break;
            }
            if (streak >= 3) return history[n - 1] === "T" ? "X" : "T";
            return k_fallback();
          }
          function method_i() {
            if (n === 0) return "T";
            let t_w = 0.0, x_w = 0.0;
            for (let i = 0; i < n; i++) {
              const w = Math.pow(1.15, i);
              if (history[i] === "T") t_w += w;
              else x_w += w;
            }
            return t_w >= x_w ? "T" : "X";
          }
          if (n < 3) return Math.random() < 0.5 ? "Tài" : "Xỉu";
          const results = [
            method_h(), method_g(), method_i(), method_e(),
            method_d(), method_c(), method_f(), method_b()
          ];
          const weights = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
          let sT = 0.0, sX = 0.0;
          for (let i = 0; i < results.length; i++) {
            if (results[i] === "T") sT += weights[i];
            else sX += weights[i];
          }
          return sT >= sX ? "Tài" : "Xỉu";
        }

        function loop() {
          if (!running) return;
          try {
            if (!initComponent()) return;

            const phienStr=txMain.lblSession.string;
            const phien=parseInt(phienStr.replace(/[^0-9]/g,''));
            if (isNaN(phien)) return;

            if (currentSessionId !== phien) {
              if (currentSessionId !== null && placed && activeSession) {
                window._syncLog(`⚠️ Phiên #${activeSession} chưa có kết quả khi chuyển phiên.`);
              }
              currentSessionId=phien;
              snap30=null; snap20=null; placed=false; activeSession=null; moneyFlow.length=0;
            }

            if (placed && activeSession) {
              const match=getLocalSessionResult(activeSession);
              if (match && match.ket_qua) {
                const result=match.ket_qua;
                const finalSnap30=snap30||getSnapFromFlow(30);
                const finalSnap20=snap20||getSnapFromFlow(20);
                if (lastPred===result) {
                  totalProfit += Math.max(1, Math.round(lastAmt * 0.98));
                  curBet=baseBet; stage=1;
                  window._syncLog(`Phiên #${activeSession} ra ${result} → THẮNG! Reset mức cược.`);
                } else {
                  totalProfit -= lastAmt;
                  curBet=lastAmt*2; stage++;
                  window._syncLog(`Phiên #${activeSession} ra ${result} → THUA. Gấp x2.`);
                }

                const syncPayload={phien:activeSession,ket_qua:result,xuc_xac:match.xuc_xac||"",tong_diem:match.tong_diem||(result==='Tài'?11:10),snap_30:finalSnap30,snap_20:finalSnap20,du_doan:lastPred,money_flow:[...moneyFlow],profit:totalProfit};
                snap30=null; snap20=null; placed=false; activeSession=null; moneyFlow.length=0;

                fetch(`http://localhost:${serverPort}/api/sync-result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(syncPayload)}).catch(()=>{});
              }
            }

            const timerVal=getCountdownTime();
            
            window._syncState({
              currentSession: currentSessionId,
              timerVal,
              prediction: lastPred,
              amount: curBet,
              stage,
              profit: totalProfit
            });

            if (timerVal!==null) {
              if (timerVal<=52&&timerVal>=20&&!moneyFlow.some(item=>item.second===timerVal)) {
                moneyFlow.push({second:timerVal,tien_tai:toCleanNumber(txMain.currentTaiMoney),tien_xiu:toCleanNumber(txMain.currentXiuMoney),nguoi_tai:toCleanNumber(txMain.taiPlayersCount),nguoi_xiu:toCleanNumber(txMain.xiuPlayersCount),timestamp:new Date().toISOString()});
              }

              if ((timerVal===30||timerVal===29)&&!snap30) {
                snap30={tien_tai:toCleanNumber(txMain.currentTaiMoney),tien_xiu:toCleanNumber(txMain.currentXiuMoney),nguoi_tai:toCleanNumber(txMain.taiPlayersCount),nguoi_xiu:toCleanNumber(txMain.xiuPlayersCount),timestamp:new Date().toISOString()};
                window._syncLog("Chụp dòng tiền mốc 30s.");
              }

              if ((timerVal===20||timerVal===19)&&!placed) {
                if (curBet > cap) {
                  window._syncLog(`⚠️ Mức cược ${curBet}đ vượt quá Vốn an toàn ${cap}đ! Dừng cược.`);
                  running = false;
                  return;
                }

                snap20={tien_tai:toCleanNumber(txMain.currentTaiMoney),tien_xiu:toCleanNumber(txMain.currentXiuMoney),nguoi_tai:toCleanNumber(txMain.taiPlayersCount),nguoi_xiu:toCleanNumber(txMain.xiuPlayersCount),timestamp:new Date().toISOString()};
                window._syncLog("Chụp dòng tiền mốc 20s.");

                const historyList = getHistoryArray();
                window._syncLog(`📊 Đã nạp thành công ${historyList.length} phiên lịch sử. Đang tính toán 8 phương pháp ToolMrTin...`);
                const pred = predictToolMrTin8PP(historyList);

                placed=true; lastPred=pred; lastAmt=curBet; activeSession=phien;

                  window._syncLog(`Dự đoán phiên #${phien}: Đặt ${pred.toUpperCase()} ${lastAmt.toLocaleString()}đ`);
                  triggerButtonClick(pred==='Tài'?nodeTai:nodeXiu);
                  
                  let checkCount=0;
                  const checkActive=setInterval(()=>{
                    const activeLabel=pred==='Tài'?txMain.txt_bet_tai_amount:txMain.txt_bet_xiu_amount;
                    if(activeLabel?.node?.parent?.active||checkCount>25){
                      clearInterval(checkActive); setMoney(lastAmt);
                      setTimeout(()=>{
                        const confirmBtn=findConfirmButtonComponent();
                        if(confirmBtn){
                          triggerButtonClick(confirmBtn);
                          window._syncLog(`Đặt cược ${lastAmt.toLocaleString()}đ cửa ${pred.toUpperCase()} thành công!`);
                        }
                      },60);
                    }
                    checkCount++;
                  },20);
              }
            }
          } catch(e) { console.error("Lỗi loop:", e.message); }
        }

        setInterval(loop, 200);
        setInterval(() => { if (!txMain || !txMain.isValid) initComponent(); }, 5000);
        window._syncLog("⚡ Hệ thống cược tự động v3.5 READY!");
      })();
    }, baseBet, capital, PORT);

    addServerLog("✅ Đã tiêm mã bot thành công! Đang chạy cược...");
  } catch(e) {
    addServerLog(`❌ Lỗi hệ thống: ${e.message}`);
    await stopPuppeteerBot();
  }
}

async function stopPuppeteerBot() {
  botState.running = false;
  addServerLog("🛑 Đang dừng trình duyệt ẩn...");
  
  if (captchaRejecter) {
    try { captchaRejecter(new Error("Bot stopped by user")); } catch(e) {}
    captchaRejecter = null;
    captchaResolver = null;
  }

  if (activeBrowser) {
    try {
      // Đóng trình duyệt ảo với timeout 3s để tránh bị treo cứng luồng do tiến trình zombie
      await Promise.race([
        activeBrowser.close(),
        new Promise(r => setTimeout(r, 3000))
      ]);
    } catch(e) {
      addServerLog(`⚠️ Cảnh báo lỗi tắt browser: ${e.message}`);
    }
    activeBrowser = null;
    activePage = null;
  }
  botState.timerVal = null;
  botState.prediction = "---";
  addServerLog("✅ Đã tắt trình duyệt chạy ngầm.");
  sendTelegramMessage("✅ <b>[ĐÃ TẮT BOT THÀNH CÔNG]</b>\nTrình duyệt ngầm đã được đóng hoàn toàn. Bot đã dừng toàn bộ hoạt động cược.");
}

// ===== HTTP ENDPOINTS ĐIỀU KHIỂN BOT DI ĐỘNG =====

app.post('/api/bot/start', (req, res) => {
  const { username, password, baseBet, capital, proxyServer, proxyUser, proxyPass, telegramToken: tgTok, telegramChatId: tgChat } = req.body;
  
  if (tgTok) telegramToken = tgTok;
  if (tgChat) telegramChatId = tgChat;

  if (botState.running || isStarting) {
    return res.status(400).json({ status: 'error', message: 'Bot đang chạy hoặc đang trong quá trình khởi động.' });
  }
  
  console.log(`📝 [DASHBOARD] Nhận lệnh khởi chạy bot cho tài khoản: "${username}"`);
  addServerLog(`📝 Nhận lệnh khởi chạy bot cho tài khoản: "${username}"`);

  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Thiếu thông tin đăng nhập' });
  }

  isStarting = true;
  // Lưu cấu hình để auto-restart sau khi container khởi động lại
  saveBotConfig({ username, password, baseBet, capital, proxyServer, proxyUser, proxyPass, telegramToken, telegramChatId });
  // Chạy nền không chặn request trả về điện thoại
  startPuppeteerBot(username, password, baseBet, capital, proxyServer, proxyUser, proxyPass)
    .catch(err => {
      addServerLog(`❌ Lỗi khởi chạy: ${err.message}`);
    })
    .finally(() => {
      isStarting = false;
    });

  res.json({ status: 'success', message: 'Đang khởi chạy ngầm...' });
});

app.post('/api/telegram/test', (req, res) => {
  const { token, chatId } = req.body;
  if (!token || !chatId) {
    return res.status(400).json({ status: 'error', message: 'Thiếu Token hoặc Chat ID' });
  }
  telegramToken = token;
  telegramChatId = chatId;
  sendTelegramMessage("✅ <b>[KẾT NỐI THÀNH CÔNG]</b> Telegram Bot đã được liên kết thành công với hệ thống cược Sunwin!", chatId, token);
  res.json({ status: 'success' });
});

app.post('/api/bot/stop', async (req, res) => {
  clearBotConfig(); // Xóa cấu hình để không auto-restart sau khi dừng thủ công
  await stopPuppeteerBot();
  res.json({ status: 'success', message: 'Đã dừng bot.' });
});

app.get('/api/bot/status', (req, res) => {
  res.json({
    running: botState.running,
    waitingCaptcha: botState.waitingCaptcha,
    state: botState
  });
});

app.get('/api/algorithm-details', (req, res) => {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  let historyList = [];
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const lines = data.trim().split('\n').filter(Boolean);
      const records = lines.map(line => { try { return JSON.parse(line); } catch(e) { return null; } }).filter(Boolean);
      historyList = records.map(r => r.ket_qua === 'Tài' ? 'T' : 'X');
    } catch(e) {}
  }
  const info = analyzeToolMrTin8PP(historyList);
  res.json({
    status: 'success',
    algorithm: 'ToolMrTin (8-Method Smali Model)',
    analysis: info
  });
});

app.post('/api/bot/submit-captcha', (req, res) => {
  const { captchaCode } = req.body;
  if (!captchaCode) {
    return res.status(400).json({ status: 'error', message: 'Thiếu mã captcha' });
  }
  if (captchaResolver) {
    captchaResolver(captchaCode);
    res.json({ status: 'success', message: 'Mã captcha đã được gửi đi.' });
  } else {
    res.status(400).json({ status: 'error', message: 'Không có yêu cầu captcha hoạt động.' });
  }
});

app.post('/api/bot/reload-captcha', async (req, res) => {
  if (activePage) {
    try {
      addServerLog("🔄 Đang yêu cầu đổi mã captcha mới...");
      await activePage.evaluate(() => {
        try {
          const scene = cc.director.getScene();
          const findNodeByName = (node, name) => {
            if (!node) return null;
            if (node.name === name) return node;
            for (const c of (node.children || [])) {
              const r = findNodeByName(c, name);
              if (r) return r;
            }
            return null;
          };
          const btnReload = findNodeByName(scene, "btn_reload");
          if (btnReload) {
            const comps = btnReload._components || btnReload.components || [];
            for (const c of comps) {
              if (c && c.clickEvents && c.clickEvents.length > 0) {
                cc.Component.EventHandler.emitEvents(c.clickEvents, {});
              }
            }
            if (typeof btnReload.emit === 'function') {
              btnReload.emit(cc.Node.EventType.TOUCH_START);
              setTimeout(() => btnReload.emit(cc.Node.EventType.TOUCH_END), 50);
            }
          }
        } catch(e) {}
      });

      await new Promise(r => setTimeout(r, 1200));
      const screenshotPath = path.join(__dirname, 'public', 'captcha.png');
      await activePage.screenshot({ path: screenshotPath });

      res.json({ status: 'success' });
    } catch(e) {
      res.status(500).json({ status: 'error', message: e.message });
    }
  } else {
    res.status(400).json({ status: 'error', message: 'Bot chưa khởi chạy' });
  }
});

app.get('/api/bot/captcha-screenshot', (req, res) => {
  const screenshotPath = path.join(__dirname, 'public', 'captcha.png');
  if (fs.existsSync(screenshotPath)) {
    res.sendFile(screenshotPath);
  } else {
    res.status(404).send('Not found');
  }
});

app.post('/api/bot/log', (req, res) => {
  const { message } = req.body;
  if (message) addServerLog(message);
  res.json({ status: 'ok' });
});

app.post('/api/bot/update-state', (req, res) => {
  const { currentSession, timerVal, prediction, amount, stage, profit } = req.body;
  botState.currentSession = currentSession || botState.currentSession;
  botState.timerVal = timerVal !== undefined ? timerVal : botState.timerVal;
  botState.prediction = prediction || botState.prediction;
  botState.amount = amount !== undefined ? amount : botState.amount;
  botState.stage = stage !== undefined ? stage : botState.stage;
  botState.profit = profit !== undefined ? profit : botState.profit;
  res.json({ status: 'ok' });
});

// ===== CÁC ENDPOINT ĐỒNG BỘ DATA & LỊCH SỬ CŨ =====

app.post('/api/sync-result', (req, res) => {
  const { phien, ket_qua, xuc_xac, tong_diem, du_doan, snap_30, snap_20, money_flow, profit } = req.body;
  if (profit !== undefined) {
    botState.profit = profit;
  }

  if (!phien || !ket_qua) {
    return res.status(400).json({ error: 'Thiếu thông tin phiên hoặc kết quả' });
  }

  const sessId = parseInt(phien);
  console.log(`[🔄 SYNC-RESULT] Nhận đồng bộ phiên #${sessId}: ${ket_qua}`);

  let record = frozenSnapshots.get(sessId) || { phien: sessId, snap_30: null, snap_20: null };
  record.ket_qua = ket_qua;
  if (xuc_xac) record.xuc_xac = xuc_xac;
  if (tong_diem) record.tong_diem = parseInt(tong_diem);
  if (snap_30) record.snap_30 = snap_30;
  if (snap_20) record.snap_20 = snap_20;
  if (money_flow) record.money_flow = money_flow;
  record.timestamp_ket_qua = new Date().toISOString();

  const predToCompare = record.du_doan || du_doan;
  if (predToCompare) {
    record.du_doan = predToCompare;
    const isWin = predToCompare === ket_qua;
    if (isWin) {
      consecLosses = 0;
    } else {
      consecLosses++;
    }

    const outcomeSymbol = isWin ? "✅ THẮNG" : "❌ THUA";
    const profitVal = (botState.profit || 0).toLocaleString() + "đ";
    sendTelegramMessage(
      `<b>[KẾT QUẢ PHIÊN #${sessId}]</b>\n` +
      `• Ra: <b>${ket_qua}</b> (${xuc_xac || ''} = ${tong_diem || ''}đ)\n` +
      `• Dự đoán: <b>${predToCompare}</b> (${outcomeSymbol})\n` +
      `• Chuỗi thua: ${consecLosses} tay\n` +
      `• Tổng lợi nhuận: <b>${profitVal}</b>`
    );
  }

  saveCompletedRecord(record);
  prevSessionRecord = record;
  frozenSnapshots.delete(sessId);

  res.json({ status: 'ok', consecLosses });
});

app.get('/api/prediction', (req, res) => {
  if (currentPrediction) {
    res.json(currentPrediction);
  } else {
    res.json({
      phien: currentSessionId,
      du_doan: "dang_doi_giay_20",
      mo_ta: "Đang chờ đến giây thứ 20"
    });
  }
});

app.get('/api/history', (req, res) => {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  if (!fs.existsSync(filePath)) return res.json([]);
  
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Lỗi đọc file lịch sử' });
    const lines = data.trim().split('\n').filter(Boolean);
    const records = lines.map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
    res.json(records.reverse());
  });
});

app.get('/api/clear-history', (req, res) => {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  if (fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) return res.status(500).json({ error: 'Lỗi xóa file lịch sử' });
      consecLosses = 0;
      currentPrediction = null;
      prevSessionRecord = null;
      frozenSnapshots.clear();
      res.send('<h1>✅ Đã xóa sạch dữ liệu lịch sử cũ thành công!</h1>');
    });
  } else {
    res.send('<h1>ℹ️ Không có dữ liệu cũ để xóa.</h1>');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

loadHistoryAndSync();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[🌐] API Server đang chạy tại http://0.0.0.0:${PORT}`);
  // Tự động khởi động lại bot nếu container vừa restart
  autoRestartBot();
});

// Chống crash Node.js khi có lỗi mạng từ Chromium hoặc Thư viện ngầm
process.on('unhandledRejection', (reason, promise) => {
  console.error('[⚠️ UNHANDLED REJECTION]:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[❌ UNCAUGHT EXCEPTION]:', err.stack || err.message);
});
