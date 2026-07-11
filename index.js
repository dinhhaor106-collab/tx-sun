const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Cấu hình WebSocket lấy từ thư mục test hoạt động 24/7 ổn định
const WS_URL = "wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0";
const WS_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://play.sun.win"
};

// Gói tin khởi tạo để đăng ký lắng nghe sự kiện từ Server
const INIT_MSGS = [
  [1, "MiniGame", "GM_apivopnha", "WangLin", {
    "info": "{\"ipAddress\":\"14.249.227.107\",\"wsToken\":\"eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJnZW5kZXIiOjAsImNhblZpZXdTdGF0IjpmYWxzZSwiZGlzcGxheU5hbWUiOiI5ODE5YW5zc3MiLCJib3QiOjAsImlzTWVyY2hhbnQiOmZhbHNlLCJ2ZXJpZmllZEJhbmtBY2NvdW50IjpmYWxzZSwicGxheUV2ZW50TG9iYnkiOmZhbHNlLCJjdXN0b21lcklkIjozMjMyODExNTEsImFmZklkIjoic3VuLndpbiIsImJhbm5lZCI6ZmFsc2UsImJyYW5kIjoiZ2VtIiwidGltZXN0YW1wIjoxNzYzMDMyOTI4NzcwLCJsb2NrR2FtZXMiOltdLCJhbW91bnQiOjAsImxvY2tDaGF0IjpmYWxzZSwicGhvbmVWZXJpZmllZCI6ZmFsc2UsImlwQWRkcmVzcyI6IjE0LjI0OS4yMjcuMTA3IiwibXV0ZSI6ZmFsc2UsImF2YXRhciI6Imh0dHBzOi8vaW1hZ2VzLnN3aW5zaG9wLm5ldC9pbWFnZXMvYXZhdGFyL2F2YXRhcl8wNS5wbmciLCJwbGF0Zm9ybUlkIjo0LCJ1c2VySWQiOiI4ODM4NTMzZS1kZTQzLTRiOGQtOTUwMy02MjFmNDA1MDUzNGUiLCJyZWdUaW1lIjoxNzYxNjMyMzAwNTc2LCJwaG9uZSI6IiIsImRlcG9zaXQiOmZhbHNlLCJ1c2VybmFtZSI6IkdNX2FwaXZvcG5oYSJ9.guH6ztJSPXUL1cU8QdMz8O1Sdy_SbxjSM-CDzWPTr-0\",\"locale\":\"vi\",\"userId\":\"8838533e-de43-4b8d-9503-621f4050534e\",\"username\":\"GM_apivopnha\",\"timestamp\":1763032928770,\"refreshToken\":\"e576b43a64e84f789548bfc7c4c8d1e5.7d4244a361e345908af95ee2e8ab2895\"}",
    "signature": "45EF4B318C883862C36E1B189A1DF5465EBB60CB602BA05FAD8FCBFCD6E0DA8CB3CE65333EDD79A2BB4ABFCE326ED5525C7D971D9DEDB5A17A72764287FFE6F62CBC2DF8A04CD8EFF8D0D5AE27046947ADE45E62E644111EFDE96A74FEC635A97861A425FF2B5732D74F41176703CA10CFEED67D0745FF15EAC1065E1C8BCBFA"
  }],
  [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
  [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

const TARGET_SECOND = parseInt(process.env.TARGET_SECOND) || 30; // Giây chốt dữ liệu (mặc định 30s)

let ws = null;
let pingInterval = null;
let reconnectTimeout = null;
let staleTimer = null;

// Quản lý dữ liệu phiên cược
let currentSessionId = null;
let frozenSnapshots = new Map(); // Lưu snapshot tạm thời chờ kết quả: sessionId -> snapshotData

function connectWS() {
  if (ws) {
    ws.removeAllListeners();
    try { ws.close(); } catch (e) {}
  }

  console.log(`[${new Date().toLocaleTimeString()}] Đang kết nối tới WebSocket JSON...`);
  ws = new WebSocket(WS_URL, { headers: WS_HEADERS });

  ws.on('open', () => {
    console.log('[✅] WebSocket Connected! Đang gửi các bản tin đăng ký...');
    
    // Gửi lần lượt các gói tin khởi tạo cách nhau 600ms
    INIT_MSGS.forEach((msg, i) => {
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }, i * 600);
    });

    // Cài đặt chu kỳ Ping/Pong
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.ping();
    }, 10000);

    // Cài đặt Stale Timer đề phòng nghẽn mạng
    resetStaleTimer();
  });

  ws.on('pong', () => {
    // console.log('[📶] Ping-Pong OK');
  });

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      // Gói tin hợp lệ luôn là một mảng: [channelId, namespace, payload] hoặc tương tự
      if (!Array.isArray(data) || typeof data[1] !== 'object') return;
      
      const payload = data[1];
      const cmd = payload.cmd;

      // In toàn bộ gói tin để phân tích nếu cần cấu trúc các trường ẩn
      // console.log("Gói tin:", JSON.stringify(payload));

      // 1. Cập nhật mã phiên cược hiện tại (Mã 1008 hoặc từ các cập nhật khác)
      if (payload.sid) {
        currentSessionId = payload.sid;
      }

      // 2. Lắng nghe trạng thái đếm ngược và số liệu tiền cược
      // cmd: 1001, 1002 hoặc các cập nhật trạng thái khác có chứa thời gian và tiền cược
      if (cmd && (cmd === 1001 || cmd === 1002 || payload.time !== undefined || payload.remainTimeToBetting !== undefined)) {
        resetStaleTimer();

        const time = payload.time !== undefined ? payload.time : payload.remainTimeToBetting;
        const taiMoney = payload.tai !== undefined ? payload.tai : (payload.currentTaiMoney || 0);
        const xiuMoney = payload.xiu !== undefined ? payload.xiu : (payload.currentXiuMoney || 0);
        const taiUsers = payload.numTai !== undefined ? payload.numTai : (payload.taiPlayersCount || 0);
        const xiuUsers = payload.numXiu !== undefined ? payload.numXiu : (payload.xiuPlayersCount || 0);

        // Chốt dữ liệu khi thời gian đếm ngược chạm mốc TARGET_SECOND
        if (time === TARGET_SECOND && currentSessionId) {
          if (!frozenSnapshots.has(currentSessionId)) {
            const snapshot = {
              phien: currentSessionId,
              giay_chot: TARGET_SECOND,
              tien_tai: taiMoney,
              tien_xiu: xiuMoney,
              nguoi_tai: taiUsers,
              nguoi_xiu: xiuUsers,
              timestamp_chot: new Date().toISOString()
            };
            frozenSnapshots.set(currentSessionId, snapshot);
            console.log(`[📌 CHỐT GIÂY ${TARGET_SECOND}] Phiên #${currentSessionId}: Tài ${taiMoney.toLocaleString()}đ (${taiUsers} ng) | Xỉu ${xiuMoney.toLocaleString()}đ (${xiuUsers} ng)`);
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

        // Lấy lại phiên cược vừa kết thúc (nếu payload.sid không có thì lấy currentSessionId)
        const finishedSession = payload.sid || currentSessionId;

        console.log(`[🎲 KẾT QUẢ] Phiên #${finishedSession}: ${d1}-${d2}-${d3} = ${total} (${result})`);

        // Khớp kết quả với snapshot đã chốt ở giây 30
        if (finishedSession && frozenSnapshots.has(finishedSession)) {
          const record = frozenSnapshots.get(finishedSession);
          record.ket_qua = result;
          record.xuc_xac = `${d1}-${d2}-${d3}`;
          record.tong_diem = total;
          record.timestamp_ket_qua = new Date().toISOString();

          // Lưu kết quả hoàn chỉnh
          saveCompletedRecord(record);
          
          // Xóa khỏi map tạm thời
          frozenSnapshots.delete(finishedSession);
        }
      }

    } catch (e) {
      console.error('[❌] Lỗi xử lý WS Message:', e.message);
    }
  });

  ws.on('close', (code) => {
    console.log(`[🔌] Kết nối bị đóng (Code: ${code}). Đang thử kết nối lại sau 2.5 giây...`);
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
  // Nếu quá 90 giây không nhận được gói tin thời gian nào từ game, tự ngắt để Reconnect
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

// Lưu bản ghi hoàn chỉnh vào file JSON
function saveCompletedRecord(record) {
  const filePath = path.join(__dirname, 'taixiu_data_history.json');
  
  // Format log hiển thị ra console của Railway
  console.log(`[💾 LƯU BẢN GHI] Phiên #${record.phien} | Chốt: T:${record.tien_tai.toLocaleString()}đ / X:${record.tien_xiu.toLocaleString()}đ | Kết quả: ${record.ket_qua} (${record.xuc_xac})`);

  fs.appendFile(filePath, JSON.stringify(record) + '\n', (err) => {
    if (err) console.error('[❌] Lỗi ghi file lịch sử:', err.message);
  });
}

// Bắt đầu kết nối
connectWS();
