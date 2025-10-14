const sql = require("mssql");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');
const dotenv = require('dotenv');
dotenv.config();
const config = require("./config");

const lineClient = new line.Client({
  channelAccessToken: config.line.channelAccessToken,
});

// create express app and line middleware for webhook handling
const express = require('express');
const { middleware: lineMiddleware } = line;

const app = express();
// Do NOT use a global JSON body parser before the LINE middleware. LINE middleware
// needs the raw body to verify the signature.

// Load user IDs from users.json
function loadUserIds() {
  const usersFile = path.join(__dirname, 'users.json');
  try {
    const content = fs.readFileSync(usersFile, 'utf8');
    // 去除空白與換行，並過濾掉空字串
    return content
      ? JSON.parse(content).map(u => String(u).trim()).filter(u => !!u)
      : [];
  } catch (e) {
    return [];
  }
}

// Helper to persist user IDs into users.json (avoid duplicates)
function saveUserIdToFile(userId) {
  const usersFile = path.join(__dirname, 'users.json');
  let users = [];
  try {
    const content = fs.readFileSync(usersFile, 'utf8');
    users = content ? JSON.parse(content) : [];
  } catch (e) {
    // if file missing or empty, start with empty array
    users = [];
  }

  if (!users.includes(userId)) {
    users.push(userId);
    try {
      fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), 'utf8');
      console.log('Saved new userId to users.json ->', userId);
    } catch (e) {
      console.error('Failed writing users.json:', e && e.message ? e.message : e);
    }
  } else {
    console.debug('userId already present, skipping save ->', userId);
  }
}

let lastSeenId = null;
let seenSignalValue = null; // to avoid duplicate pushes if same signal repeats
// Shared DB pool to avoid creating multiple pools
let dbPool = null;
// separate pool for user DB (subscriptions)
let userDbPool = null;

// Load Flex templates (buy/sell)
const templateDir = path.join(__dirname, "template");
let buyTemplate = null;
let sellTemplate = null;
try {
  buyTemplate = JSON.parse(
    fs.readFileSync(path.join(templateDir, "buy.json"), "utf8")
  );
} catch (e) {
  console.warn("Could not load buy template:", e && e.message ? e.message : e);
}

// In-memory pending state for conversation flows (from send.js)
const pending = new Map(); // userId -> state (true or { unsubscribe: true })

// helper DB functions for subscriptions (adapted from send.js)
async function saveSubscription(userId, stockCode) {
  const pool = await connectUserDB();
  // make sure Subscriptions table exists to avoid runtime errors when handling subscription flows
  await ensureSubscriptionsTable(pool);
  const request = pool.request();
  await request
    .input("userId", sql.NVarChar(100), userId)
    .input("stockCode", sql.NVarChar(50), stockCode)
    .input("createdAt", sql.DateTime2, new Date())
    .query(
      `INSERT INTO [dbo].[Subscriptions] (UserId, StockCode, CreatedAt) VALUES (@userId, @stockCode, @createdAt)`
    );
}

async function subscriptionExists(userId, stockCode) {
  const pool = await connectUserDB();
  await ensureSubscriptionsTable(pool);
  const request = pool.request();
  const result = await request
    .input("userId", sql.NVarChar(100), userId)
    .input("stockCode", sql.NVarChar(50), stockCode)
    .query(`SELECT COUNT(1) AS cnt FROM [dbo].[Subscriptions] WHERE UserId = @userId AND StockCode = @stockCode`);
  const cnt = result && result.recordset && result.recordset[0] && result.recordset[0].cnt;
  return cnt > 0;
}

async function deleteSubscription(userId, stockCode) {
  const pool = await connectUserDB();
  await ensureSubscriptionsTable(pool);
  const request = pool.request();
  const result = await request
    .input("userId", sql.NVarChar(100), userId)
    .input("stockCode", sql.NVarChar(50), stockCode)
    .query(`DELETE FROM [dbo].[Subscriptions] WHERE UserId = @userId AND StockCode = @stockCode`);
  return (result && result.rowsAffected && result.rowsAffected[0]) || 0;
}

async function deleteAllSubscriptions(userId) {
  const pool = await connectUserDB();
  await ensureSubscriptionsTable(pool);
  const request = pool.request();
  const result = await request
    .input("userId", sql.NVarChar(100), userId)
    .query(`DELETE FROM [dbo].[Subscriptions] WHERE UserId = @userId`);
  return (result && result.rowsAffected && result.rowsAffected[0]) || 0;
}
try {
  sellTemplate = JSON.parse(
    fs.readFileSync(path.join(templateDir, "sell.json"), "utf8")
  );
} catch (e) {
  console.warn("Could not load sell template:", e && e.message ? e.message : e);
}

// Recursively render templates inside an object (replace {{key}} in string values)
function renderTemplateInObject(obj, row) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return obj.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
      const k = key.trim();
      return row[k] != null ? String(row[k]) : "";
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((o) => renderTemplateInObject(o, row));
  }
  if (typeof obj === "object") {
    const res = {};
    for (const k of Object.keys(obj)) {
      res[k] = renderTemplateInObject(obj[k], row);
    }
    return res;
  }
  return obj;
}

// Global handlers to capture otherwise-silent crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  // don't exit immediately to allow logs to flush; if you want to crash, uncomment next line
  // process.exit(1);
});

async function connectDB() {
  if (dbPool) return dbPool;

  const pool = new sql.ConnectionPool({
    user: config.mssql.user,
    password: config.mssql.password,
    server: config.mssql.host,
    port: config.mssql.port,
    database: config.mssql.database,
    options: {
      encrypt: false,
      enableArithAbort: true,
    },
  });

  pool.on("error", (err) => {
    console.error("MSSQL pool error", err);
  });

  await pool.connect();
  dbPool = pool;
  return dbPool;
}

async function connectUserDB() {
  if (userDbPool) return userDbPool;
  const userCfg = config.userDb || {};
  const pool = new sql.ConnectionPool({
    user: userCfg.user,
    password: userCfg.password,
    server: userCfg.host,
    port: userCfg.port,
    database: userCfg.database,
    options: {
      encrypt: userCfg.options && userCfg.options.encrypt,
      enableArithAbort: true,
    },
  });
  pool.on('error', (err) => console.error('User DB pool error', err));
  await pool.connect();
  userDbPool = pool;
  return userDbPool;
}

// Ensure Subscriptions table exists (create if missing)
async function ensureSubscriptionsTable(pool) {
  try {
    const createSql = `IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[Subscriptions]') AND type in (N'U'))
BEGIN
  CREATE TABLE dbo.Subscriptions (
    Id INT IDENTITY(1,1) PRIMARY KEY,
    UserId NVARCHAR(100) NOT NULL,
    StockCode NVARCHAR(50) NOT NULL,
    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE UNIQUE INDEX UX_Subscriptions_UserId_StockCode ON dbo.Subscriptions(UserId, StockCode);
END`;
    await pool.request().query(createSql);
    console.log('Ensured Subscriptions table exists (or already existed)');
  } catch (err) {
    console.warn('Could not ensure Subscriptions table:', err && err.message ? err.message : err);
  }
}

function buildQuery() {
  const table = `[${config.mssql.table}]`;
  const id = `[${config.mssql.idColumn}]`;
  const time = config.mssql.timeColumn ? `[${config.mssql.timeColumn}]` : null;

  let where = "";
  if (config.mssql.filterClause) {
    where = `WHERE ${config.mssql.filterClause}`;
  }

  if (lastSeenId !== null) {
    // prefer ID-based
    where = where
      ? `${where} AND ${id} > @lastSeenId`
      : `WHERE ${id} > @lastSeenId`;
  }

  const orderBy = time ? `${time} ASC` : `${id} ASC`;

  const q = `SELECT * FROM ${table} ${where} ORDER BY ${orderBy}`;
  return q;
}

function renderTemplate(template, row) {
  return template.replace(/{{\s*([^}]+)\s*}}/g, (_, key) => {
    const k = key.trim();
    return row[k] != null ? row[k] : "";
  });
}

async function poll(pool) {
  try {
    // We'll only fetch the latest row (TOP 1) ordered by id desc
    const request = pool.request();
    const table = `[${config.mssql.table}]`;
    const idCol = `[${config.mssql.idColumn}]`;
    const sigCol = `[${config.signalColumn}]`;

    // Build query to fetch the latest row
    let q = `SELECT TOP 1 * FROM ${table}`;
    if (config.mssql.filterClause) q += ` WHERE ${config.mssql.filterClause}`;
    q += ` ORDER BY ${idCol} DESC`;

    console.debug("SQL Query (latest only):", q);
    const res = await request.query(q);
    const row = res.recordset && res.recordset.length ? res.recordset[0] : null;
    if (!row) return;

    // If configured id column is not present or is not the numeric PK, try to fall back to 'id'
    if (row[config.mssql.idColumn] === undefined && row.id !== undefined) {
      console.warn(
        `Configured ID column '${config.mssql.idColumn}' not found in row; falling back to 'id'`
      );
      config.mssql.idColumn = "id";
    }

    const idVal = row[config.mssql.idColumn];
    const signalVal = row[config.signalColumn];

    console.debug("Latest row id=", idVal, "signal=", signalVal);

    // Only send when the signal column has a non-empty value and it's a new id
    const hasSignal =
      signalVal !== null &&
      signalVal !== undefined &&
      String(signalVal).trim() !== "";
    const isNew =
      lastSeenId === null
        ? true
        : typeof idVal === "number"
        ? idVal > lastSeenId
        : String(idVal) !== String(lastSeenId);

    if (hasSignal && isNew) {
      // Also avoid pushing if the same signal value already seen for the same id
      if (
        seenSignalValue &&
        String(seenSignalValue) === String(signalVal) &&
        lastSeenId === idVal
      ) {
        console.debug("Signal value unchanged for same id; skipping push");
      } else {
        // Choose template based on signal value (common options: 'buy'/'sell', also handle Chinese '買'/'賣')
        const sv = String(signalVal).trim().toLowerCase();
        let messageToSend = null;

        if (
          (sv === "buy" || sv === "b" || sv.indexOf("買") !== -1) &&
          buyTemplate
        ) {
          const rendered = renderTemplateInObject(buyTemplate, row);
          messageToSend = {
            type: "flex",
            altText: renderTemplate(config.line.messageTemplate, row),
            contents: rendered,
          };
        } else if (
          (sv === "sell" || sv === "s" || sv.indexOf("賣") !== -1) &&
          sellTemplate
        ) {
          const rendered = renderTemplateInObject(sellTemplate, row);
          messageToSend = {
            type: "flex",
            altText: renderTemplate(config.line.messageTemplate, row),
            contents: rendered,
          };
        } else {
          // fallback to text template
          const text = renderTemplate(config.line.messageTemplate, row);
          messageToSend = { type: "text", text };
        }

        console.log(
          "Sending LINE message for latest row with signal=",
          signalVal
        );
        // Try to determine stock code field from the row using common names
        const possibleKeys = ['symbol', 'Symbol', 'stock', 'StockCode', 'stockCode', 'symbolCode', 'code'];
        let stockCode = null;
        for (const k of possibleKeys) {
          if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
            stockCode = String(row[k]).trim();
            break;
          }
        }

        if (stockCode) {
          await sendToSubscribers(messageToSend, stockCode);
        } else {
          // fallback: broadcast to all saved users
          await sendLineMessage(messageToSend);
        }
        seenSignalValue = signalVal;
      }

      // Update lastSeenId after sending
      if (typeof idVal === "number") {
        lastSeenId = idVal;
      } else if (idVal instanceof Date) {
        lastSeenId = idVal;
      } else {
        lastSeenId = idVal;
      }
    } else {
      console.debug(
        "No new signal to send (hasSignal=",
        hasSignal,
        ", isNew=",
        isNew,
        ")"
      );
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
}

async function sendLineMessage(text) {
  if (!config.line.channelAccessToken) {
    console.warn("LINE credentials missing; skipping send.");
    return;
  }

  const userIds = loadUserIds();
  if (!userIds.length) {
    console.warn("No user IDs found in users.json; skipping send.");
    return;
  }

  await new Promise((r) => setTimeout(r, config.sendDelayMs || 200));
  const message = typeof text === "string" ? { type: "text", text } : text;

  for (const userId of userIds) {
    console.log(`推送訊息給 userId: ${userId}`); // 新增 log
    let attempt = 0;
    while (attempt <= (config.lineMaxRetries || 5)) {
      try {
        const res = await lineClient.pushMessage(userId, message);
        console.debug(`LINE push response for user ${userId}:`, res);
        break;
      } catch (err) {
        attempt += 1;
        const status =
          err && err.statusCode
            ? err.statusCode
            : err && err.status
            ? err.status
            : null;
        console.warn(
          `LINE send attempt ${attempt} failed for user ${userId}`,
          status || "",
          err && err.message ? err.message : err
        );

        // if rate limited, exponential backoff
        if (status === 429 && attempt <= (config.lineMaxRetries || 5)) {
          const wait = (config.lineRetryBaseMs || 500) * Math.pow(2, attempt - 1);
          console.log(
            `Rate limited. Backing off ${wait}ms before retrying (attempt ${attempt})`
          );
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.error(`LINE send error for user ${userId}:`, err); // 顯示 userId
        break;
      }
    }
  }
}

// Query subscriptions table for users subscribed to a particular stock code
async function getSubscribersByStock(stockCode) {
  try {
    const pool = await connectUserDB();
    await ensureSubscriptionsTable(pool);
    const request = pool.request();
    const res = await request
      .input('stockCode', sql.NVarChar(50), stockCode)
      .query(`SELECT UserId FROM [dbo].[Subscriptions] WHERE StockCode = @stockCode`);
    if (!res.recordset) return [];
    return res.recordset.map(r => String(r.UserId).trim()).filter(u => !!u);
  } catch (err) {
    console.error('Failed to query subscribers for', stockCode, err && err.message ? err.message : err);
    return [];
  }
}

// Send a message only to users subscribed to the given stockCode. Falls back to global push
async function sendToSubscribers(message, stockCode) {
  if (!config.line.channelAccessToken) {
    console.warn('LINE credentials missing; skipping send.');
    return;
  }

  // if stockCode not provided, fallback to broadcasting to all users
  if (!stockCode) {
    return sendLineMessage(message);
  }

  const userIds = await getSubscribersByStock(stockCode);
  if (!userIds || !userIds.length) {
    console.log(`No subscribers found for ${stockCode}; skipping push`);
    return;
  }

  await new Promise((r) => setTimeout(r, config.sendDelayMs || 200));

  for (const userId of userIds) {
    console.log(`推播給訂閱 ${stockCode} 的 userId: ${userId}`);
    let attempt = 0;
    while (attempt <= (config.lineMaxRetries || 5)) {
      try {
        const res = await lineClient.pushMessage(userId, typeof message === 'string' ? { type: 'text', text: message } : message);
        console.debug(`LINE push response for user ${userId}:`, res);
        break;
      } catch (err) {
        attempt += 1;
        const status = err && err.statusCode ? err.statusCode : err && err.status ? err.status : null;
        console.warn(`LINE send attempt ${attempt} failed for user ${userId}`, status || '', err && err.message ? err.message : err);
        if (status === 429 && attempt <= (config.lineMaxRetries || 5)) {
          const wait = (config.lineRetryBaseMs || 500) * Math.pow(2, attempt - 1);
          console.log(`Rate limited. Backing off ${wait}ms before retrying (attempt ${attempt})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.error(`LINE send error for user ${userId}:`, err);
        break;
      }
    }
  }
}

// Webhook route to accept LINE events (needs channelSecret configured)
// We'll implement two webhook routes:
//  - /webhook: verifies signature using channelSecret and expects raw body
//  - /webhook-dev: optional dev route that accepts JSON without signature when ALLOW_UNVERIFIED_WEBHOOK=true
if (config.line.channelSecret) {
  app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-line-signature'];
    const body = req.body; // Buffer

    try {
      if (!signature) {
        console.warn('No x-line-signature header');
        return res.status(400).send('Missing signature');
      }

      const computed = crypto.createHmac('sha256', config.line.channelSecret).update(body).digest('base64');

      const sigBuf = Buffer.from(signature);
      const compBuf = Buffer.from(computed);
      if (sigBuf.length !== compBuf.length || !crypto.timingSafeEqual(sigBuf, compBuf)) {
        console.error('Signature validation failed', { signature, computed });
        return res.status(401).send('SignatureValidationFailed');
      }

      const parsed = JSON.parse(body.toString());
      const events = parsed.events || [];
      try {
        fs.appendFileSync(path.join(__dirname, 'webhook.log'), `[${new Date().toISOString()}] /webhook events=${events.length} body=${JSON.stringify(parsed)}\n`);
      } catch (e) {
        console.error('Failed to append webhook.log', e && e.message ? e.message : e);
      }

      // handle events concurrently but don't let one failure crash the handler
      const results = await Promise.allSettled(events.map(handleEvent));
      const normalized = results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) }));
      return res.json(normalized);
    } catch (err) {
      console.error('Webhook processing error:', err);
      return res.status(500).send('Internal Server Error');
    }
  });

  console.log('Webhook /webhook enabled (signature verification)');
} else {
  console.warn('LINE channel secret not configured; webhook endpoint not started. Set LINE_CHANNEL_SECRET in environment to enable it.');
}

// Development helper: allow posting to /webhook-dev without signature verification
// Enable by setting ALLOW_UNVERIFIED_WEBHOOK=true in .env (do NOT enable in production)
if (process.env.ALLOW_UNVERIFIED_WEBHOOK === 'true') {
  app.post('/webhook-dev', express.json(), async (req, res) => {
    const events = req.body && req.body.events ? req.body.events : [];
    console.log('Dev webhook /webhook-dev called - events:', events && events.length ? events.length : 0);
    try {
      fs.appendFileSync(path.join(__dirname, 'webhook.log'), `[${new Date().toISOString()}] /webhook-dev events=${events.length} body=${JSON.stringify(req.body)}\n`);
    } catch (e) {
      console.error('Failed to append webhook.log', e && e.message ? e.message : e);
    }
    // handle events
    const results = await Promise.allSettled(events.map(handleEvent));
    const normalized = results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason) }));
    res.json(normalized);
  });
  console.log('Dev unverified webhook /webhook-dev enabled (ALLOW_UNVERIFIED_WEBHOOK=true)');
}

// shared event handler logic (from send.js)
async function handleEvent(event) {
  try {
    if (event.type === 'follow' && event.source && event.source.userId) {
      saveUserIdToFile(event.source.userId);
      return { ok: true };
    }

    if (event.type !== 'message' || !event.message || event.message.type !== 'text') {
      return { ok: true };
    }

    const userId = event.source.userId;
    const userMessage = event.message.text && event.message.text.trim();

    console.log('使用者ID:', userId);
    console.log('訊息內容:', userMessage);

    if (userMessage === '訂閱股票') {
      pending.set(userId, true);
      const reply = { type: 'text', text: '請輸入要訂閱的股票代號（例如 2330）：' };
      await lineClient.replyMessage(event.replyToken, reply);
      return { ok: true };
    }

    if (userMessage === '取消訂閱股票') {
      pending.set(userId, { unsubscribe: true });
      await lineClient.replyMessage(event.replyToken, { type: 'text', text: '請輸入要取消訂閱的股票代號（例如 2330, 或輸入「全部」以取消所有訂閱）：' });
      return { ok: true };
    }

    if (pending.has(userId)) {
      const state = pending.get(userId);
      const raw = userMessage || '';
      const parts = raw.split(/[;,\s，、]+/).map((p) => p.trim()).filter(Boolean);

      if (parts.length === 0) {
        await lineClient.replyMessage(event.replyToken, { type: 'text', text: '未偵測到有效的股票代號，請重新輸入（例如：2330 或可同時輸入 2330, 9950）：' });
        return { ok: true };
      }

      const MAX_CODES = 20;
      if (parts.length > MAX_CODES) {
        await lineClient.replyMessage(event.replyToken, { type: 'text', text: `一次最多只能訂閱 ${MAX_CODES} 個代號，請分批輸入。` });
        return { ok: true };
      }

      const validRegex = /^[A-Za-z0-9\.\-]{1,20}$/;
      const uniqueCodes = Array.from(new Set(parts.map((p) => p.toUpperCase())));

      if (state && state.unsubscribe && uniqueCodes.length === 1 && (uniqueCodes[0] === '全部' || uniqueCodes[0] === 'ALL')) {
        try {
          const count = await deleteAllSubscriptions(userId);
          const msg = count > 0 ? `已取消所有訂閱，共 ${count} 筆。` : `找不到任何訂閱可以取消。`;
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: msg });
        } catch (err) {
          console.error('Failed to delete all subscriptions:', err);
          await lineClient.replyMessage(event.replyToken, { type: 'text', text: '刪除所有訂閱時發生錯誤，請稍後再試。' });
        }
        pending.delete(userId);
        return { ok: true };
      }

      const added = [];
      const skipped = [];
      const failed = [];
      const removed = [];

      for (const code of uniqueCodes) {
        if (!validRegex.test(code)) {
          skipped.push({ code, reason: '格式不符' });
          continue;
        }

        try {
          let exists = false;
          try {
            exists = await subscriptionExists(userId, code);
          } catch (dbErr) {
            console.error('DB check failed:', dbErr);
            failed.push({ code, reason: '資料庫連線失敗' });
            continue;
          }

          if (state && state.unsubscribe) {
            try {
              const affected = await deleteSubscription(userId, code);
              if (affected > 0) removed.push(code);
              else skipped.push({ code, reason: '不存在' });
            } catch (delErr) {
              console.error('Failed to delete subscription for', code, delErr);
              failed.push({ code, reason: delErr.message || '刪除失敗' });
            }
          } else {
            if (exists) {
              skipped.push({ code, reason: '已存在' });
              continue;
            }

            try {
              await saveSubscription(userId, code);
              added.push(code);
            } catch (saveErr) {
              console.error('Failed to save subscription for', code, saveErr);
              failed.push({ code, reason: saveErr.message || '未知錯誤' });
            }
          }
        } catch (err) {
          console.error('Unexpected error handling code', code, err);
          failed.push({ code, reason: '內部錯誤' });
        }
      }

      const lines = [];
      if (state && state.unsubscribe) {
        if (removed.length) lines.push(`已取消訂閱: ${removed.join(', ')}`);
        if (skipped.length) lines.push(`略過: ${skipped.map(s => `${s.code}(${s.reason})`).join(', ')}`);
        if (failed.length) lines.push(`失敗: ${failed.map(f => `${f.code}(${f.reason})`).join(', ')}`);
        if (lines.length === 0) lines.push('未取消任何訂閱。');
      } else {
        if (added.length) lines.push(`已新增訂閱: ${added.join(', ')}`);
        if (skipped.length) lines.push(`略過: ${skipped.map(s => `${s.code}(${s.reason})`).join(', ')}`);
        if (failed.length) lines.push(`失敗: ${failed.map(f => `${f.code}(${f.reason})`).join(', ')}`);
        if (lines.length === 0) lines.push('未新增任何訂閱。');
      }

      await lineClient.replyMessage(event.replyToken, { type: 'text', text: lines.join('\n') });
      pending.delete(userId);
      return { ok: true };
    }

    // default: echo
    await lineClient.replyMessage(event.replyToken, { type: 'text', text: `收到您的訊息！\n內容: ${userMessage}` });
    return { ok: true };
  } catch (error) {
    console.error('處理事件時發生錯誤:', error);
    return { error: String(error) };
  }
}

async function start() {
  console.log("Starting monitor with config:", {
    host: config.mssql.host,
    database: config.mssql.database,
    table: config.mssql.table,
    pollIntervalSec: config.pollIntervalSec,
  });

  const pool = await connectDB();
  // initialize lastSeenId to current max id so we only detect new rows
  try {
    // detect if table has a numeric 'id' column and prefer it (helps when ID_COLUMN was mis-set)
    try {
      const checkRes = await pool
        .request()
        .query(`SELECT TOP 1 * FROM [${config.mssql.table}]`);
      const sampleRow =
        checkRes.recordset && checkRes.recordset.length
          ? checkRes.recordset[0]
          : null;
      if (sampleRow && sampleRow.id !== undefined) {
        if (config.mssql.idColumn !== "id") {
          console.log(
            `Detected 'id' column in table; overriding configured ID column '${config.mssql.idColumn}' -> 'id'`
          );
        }
        config.mssql.idColumn = "id";
      }
    } catch (e) {
      // ignore detection errors
      console.debug(
        "Could not detect table columns for id fallback:",
        e && e.message ? e.message : e
      );
    }

    // initialize lastSeenId to current max id so we only detect new rows
    const initReq = pool.request();
    // honor an optional configured initialLastSeen (useful for tests)
    if (config.initialLastSeen !== null) {
      // coerce numeric-looking values to number
      const maybeNum = Number(config.initialLastSeen);
      lastSeenId = Number.isFinite(maybeNum)
        ? maybeNum
        : config.initialLastSeen;
      console.log("Using configured INITIAL_LAST_SEEN ->", lastSeenId);
    } else {
      let q = `SELECT TOP 1 [${config.mssql.idColumn}] AS lastId FROM [${config.mssql.table}]`;
      if (config.mssql.filterClause) q += ` WHERE ${config.mssql.filterClause}`;
      q += ` ORDER BY [${config.mssql.idColumn}] DESC`;
      const res = await initReq.query(q);
      if (res.recordset && res.recordset.length) {
        lastSeenId = res.recordset[0].lastId;
        console.log("Initialized lastSeenId to", lastSeenId);
      }
    }
  } catch (err) {
    console.warn("Could not initialize lastSeenId:", err.message || err);
  }

  setInterval(() => poll(pool), config.pollIntervalSec * 1000);
}

start().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});

// Start express server for webhook routes (if any). Keep port consistent with previous behavior.
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(port, () => console.log(`Express server listening on port ${port}`));
