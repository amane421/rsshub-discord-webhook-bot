const express = require("express");
const axios = require("axios");
const Parser = require("rss-parser");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const feedUrls = process.env.RSS_FEED_URL.split(",").map(url => url.trim());
const webhookURL = process.env.DISCORD_WEBHOOK_URL;
const sentLinks = new Set(); // メモリ上で送信済みのリンクを記録

app.get("/trigger", async (req, res) => {
  try {
    for (const url of feedUrls) {
      const parser = new Parser();
      const feed = await parser.parseURL(url);
      const latest = feed.items[0];
      const author = feed.title.replace(/^@/, "");

      if (!latest || sentLinks.has(latest.link)) continue;

      const media = extractMedia(latest);
      let content;

      if (author === "Crypto_AI_chan_") {
        content = extractSummary(latest.contentSnippet || latest.content || latest.title);
      } else if (["merry__PT", "angorou7"].includes(author)) {
        content = `📝 ${latest.contentSnippet || latest.title}`;
      } else {
        continue;
      }

      await sendToDiscord(content, latest.link, media);
      sentLinks.add(latest.link); // 送信済みとして記録
    }

    res.send("✅ 投稿完了");
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

function extractMedia(item) {
  const enclosure = item.enclosure?.url ? [item.enclosure.url] : [];
  const media = item.content?.match(/https?:\/\/[^\s]+\.(jpg|png|gif)/g) || [];
  return [...new Set([...enclosure, ...media])];
}

function extractSummary(text) {
  const title = text.match(/(.+?)[\n。]/)?.[1] || "タイトルなし";
  const points = [...text.matchAll(/[-・●◆■]\s*(.+)/g)].map(m => `- ${m[1]}`);
  const summary = text.match(/(まとめ|結論|要点)[：:\n\s]*(.+)/)?.[2] || "";

  return `🌟 ${title}\n\n【重要ポイント】\n${points.join("\n") || "- 抜粋なし"}\n\n【まとめ】\n${summary || "- 特に記載なし"}`;
}

async function sendToDiscord(text, link, mediaUrls = []) {
  const embeds = mediaUrls.map(url => ({ image: { url } }));
  await axios.post(webhookURL, {
    content: `${text}\n\n引用元：${link}`,
    embeds
  });
}
