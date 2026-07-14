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

// Trọng số phi tuyến tính 28D siêu tối ưu v4.0
function getEnsemblePrediction(curr, prev, losses) {
  const x1 = prev && prev.ket_qua ? (prev.ket_qua === 'Tài' ? 1 : -1) : 1;
  
  const snap_30 = curr.snap_30 || {};
  const snap_20 = curr.snap_20 || {};

  const tien_tai_30 = snap_30.tien_tai || 0;
  const tien_xiu_30 = snap_30.tien_xiu || 0;
  const x2 = tien_tai_30 > tien_xiu_30 ? 1 : -1;

  const tien_tai_20 = snap_20.tien_tai || 0;
  const tien_xiu_20 = snap_20.tien_xiu || 0;
  const x3 = tien_tai_20 > tien_xiu_20 ? 1 : -1;

  const nguoi_tai_30 = snap_30.nguoi_tai || 0;
  const nguoi_xiu_30 = snap_30.nguoi_xiu || 0;
  const x4 = nguoi_tai_30 > nguoi_xiu_30 ? 1 : -1;

  const diff_tai = tien_tai_20 - tien_tai_30;
  const diff_xiu = tien_xiu_20 - tien_xiu_30;
  const x5 = diff_tai > diff_xiu ? 1 : -1;

  const nguoi_tai_20 = snap_20.nguoi_tai || 0;
  const nguoi_xiu_20 = snap_20.nguoi_xiu || 0;
  const x6 = nguoi_tai_20 > nguoi_xiu_20 ? 1 : -1;

  const diff_users_tai = nguoi_tai_20 - nguoi_tai_30;
  const diff_users_xiu = nguoi_xiu_20 - nguoi_xiu_30;
  const x7 = diff_users_tai > diff_users_xiu ? 1 : -1;

  const base = [x1, x2, x3, x4, x5, x6, x7];
  const terms = [...base];
  for (let i = 0; i < base.length; i++) {
    for (let j = i + 1; j < base.length; j++) {
      terms.push(base[i] * base[j]);
    }
  }

  const w = [6, 9, 12, -1, 11, -2, -12, -4, -1, 1, -10, -2, -13, -9, 4, -8, 0, -11, 9, 2, -5, 7, -12, 1, -8, -12, 8, 12];

  let score = 0;
  for (let i = 0; i < 28; i++) {
    score += w[i] * terms[i];
  }
  return score >= 0 ? 'Tài' : 'Xỉu';
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
        addServerLog("❌ Lỗi lấy IP từ TinProxy API. Vui lòng kiểm tra lại Key hoặc đợi 2 phút.");
        throw new Error("Lỗi kết nối TinProxy");
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
      } catch (e) {
        addServerLog(`[BROWSER CONSOLE] ${msg.text()}`);
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

        function predictEnsemble28D(x1, x2, x3, x4, x5, x6, x7) {
          const base = [x1, x2, x3, x4, x5, x6, x7];
          const terms = [...base];
          for (let i = 0; i < base.length; i++) {
            for (let j = i + 1; j < base.length; j++) {
              terms.push(base[i] * base[j]);
            }
          }
          const w = [6, 9, 12, -1, 11, -2, -12, -4, -1, 1, -10, -2, -13, -9, 4, -8, 0, -11, 9, 2, -5, 7, -12, 1, -8, -12, 8, 12];
          let score = 0;
          for (let i = 0; i < 28; i++) {
            score += w[i] * terms[i];
          }
          return score >= 0 ? 'Tài' : 'Xỉu';
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
                const syncPayload={phien:activeSession,ket_qua:result,xuc_xac:match.xuc_xac||"",tong_diem:match.tong_diem||(result==='Tài'?11:10),snap_30:finalSnap30,snap_20:finalSnap20,du_doan:lastPred,money_flow:[...moneyFlow]};

                if (lastPred===result) {
                  totalProfit += Math.round(lastAmt * 0.98);
                  curBet=baseBet; stage=1;
                  window._syncLog(`Phiên #${activeSession} ra ${result} → THẮNG! Reset mức cược.`);
                } else {
                  totalProfit -= lastAmt;
                  curBet=lastAmt*2; stage++;
                  window._syncLog(`Phiên #${activeSession} ra ${result} → THUA. Gấp x2.`);
                }
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

                const finalSnap30=snap30||getSnapFromFlow(30);
                const prevMatch=getLocalSessionResult(phien-1);
                const prevOutcome=(prevMatch?.ket_qua)?prevMatch.ket_qua:getLatestSessionResultFallback();

                if (prevOutcome && finalSnap30) {
                  const x1=prevOutcome==='Tài'?1:-1;
                  const x2=finalSnap30.tien_tai>finalSnap30.tien_xiu?1:-1;
                  const x3=snap20.tien_tai>snap20.tien_xiu?1:-1;
                  const x4=finalSnap30.nguoi_tai>finalSnap30.nguoi_xiu?1:-1;
                  const x5=(snap20.tien_tai-finalSnap30.tien_tai)>(snap20.tien_xiu-finalSnap30.tien_xiu)?1:-1;
                  
                  const nguoi_tai_20 = snap20.nguoi_tai || 0;
                  const nguoi_xiu_20 = snap20.nguoi_xiu || 0;
                  const x6 = nguoi_tai_20 > nguoi_xiu_20 ? 1 : -1;

                  const diff_users_tai = nguoi_tai_20 - finalSnap30.nguoi_tai;
                  const diff_users_xiu = nguoi_xiu_20 - finalSnap30.nguoi_xiu;
                  const x7 = diff_users_tai > diff_users_xiu ? 1 : -1;
                  
                  const pred=predictEnsemble28D(x1,x2,x3,x4,x5,x6,x7);

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
                } else {
                  window._syncLog("⚠️ Bỏ qua do thiếu dữ liệu 30s hoặc kết quả phiên cũ.");
                }
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
}

// ===== HTTP ENDPOINTS ĐIỀU KHIỂN BOT DI ĐỘNG =====

app.post('/api/bot/start', (req, res) => {
  const { username, password, baseBet, capital, proxyServer, proxyUser, proxyPass } = req.body;
  
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
  saveBotConfig({ username, password, baseBet, capital, proxyServer, proxyUser, proxyPass });
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
  const { phien, ket_qua, xuc_xac, tong_diem, du_doan, snap_30, snap_20, money_flow } = req.body;
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
    if (predToCompare === ket_qua) {
      consecLosses = 0;
    } else {
      consecLosses++;
    }
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
