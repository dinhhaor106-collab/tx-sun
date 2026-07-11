const WebSocket = require('ws');
const axios = require('axios');
const msgpack = require('msgpack-lite');
const fs = require('fs');
const path = require('path');

// Cấu hình thông tin đã quét được từ game
const API_URL = 'https://api.azhkthg1.com/id'; // URL lấy token
const WS_URL_TEMPLATE = 'wss://ws-lby.azhkthg1.net/wsbinary?token=';

// Thông tin tài khoản của bạn
const USERNAME = process.env.GAME_USERNAME || 'SC_nguyennhan111';
const PASSWORD = process.env.GAME_PASSWORD || 'dinhvuhao4';
const DEVICE_ID = process.env.DEVICE_ID || 'EXE0nuDsMp4k4zEk0cS4';
const REFRESH_TOKEN = process.env.REFRESH_TOKEN || 'ff606ac676ae47429b0ea73c985a9840.e9c84c5a58df483b9bc78ddb2ef5c66c';

const TARGET_SECOND = parseInt(process.env.TARGET_SECOND) || 30; // Giây chốt (mặc định 30s)

let ws = null;
let currentSession = null;
let isFrozen = false;
let frozenData = null;

// Hàm tự động gửi yêu cầu đổi Refresh Token để lấy mã JWT WebSocket mới
async function getNewToken() {
    try {
        console.log(`[${new Date().toLocaleTimeString()}] Đang gửi yêu cầu làm mới Token...`);
        
        // Gửi payload giống cấu hình của game lên API
        const payload = {
            username: USERNAME,
            password: PASSWORD,
            deviceId: DEVICE_ID,
            refreshToken: REFRESH_TOKEN
        };

        const response = await axios.post(API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        if (response.data && response.data.data && response.data.data.wsToken) {
            console.log('Lấy JWT Token mới thành công.');
            return response.data.data.wsToken;
        } else {
            throw new Error('Không lấy được wsToken. Response: ' + JSON.stringify(response.data));
        }
    } catch (error) {
        console.error('Lỗi API Login/Refresh:', error.message);
        return null;
    }
}

// Hàm khởi tạo và duy trì kết nối WebSocket
async function startConnection() {
    const token = await getNewToken();
    if (!token) {
        console.log('Đăng nhập thất bại, thử lại sau 30 giây...');
        setTimeout(startConnection, 30000);
        return;
    }

    const wsUrl = `${WS_URL_TEMPLATE}${token}`;
    console.log(`Đang kết nối tới WebSocket binary...`);

    ws = new WebSocket(wsUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    ws.on('open', () => {
        console.log('Kết nối thành công! Đang tự động thu thập dữ liệu cược...');
    });

    ws.on('message', (data) => {
        try {
            // Giải nén gói tin nhị phân bằng MessagePack
            const decoded = msgpack.decode(data);
            handleIncomingMessage(decoded);
        } catch (e) {
            // Bỏ qua nếu gói tin không phải định dạng msgpack hợp lệ
        }
    });

    ws.on('close', () => {
        console.log('Mất kết nối WebSocket. Đang tự động kết nối lại sau 5 giây...');
        setTimeout(startConnection, 5000);
    });

    ws.on('error', (error) => {
        console.error('Lỗi đường truyền WebSocket:', error.message);
    });
}

// Hàm phân tích gói tin nhận về từ game
function handleIncomingMessage(msg) {
    if (msg && msg.lblSession) {
        const session = msg.lblSession.replace('#', '').trim();
        const time = parseInt(msg.remainTimeToBetting) || 0;

        const taiMoney = parseInt(msg.currentTaiMoney) || 0;
        const xiuMoney = parseInt(msg.currentXiuMoney) || 0;
        const taiUsers = parseInt(msg.taiPlayersCount) || 0;
        const xiuUsers = parseInt(msg.xiuPlayersCount) || 0;

        // Reset trạng thái khi chuyển sang phiên cược mới
        if (session !== currentSession) {
            currentSession = session;
            isFrozen = false;
            frozenData = null;
            console.log(`[Phiên mới] #${session} bắt đầu.`);
        }

        // Chốt số liệu tại giây chỉ định
        if (time <= TARGET_SECOND && time > 0 && !isFrozen) {
            isFrozen = true;
            frozenData = {
                timestamp: new Date().toISOString(),
                session: session,
                targetSec: TARGET_SECOND,
                actualSec: time,
                taiMoney: taiMoney,
                xiuMoney: xiuMoney,
                taiUsers: taiUsers,
                xiuUsers: xiuUsers
            };
            
            saveData(frozenData);
        }
    }
}

// Hàm lưu dữ liệu chốt xuống file JSON cục bộ trên Railway
function saveData(data) {
    const filePath = path.join(__dirname, 'taixiu_data_history.json');
    console.log(`[ĐÃ CHỐT GIÂY ${data.actualSec}s] Phiên #${data.session}: TÀI ${data.taiMoney}đ | XỈU ${data.xiuMoney}đ`);
    
    fs.appendFile(filePath, JSON.stringify(data) + '\n', (err) => {
        if (err) console.error('Lỗi khi ghi dữ liệu:', err.message);
    });
}

// Bắt đầu chạy bot
startConnection();
