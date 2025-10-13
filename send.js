import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import { Client } from "@line/bot-sdk";

// load environment variables first
dotenv.config();

const config = {
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN || "YOUR_CHANNEL_ACCESS_TOKEN",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "YOUR_CHANNEL_SECRET",
};

if (
  config.channelAccessToken === "YOUR_CHANNEL_ACCESS_TOKEN" ||
  config.channelSecret === "YOUR_CHANNEL_SECRET"
) {
  console.warn(
    "Warning: LINE channel access token or secret not set in environment. Please create a .env with LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET."
  );
}

const app = express();

// LINE webhook: use route-scoped raw parser and manual signature verification
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-line-signature"];
    const body = req.body; // Buffer

    try {
      if (!signature) {
        console.warn("No x-line-signature header");
        return res.status(400).send("Missing signature");
      }

      const computed = crypto
        .createHmac("sha256", config.channelSecret)
        .update(body)
        .digest("base64");

      const sigBuf = Buffer.from(signature);
      const compBuf = Buffer.from(computed);
      if (
        sigBuf.length !== compBuf.length ||
        !crypto.timingSafeEqual(sigBuf, compBuf)
      ) {
        console.error("Signature validation failed", { signature, computed });
        return res.status(401).send("SignatureValidationFailed");
      }

      const parsed = JSON.parse(body.toString());
      const events = parsed.events || [];

      const results = await Promise.all(events.map(handleEvent));
      return res.json(results);
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(500).send("Internal Server Error");
    }
  }
);

// parse JSON for any other routes (after webhook middleware)
app.use(express.json());

const client = new Client(config);

async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") {
      return Promise.resolve(null);
    }

    const userId = event.source.userId;
    const userMessage = event.message.text;

    console.log("使用者ID:", userId);
    console.log("訊息內容:", userMessage);

    // Simple text message for testing
    const replyMessage = {
      type: "text",
      text: `收到您的訊息！\n股票代碼: ${userMessage}\n已設定交易訊號推送`,
    };

    try {
      await client.replyMessage(event.replyToken, replyMessage);
      console.log("回覆訊息成功");
    } catch (error) {
      console.error("回覆訊息失敗:", error.message);
      if (error.response) {
        console.error("Error details:", error.response.data);
      }
    }
  } catch (error) {
    console.error("處理事件時發生錯誤:", error);
    return Promise.resolve(null);
  }
}

// Add error handling for the webhook
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    status: "error",
    message: "Internal Server Error",
  });
});

app.listen(3000, () => {
  console.log("LINE Bot 已啟動在 port 3000");
});
