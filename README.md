# MSSQL -> LINE 股票交易訊號監控機器人

這是一個 Node.js 應用程式，監控 MS SQL 資料庫中的股票交易訊號，並透過 LINE Bot 推送通知給訂閱用戶。支援股票訂閱功能和 Flex Message 模板。

## 功能特色

- 🔍 **自動監控**: 定期輪詢 MSSQL 資料表，偵測新的交易訊號
- 📱 **LINE 推播**: 透過 LINE Bot API 推送訊息給訂閱用戶
- 📊 **Flex Message**: 支援買入/賣出的精美卡片式訊息模板
- 🎯 **股票訂閱**: 用戶可訂閱特定股票代號，只接收相關訊號
- 🔗 **Webhook 支援**: 處理 LINE 用戶互動訊息
- 💾 **用戶管理**: 自動儲存用戶 ID 並管理訂閱清單

## 快速開始

### 1. 安裝相依套件

```bash
npm install
```

### 2. 設定環境變數

複製 `.env.example` 為 `.env` 並填入設定值：

```bash
cp .env.example .env
```

### 3. 啟動應用程式

```bash
npm start
# 或
node index.js
```

## 環境變數設定

| 變數名稱 | 說明 | 預設值 |
|---------|------|--------|
| `MSSQL_HOST` | MSSQL 伺服器位址 | localhost |
| `MSSQL_PORT` | MSSQL 連接埠 | 1433 |
| `MSSQL_USER` | 資料庫使用者名稱 | sa |
| `MSSQL_PASSWORD` | 資料庫密碼 | |
| `MSSQL_DATABASE` | 主要資料庫名稱 | market_stock_tw |
| `MSSQL_TABLE` | 交易訊號資料表 | trade_signals_1d |
| `USER_DATA_DATABASE` | 用戶資料庫名稱 | user_data |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Bot 存取權杖 | |
| `LINE_CHANNEL_SECRET` | LINE Bot 頻道密鑰 | |
| `POLL_INTERVAL` | 輪詢間隔（秒） | 10 |
| `ID_COLUMN` | 主鍵欄位名稱 | id |
| `SIGNAL_COLUMN` | 交易訊號欄位名稱 | Trade_Signal |
| `MESSAGE_TEMPLATE` | 訊息模板 | 【{{symbol}}】{{Trade_Signal}} at {{close_price}} |
| `PORT` | 伺服器連接埠 | 3000 |

## 資料庫結構

### 用戶訂閱資料表

在 `user_data` 資料庫中執行以下 SQL 建立訂閱資料表：

```sql
CREATE TABLE Subscriptions (
  Id INT IDENTITY(1,1) PRIMARY KEY,
  UserId NVARCHAR(100) NOT NULL,
  StockCode NVARCHAR(50) NOT NULL,
  CreatedAt DATETIME2 NOT NULL
);
```

## 使用方式

### 股票訂閱功能

1. **訂閱股票**: 在 LINE 聊天室中傳送 `訂閱股票`
2. **輸入代號**: Bot 會要求輸入股票代號（例如：2330）
3. **確認訂閱**: 系統會儲存訂閱並回覆確認訊息
4. **取消訂閱**: 傳送 `取消訂閱股票` 並輸入代號或「全部」

### Webhook 端點

- `/webhook`: 正式環境，需要簽章驗證
- `/webhook-dev`: 開發環境，設定 `ALLOW_UNVERIFIED_WEBHOOK=true` 啟用

## 專案結構

```
line-bot/
├── template/           # Flex Message 模板
│   ├── buy.json        # 買入訊號模板
│   └── sell.json       # 賣出訊號模板
├── .env.example        # 環境變數範例
├── config.js           # 設定檔
├── index.js            # 主程式
├── users.json          # 用戶 ID 清單
└── webhook.log         # Webhook 日誌
```

## 注意事項

- 用戶狀態追蹤使用記憶體 Map，重啟後會遺失。生產環境建議使用 Redis 或資料庫
- 確保 MSSQL 伺服器允許應用程式連線，且用戶具備適當權限
- LINE 頻道密鑰和資料庫憑證請妥善保管，勿提交至版本控制
- 支援多股票代號同時訂閱，以逗號或空格分隔

## 技術規格

- **Node.js**: 使用 CommonJS 模組系統
- **資料庫**: Microsoft SQL Server
- **LINE SDK**: @line/bot-sdk v10.3.0
- **Web 框架**: Express v5.1.0
- **環境管理**: dotenv