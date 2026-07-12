const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

// Trọng số phi tuyến tính 15D tối ưu của v3.5
function getEnsemblePrediction(curr, prev, losses) {
  const x1 = prev && prev.ket_qua ? (prev.ket_qua === 'Tài' ? 1 : -1) : 1;
  const x2 = curr.snap_30 && curr.snap_30.tien_tai > curr.snap_30.tien_xiu ? 1 : -1;
  const x3 = curr.snap_20 && curr.snap_20.tien_tai > curr.snap_20.tien_xiu ? 1 : -1;
  const x4 = curr.snap_30 && curr.snap_30.nguoi_tai > curr.snap_30.nguoi_xiu ? 1 : -1;
  const diff_tai = curr.snap_30 && curr.snap_20 ? (curr.snap_20.tien_tai - curr.snap_30.tien_tai) : 0;
  const diff_xiu = curr.snap_30 && curr.snap_20 ? (curr.snap_20.tien_xiu - curr.snap_30.tien_xiu) : 0;
  const x5 = diff_tai > diff_xiu ? 1 : -1;

  const w = [-5, -5, 2, -5, 0, 6, -1, -11, 3, -1, 2, 4, -3, -3, 12];
  const terms = [
    x1, x2, x3, x4, x5,
    x1 * x2, x1 * x3, x1 * x4, x1 * x5,
    x2 * x3, x2 * x4, x2 * x5,
    x3 * x4, x3 * x5,
    x4 * x5
  ];

  let score = 0;
  for (let i = 0; i < 15; i++) {
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

function addServerLog(msg) {
  const time = new Date().toLocaleTimeString();
  const formatted = `[${time}] ${msg}`;
  console.log(formatted);
  botState.logs.push(formatted);
  if (botState.logs.length > 40) botState.logs.shift();
}

async function startPuppeteerBot(username, password, baseBet, capital) {
  if (activeBrowser) {
    await stopPuppeteerBot();
  }

  botState.running = true;
  botState.logs = [];
  addServerLog("🚀 Khởi động trình duyệt ảo Chromium ngầm...");

  try {
    activeBrowser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,720'
      ]
    });
    activePage = await activeBrowser.newPage();
    await activePage.setViewport({ width: 1280, height: 720 });

    addServerLog("🧭 Đang truy cập trang chủ game Sunwin...");
    await activePage.goto('https://web.sunwin.best/?affId=Sunwin', { waitUntil: 'networkidle2', timeout: 60000 });

    addServerLog("🔍 Đang kiểm tra giao diện trang chủ...");
    await activePage.evaluate(() => {
      const clickLandingBtn = () => {
        const elList = Array.from(document.querySelectorAll('a, button, div, span'));
        const targetBtn = elList.find(el => {
          const txt = el.textContent.trim().toLowerCase();
          return txt.includes('chơi nhanh bản web') || txt.includes('bản web') || txt.includes('chơi trên web') || txt.includes('web game') || txt.includes('vào game');
        });
        if (targetBtn) {
          targetBtn.click();
          return true;
        }
        return false;
      };
      clickLandingBtn();
      setTimeout(clickLandingBtn, 1000);
      setTimeout(clickLandingBtn, 2500);
    });

    addServerLog("⏳ Đang chờ hệ thống game tải (Cocos Creator Engine)...");
    let ccReady = false;
    for (let i = 0; i < 60; i++) {
      ccReady = await activePage.evaluate(() => {
        try { return !!(window.cc && cc.director && cc.director.getScene()); } catch(e) { return false; }
      });
      if (ccReady) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!ccReady) throw new Error("Không thể tải engine game. Vui lòng kiểm tra lại đường truyền.");

    addServerLog("🔑 Đang kích hoạt nút Đăng nhập trên Header...");
    await activePage.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        const findNodeByName = (node, target) => {
          if (!node) return null;
          if (node.name === target) return node;
          for (const c of (node.children || [])) {
            const r = findNodeByName(c, target);
            if (r) return r;
          }
          return null;
        };
        const btnHeaderLogin = findNodeByName(scene, "btn_login");
        if (btnHeaderLogin) {
          const comps = btnHeaderLogin._components || btnHeaderLogin.components || [];
          for (const c of comps) {
            if (c && c.clickEvents && c.clickEvents.length > 0) {
              cc.Component.EventHandler.emitEvents(c.clickEvents, {});
            }
          }
          if (typeof btnHeaderLogin.emit === 'function') {
            btnHeaderLogin.emit(cc.Node.EventType.TOUCH_START);
            setTimeout(() => btnHeaderLogin.emit(cc.Node.EventType.TOUCH_END), 50);
          }
        }
      } catch(e) {}
    });

    await new Promise(r => setTimeout(r, 1500));

    // Kiểm tra xem captcha có active không
    const captchaActive = await activePage.evaluate(() => {
      try {
        const scene = cc.director.getScene();
        const findNodeByName = (node, target) => {
          if (!node) return null;
          if (node.name === target) return node;
          for (const c of (node.children || [])) {
            const r = findNodeByName(c, target);
            if (r) return r;
          }
          return null;
        };
        const capNode = findNodeByName(scene, "lb_edit_box_capcha");
        return !!(capNode && capNode.activeInHierarchy !== false);
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
    const loginResult = await activePage.evaluate((user, pass, capVal) => {
      try {
        const scene = cc.director.getScene();
        if (!scene) return { success: false, reason: "Không tìm thấy scene" };

        const findNodeByName = (node, target) => {
          if (!node) return null;
          if (node.name === target) return node;
          for (const c of (node.children || [])) {
            const r = findNodeByName(c, target);
            if (r) return r;
          }
          return null;
        };

        const findEditBoxInNode = (node) => {
          const comps = node._components || node.components || [];
          for (const c of comps) {
            if (c && ('string' in c || '_string' in c) && ('placeholder' in c || '_placeholder' in c)) return c;
          }
          return null;
        };

        const usrNode = findNodeByName(scene, "lb_edit_box_ten");
        const pwdNode = findNodeByName(scene, "lb_edit_box_password");
        const capNode = findNodeByName(scene, "lb_edit_box_capcha");

        const usrBox = usrNode ? findEditBoxInNode(usrNode) : null;
        const pwdBox = pwdNode ? findEditBoxInNode(pwdNode) : null;
        const capBox = capNode ? findEditBoxInNode(capNode) : null;

        if (!usrBox || !pwdBox) {
          return { success: false, reason: `Không tìm thấy các ô điền. UserNode: ${!!usrNode}, PwdNode: ${!!pwdNode}` };
        }

        usrBox.string = user;
        usrNode.emit('text-changed', usrBox);
        if (usrBox._updateString) usrBox._updateString();

        pwdBox.string = pass;
        pwdNode.emit('text-changed', pwdBox);
        if (pwdBox._updateString) pwdBox._updateString();

        if (capBox && capVal) {
          capBox.string = capVal;
          capNode.emit('text-changed', capBox);
          if (capBox._updateString) capBox._updateString();
        }

        const loginPopup = findNodeByName(scene, "popup_1");
        if (!loginPopup) return { success: false, reason: "Không tìm thấy popup ĐĂNG NHẬP" };

        const btnSubmit = findNodeByName(loginPopup, "btn_login");
        if (!btnSubmit) return { success: false, reason: "Không tìm thấy nút Xác nhận Đăng nhập (btn_login)" };

        const comps = btnSubmit._components || btnSubmit.components || [];
        for (const c of comps) {
          if (c && c.clickEvents && c.clickEvents.length > 0) {
            cc.Component.EventHandler.emitEvents(c.clickEvents, {});
          }
        }
        if (typeof btnSubmit.emit === 'function') {
          btnSubmit.emit(cc.Node.EventType.TOUCH_START);
          setTimeout(() => btnSubmit.emit(cc.Node.EventType.TOUCH_END), 50);
        }

        return { success: true };
      } catch (e) {
        return { success: false, reason: e.message };
      }
    }, username, password, captchaCode);

    if (!loginResult.success) {
      addServerLog(`⚠️ Thử đăng nhập dự phòng (HTML): ${loginResult.reason}`);
      await activePage.evaluate((user, pass) => {
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
    addServerLog("🎮 Game đã load xong! Đang chờ bạn mở bảng cược Tài Xỉu...");

    let txReady = false;
    for (let i = 0; i < 60; i++) {
      txReady = await activePage.evaluate(() => {
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

    if (!txReady) throw new Error("Không phát hiện bảng Tài Xỉu, bot đã tự động dừng.");

    addServerLog("🎲 Đã phát hiện bàn cược Tài Xỉu! Tiến hành tiêm mã cược v3.5...");

    // Tiêm mã cược vào trang game
    await activePage.evaluate((bBet, cap) => {
      window._syncLog = (msg) => {
        fetch('/api/bot/log', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ message: msg })
        }).catch(()=>{});
      };

      window._syncState = (st) => {
        fetch('/api/bot/update-state', {
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

        function predictEnsemble15D(x1, x2, x3, x4, x5) {
          const w = [-5, -5, 2, -5, 0, 6, -1, -11, 3, -1, 2, 4, -3, -3, 12];
          const terms = [
            x1, x2, x3, x4, x5,
            x1 * x2, x1 * x3, x1 * x4, x1 * x5,
            x2 * x3, x2 * x4, x2 * x5,
            x3 * x4, x3 * x5,
            x4 * x5
          ];
          let score = 0;
          for (let i = 0; i < 15; i++) {
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

                fetch(`/api/sync-result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(syncPayload)}).catch(()=>{});
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
                  const pred=predictEnsemble15D(x1,x2,x3,x4,x5);

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
    }, baseBet, capital);

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
    try { await activeBrowser.close(); } catch(e) {}
    activeBrowser = null;
    activePage = null;
  }
  botState.timerVal = null;
  botState.prediction = "---";
  addServerLog("✅ Đã tắt trình duyệt chạy ngầm.");
}

// ===== HTTP ENDPOINTS ĐIỀU KHIỂN BOT DI ĐỘNG =====

app.post('/api/bot/start', (req, res) => {
  const { username, password, baseBet, capital } = req.body;
  if (!username || !password) {
    return res.status(400).json({ status: 'error', message: 'Thiếu thông tin đăng nhập' });
  }

  // Chạy nền không chặn request trả về điện thoại
  startPuppeteerBot(username, password, baseBet, capital);
  res.json({ status: 'success', message: 'Đang khởi chạy ngầm...' });
});

app.post('/api/bot/stop', async (req, res) => {
  await stopPuppeteerBot();
  res.json({ status: 'success', message: 'Đã dừng bot.' });
});

app.get('/api/bot/status', (req, res) => {
  res.json(botState);
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
});
