const sql = require("mssql");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
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
  return pool;
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
        await sendLineMessage(messageToSend);
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

// Webhook route to accept LINE events (needs channelSecret configured)
if (config.line.channelSecret) {
  app.post('/webhook', line.middleware({ channelSecret: config.line.channelSecret }), async (req, res) => {
    const events = req.body && req.body.events ? req.body.events : [];
    console.log('Webhook /webhook called - events:', events && events.length ? events.length : 0);
    try {
      fs.appendFileSync(path.join(__dirname, 'webhook.log'), `[${new Date().toISOString()}] /webhook events=${events.length}\n`);
    } catch (e) {
      console.error('Failed to append webhook.log', e && e.message ? e.message : e);
    }
    for (const ev of events) {
      try {
        // handle follow (add friend) event
        if (ev.type === 'follow' && ev.source && ev.source.userId) {
          saveUserIdToFile(ev.source.userId);
        }
        // other events can be added here
      } catch (e) {
        console.error('Error handling event', e && e.message ? e.message : e);
      }
    }
    // always return 200 quickly
    res.status(200).send('OK');
  });

  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
  app.listen(port, () => console.log(`Webhook server listening on port ${port}`));
} else {
  console.warn('LINE channel secret not configured; webhook endpoint not started. Set LINE_CHANNEL_SECRET in environment to enable it.');
}

// Development helper: allow posting to /webhook-dev without signature verification
// Enable by setting ALLOW_UNVERIFIED_WEBHOOK=true in .env (do NOT enable in production)
if (process.env.ALLOW_UNVERIFIED_WEBHOOK === 'true') {
  app.post('/webhook-dev', express.json(), (req, res) => {
    const events = req.body && req.body.events ? req.body.events : [];
    console.log('Dev webhook /webhook-dev called - events:', events && events.length ? events.length : 0);
    try {
      fs.appendFileSync(path.join(__dirname, 'webhook.log'), `[${new Date().toISOString()}] /webhook-dev events=${events.length} body=${JSON.stringify(req.body)}\n`);
    } catch (e) {
      console.error('Failed to append webhook.log', e && e.message ? e.message : e);
    }
    for (const ev of events) {
      try {
        if (ev.type === 'follow' && ev.source && ev.source.userId) {
          saveUserIdToFile(ev.source.userId);
        }
      } catch (e) {
        console.error('Error handling dev event', e && e.message ? e.message : e);
      }
    }
    res.status(200).send('OK');
  });
  console.log('Dev unverified webhook /webhook-dev enabled (ALLOW_UNVERIFIED_WEBHOOK=true)');
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
