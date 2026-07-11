const WebSocket = require('ws');
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// Cấu hình WebSocket JSON từ thư mục test hoạt động 24/7 ổn định
const WS_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
const WS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://play.sun.win"
};

// Gói tin khởi tạo để đăng ký lắng nghe sự kiện từ Server
const INIT_MSGS = [
  [1,"MiniGame","GM_apivopnha","WangLin",{"info":"{\"ipAddress\":\"14.249.227.107\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiI5ODE5YW5zc3MiLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjozMjMyODExNTEsImFmZklkIjoic3VuLndpbiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzYzMDMyOTI4NzcwLCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjE0LjI0OS4yMjcuMTA3IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wNS5wbmciLCJwbGF0Zm9ybUlkIjo0LCJ1c2VySWQiOiI4ODM4NTMzZS1kZTQzLTRiOGQtOTUwMy02MjFmNDA1MDUzNGUiLCJyZWdUaW1lIjoxNzYxNjMyMzAwNTc2LCJwaG9uZSI6IiIsImRlcG9zaXQiOmZhbHNlLCJ1c2VybmFtZSI6IkdNX2FwaXZvcG5oYSJ9.guH6ztJSPXUL1cU8QdMz8O1Sdy_SbxjSM-CDzWPTr-0\",\"locale\":\"vi\",\"userId\":\"8838533e-de43-4b8d-9503-621f4050534e\",\"username\":\"GM_apivopnha\",\"timestamp\":1763032928770,\"refreshToken\":\"e576b43a64e84f789548bfc7c4c8d1e5.7d4244a361e345908af95ee2e8ab2895\"}","signature":"45EF4B318C883862C36E1B189A1DF5465EBB60CB602BA05FAD8FCBFCD6E0DA8CB3CE65333EDD79A2BB4ABFCE326ED5525C7D971D9DEDB5A17A72764287FFE6F62CBC2DF8A04CD8EFF8D0D5AE27046947ADE45E62E644111EFDE96A74FEC635A97861A425FF2B5732D74F41176703CA10CFEED67D0745FF15EAC1065E1C8BCBFA"}],
  [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
  [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

let ws = null;
let pingInterval = null;
let reconnectTimeout = null;
let staleTimer = null;

// Quản lý dữ liệu phiên cược
let currentSessionId = null;
let localCountdown = 50; // Đếm ngược cục bộ bằng giây
let snapshotted30 = false;
let snapshotted20 = false;
let frozenSnapshots = new Map(); // Lưu snapshot tạm thời chờ kết quả: sessionId -> record

// Biến điều khiển thuật toán Ensemble chuỗi sai tối đa <= 2
const WEIGHTS = [0.5, 0.3, -1.4, 0.9, -0.4, -1.9, 1.4, -0.3, 2, 0.4];
let consecLosses = 0;
let currentPrediction = null;
let prevSessionRecord = null;

// Hàm tính toán dự đoán dựa trên Ensemble và Phản hồi ngược
function getEnsemblePrediction(curr, prev, losses) {
  const preds = [];
  
  // 1. Cầu thuận
  const prevOutcome = prev && prev.ket_qua ? (prev.ket_qua === 'Tài' ? 1 : -1) : 1;
  preds.push(prevOutcome);
  
  // 2. Cầu nghịch
  preds.push(-prevOutcome);
  
  // 3. Thuận tiền 30s
  const p_thuantien30 = curr.snap_30 && curr.snap_30.tien_tai > curr.snap_30.tien_xiu ? 1 : -1;
  preds.push(p_thuantien30);
  
  // 4. Ngược tiền 30s
  preds.push(-p_thuantien30);
  
  // 5. Thuận tiền 20s
  const p_thuantien20 = curr.snap_20 && curr.snap_20.tien_tai > curr.snap_20.tien_xiu ? 1 : -1;
  preds.push(p_thuantien20);
  
  // 6. Ngược tiền 20s
  preds.push(-p_thuantien20);
  
  // 7. Thuận người 30s
  const p_thuanuser30 = curr.snap_30 && curr.snap_30.nguoi_tai > curr.snap_30.nguoi_xiu ? 1 : -1;
  preds.push(p_thuanuser30);
  
  // 8. Ngược người 30s
  preds.push(-p_thuanuser30);
  
  // 9. Thuận đà tiền (Acceleration)
  const diff_tai = curr.snap_30 && curr.snap_20 ? (curr.snap_20.tien_tai - curr.snap_30.tien_tai) : 0;
  const diff_xiu = curr.snap_30 && curr.snap_20 ? (curr.snap_20.tien_xiu - curr.snap_30.tien_xiu) : 0;
  const p_thuanda = diff_tai > diff_xiu ? 1 : -1;
  preds.push(p_thuanda);
  
  // 10. Ngược đà tiền
  preds.push(-p_thuanda);
  
  // Tính tổng điểm vote có trọng số
  let score = 0;
  for (let i = 0; i < 10; i++) {
    score += preds[i] * WEIGHTS[i];
  }
  
  let finalPred = score >= 0 ? 'Tài' : 'Xỉu';
  
  // Phản hồi ngược động (Invert) nếu chuỗi thua liên tiếp chạm ngưỡng 2
  if (losses >= 2) {
    finalPred = finalPred === 'Tài' ? 'Xỉu' : 'Tài';
  }
  
  return finalPred;
}

// Khởi chạy đồng bộ trạng thái khi Restart server
function loadHistoryAndSync() {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  if (!fs.existsSync(filePath)) {
    console.log('[🔋 Khởi động] Chưa có file lịch sử cược.');
    return;
  }
  
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.trim().split('\n').filter(Boolean);
    const records = lines.map(line => JSON.parse(line));
    
    if (records.length === 0) return;
    
    let prev = null;
    let tempLosses = 0;
    
    // Giả lập lại chuỗi dự đoán để xác định chính xác consecLosses hiện tại
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
    console.log(`[🔋 Khởi động] Đồng bộ thành công. Chuỗi thua hiện tại của Bot: ${consecLosses}`);
  } catch (e) {
    console.error('Lỗi đồng bộ lịch sử khởi động:', e.message);
  }
}

function connectWS() {
  if (ws) {
    ws.removeAllListeners();
    try { ws.close(); } catch (e) {}
  }

  console.log(`[${new Date().toLocaleTimeString()}] Đang kết nối tới WebSocket JSON...`);
  ws = new WebSocket(WS_URL, { headers: WS_HEADERS });

  ws.on('open', () => {
    console.log('[✅] WebSocket Connected! Đang gửi bản tin đăng ký...');
    
    INIT_MSGS.forEach((msg, i) => {
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }, i * 600);
    });

    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, 10000);

    resetStaleTimer();
  });

  ws.on('message', (raw) => {
    try {
      const text = raw.toString();
      const data = JSON.parse(text);
      if (!Array.isArray(data) || typeof data[1] !== 'object') return;
      
      const payload = data[1];
      const cmd = payload.cmd;

      // 1. Đồng bộ ban đầu khi nhận lịch sử phiên (cmd: 1005)
      if (cmd === 1005 && payload.sid) {
        currentSessionId = payload.sid;
        if (payload.rmT !== undefined) {
          localCountdown = Math.round(payload.rmT / 1000);
          snapshotted30 = localCountdown < 30;
          snapshotted20 = localCountdown < 20;
          
          if (!frozenSnapshots.has(currentSessionId)) {
            frozenSnapshots.set(currentSessionId, {
              phien: currentSessionId,
              snap_30: null,
              snap_20: null
            });
          }
          console.log(`[🔄 Khởi tạo] Đồng bộ thành công. Phiên #${currentSessionId}, còn lại: ${localCountdown}s`);
        }
      }

      // 2. Lắng nghe cập nhật giây đếm ngược theo thời gian thực (cmd: 1008)
      if (cmd === 1008 && payload.sid) {
        resetStaleTimer();

        // Phát hiện chuyển sang phiên cược mới
        if (payload.sid !== currentSessionId) {
          currentSessionId = payload.sid;
          localCountdown = 50;
          snapshotted30 = false;
          snapshotted20 = false;
          currentPrediction = null;
          
          frozenSnapshots.set(currentSessionId, {
            phien: currentSessionId,
            snap_30: null,
            snap_20: null
          });
          console.log(`[🎲 Phiên mới] #${currentSessionId} bắt đầu đếm ngược.`);
        } else {
          localCountdown--;
        }

        // Trích xuất số liệu cược
        if (payload.gi && payload.gi[0] && payload.gi[0].aid === 1) {
          const gameInfo = payload.gi[0];
          const taiMoney = gameInfo.B ? (gameInfo.B.tB || 0) : 0;
          const xiuMoney = gameInfo.S ? (gameInfo.S.tB || 0) : 0;
          const taiUsers = gameInfo.B ? (gameInfo.B.tU || 0) : 0;
          const xiuUsers = gameInfo.S ? (gameInfo.S.tU || 0) : 0;

          const record = frozenSnapshots.get(currentSessionId);
          if (record) {
            // Chốt dữ liệu ở giây thứ 30
            if (localCountdown === 30 && !snapshotted30) {
              snapshotted30 = true;
              record.snap_30 = {
                tien_tai: taiMoney,
                tien_xiu: xiuMoney,
                nguoi_tai: taiUsers,
                nguoi_xiu: xiuUsers,
                timestamp: new Date().toISOString()
              };
            }

            // Chốt dữ liệu ở giây thứ 20 -> TÍNH TOÁN DỰ ĐOÁN CHO PHIÊN NÀY
            if (localCountdown === 20 && !snapshotted20) {
              snapshotted20 = true;
              record.snap_20 = {
                tien_tai: taiMoney,
                tien_xiu: xiuMoney,
                nguoi_tai: taiUsers,
                nguoi_xiu: xiuUsers,
                timestamp: new Date().toISOString()
              };
              
              // Chạy mô hình dự đoán ngay khi có đủ snap_30 và snap_20
              const pred = getEnsemblePrediction(record, prevSessionRecord, consecLosses);
              currentPrediction = {
                phien: currentSessionId,
                du_doan: pred,
                chuoi_thua_hien_tai: consecLosses,
                timestamp: new Date().toISOString()
              };
              record.du_doan = pred;
              
              console.log(`[🔮 AI DỰ ĐOÁN] Phiên #${currentSessionId}: Đặt ${pred.toUpperCase()} (Độ lệch chuỗi thua: ${consecLosses})`);
            }
          }
        }
      }

      // 3. Nhận kết quả mở bát từ Server (cmd: 1003)
      if (cmd === 1003 && payload.d1 && payload.d2 && payload.d3) {
        resetStaleTimer();
        
        const d1 = payload.d1;
        const d2 = payload.d2;
        const d3 = payload.d3;
        const total = d1 + d2 + d3;
        const result = total > 10 ? 'Tài' : 'Xỉu';

        console.log(`[🎲 KẾT QUẢ] Phiên #${currentSessionId}: ${d1}-${d2}-${d3} = ${total} (${result})`);

        if (currentSessionId && frozenSnapshots.has(currentSessionId)) {
          const record = frozenSnapshots.get(currentSessionId);
          record.ket_qua = result;
          record.xuc_xac = `${d1}-${d2}-${d3}`;
          record.tong_diem = total;
          record.timestamp_ket_qua = new Date().toISOString();

          // Đánh giá dự đoán của phiên này để cập nhật consecLosses cho phiên sau
          if (record.du_doan) {
            if (record.du_doan === result) {
              console.log(`[🎯 ĐÚNG] Dự đoán chính xác! Reset chuỗi thua.`);
              consecLosses = 0;
            } else {
              consecLosses++;
              console.log(`[❌ SAI] Dự đoán chưa đúng. Chuỗi thua liên tiếp hiện tại: ${consecLosses}`);
            }
          }

          saveCompletedRecord(record);
          
          prevSessionRecord = record;
          frozenSnapshots.delete(currentSessionId);
        }
      }

    } catch (e) {
      console.error('[❌] Lỗi xử lý WS Message:', e.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[🔌] Kết nối bị đóng (Code: ${code}). Kết nối lại sau 2.5s...`);
    cleanup();
    reconnectTimeout = setTimeout(connectWS, 2500);
  });

  ws.on('error', (err) => {
    console.error('[❌] Lỗi WebSocket:', err.message);
    try { ws.close(); } catch (_) {}
  });
}

function resetStaleTimer() {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    console.log('[⚠️] Không nhận được cập nhật từ Server trong 90s, tiến hành Reconnect...');
    if (ws) ws.close();
  }, 90000);
}

function cleanup() {
  clearInterval(pingInterval);
  clearTimeout(staleTimer);
  clearTimeout(reconnectTimeout);
}

// Lưu bản ghi hoàn chỉnh
function saveCompletedRecord(record) {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  fs.appendFile(filePath, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('[❌] Lỗi ghi file lịch sử:', err.message);
  });
}

// ===== API ENDPOINTS =====

// Thêm endpoint nhận đồng bộ kết quả từ trình duyệt
app.post('/api/sync-result', (req, res) => {
  const { phien, ket_qua, xuc_xac, tong_diem, du_doan } = req.body;
  if (!phien || !ket_qua) {
    return res.status(400).json({ error: 'Thiếu thông tin phiên hoặc kết quả' });
  }

  const sessId = parseInt(phien);
  console.log(`[🔄 SYNC-RESULT] Nhận đồng bộ phiên #${sessId}: ${ket_qua} (${xuc_xac || ''})`);

  // Tìm trong snap tạm thời hoặc tạo mới record
  let record = frozenSnapshots.get(sessId);
  if (!record) {
    // Tìm trong file lịch sử xem đã có chưa
    const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
    let existed = false;
    if (fs.existsSync(filePath)) {
      try {
        const data = fs.readFileSync(filePath, 'utf8');
        if (data.includes(`"phien":${sessId}`)) {
          existed = true;
        }
      } catch (e) {}
    }

    if (existed) {
      return res.json({ status: 'existed', consecLosses });
    }

    record = {
      phien: sessId,
      snap_30: null,
      snap_20: null
    };
  }

  record.ket_qua = ket_qua;
  if (xuc_xac) record.xuc_xac = xuc_xac;
  if (tong_diem) record.tong_diem = parseInt(tong_diem);
  record.timestamp_ket_qua = new Date().toISOString();

  // Đánh giá dự đoán để cập nhật chuỗi thua consecLosses
  const predToCompare = record.du_doan || du_doan;
  if (predToCompare) {
    record.du_doan = predToCompare;
    if (predToCompare === ket_qua) {
      console.log(`[🎯 SYNC] Dự đoán phiên #${sessId} ĐÚNG. Reset chuỗi thua.`);
      consecLosses = 0;
    } else {
      consecLosses++;
      console.log(`[❌ SYNC] Dự đoán phiên #${sessId} SAI. Chuỗi thua hiện tại: ${consecLosses}`);
    }
  }

  saveCompletedRecord(record);
  prevSessionRecord = record;
  frozenSnapshots.delete(sessId);

  res.json({ status: 'ok', consecLosses });
});

// Lấy dự đoán của phiên hiện tại (tính toán ở giây 20 đếm ngược)
app.get('/api/prediction', (req, res) => {
  if (currentPrediction) {
    res.json(currentPrediction);
  } else {
    res.json({
      phien: currentSessionId,
      du_doan: "dang_doi_giay_20",
      mo_ta: "Đang chờ đến giây thứ 20 để thu thập đủ chỉ số cược"
    });
  }
});

// Lấy lịch sử dữ liệu thu thập
app.get('/api/history', (req, res) => {
  const filePath = process.env.DATA_PATH || path.join(__dirname, 'taixiu_data_history.json');
  if (!fs.existsSync(filePath)) {
    return res.json([]);
  }
  
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(500).json({ error: 'Lỗi đọc file lịch sử' });
    const lines = data.trim().split('\n').filter(Boolean);
    const records = lines.map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
    
    res.json(records.reverse());
  });
});

app.get('/', (req, res) => {
  res.json({
    name: "Sunwin Perfect Prediction API",
    status: "running",
    endpoints: {
      prediction: "/api/prediction",
      history: "/api/history"
    }
  });
});

// Khởi chạy đồng bộ trước khi mở cổng Server
loadHistoryAndSync();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[🌐] API Server đang chạy tại http://0.0.0.0:${PORT}`);
  connectWS();
});
