const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;

const webhookURL = process.env.DISCORD_WEBHOOK_URL;
const feedURL = process.env.RSS_FEED_URL;

app.get("/trigger", async (req, res) => {
  try {
    const rssRes = await axios.get(feedURL);
    const content = rssRes.data;

    const message = {
      content: "📰 新しい投稿が検出されました！\n```" + content.slice(0, 1500) + "```"
    };

    await axios.post(webhookURL, message);
    console.log("✅ Discordに送信しました");
    res.status(200).send("✅ 投稿完了");
  } catch (err) {
    console.error("❌ エラー:", err.message);
    res.status(500).send("エラーが発生しました");
  }
});

app.get("/", (req, res) => {
  res.send("✅ Botは稼働中です");
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});