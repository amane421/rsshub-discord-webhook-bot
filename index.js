const express = require("express");
const axios = require("axios");
const Parser = require("rss-parser");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 3000;
const feedUrls = process.env.RSS_FEED_URL.split(",").map(url => url.trim());
const webhookURL = process.env.DISCORD_WEBHOOK_URL;

app.get("/trigger", async (req, res) => {
  try {
    for (const url of feedUrls) {
      const parser = new Parser();
      const feed = await parser.parseURL(url);
      const latest = feed.items[0];
      const author = feed.title.replace(/^@/, "");

      if (!latest) continue;

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

// --- メディア抽出関数 ---
function extractMedia(item) {
  const enclosure = item.enclosure?.url ? [item.enclosure.url] : [];
  const contentImages = item.content?.match(/https?:\/\/[^\s"]+\.(jpe?g|png|gif|webp)/gi) || [];
  return [...new Set([...enclosure, ...contentImages])];
}

// --- 要約関数 ---
function extractSummary(text) {
  const title = text.match(/(.+?)[\n。]/)?.[1] || "タイトルなし";
  const points = [...text.matchAll(/[-・●◆■]\s*(.+)/g)].map(m => `- ${m[1]}`);
  const summary = text.match(/(まとめ|結論|要点)[：:\n\s]*(.+)/)?.[2] || "";

  return `🌟 ${title}\n\n【重要ポイント】\n${points.join("\n") || "- 抜粋なし"}\n\n【まとめ】\n${summary || "- 特に記載なし"}`;
}

// --- Discord送信関数 ---
async function sendToDiscord(text, link, mediaUrls = []) {
  const embeds = mediaUrls
    .filter(url => /\.(jpe?g|png|gif|webp)$/i.test(url))
    .slice(0, 10)
    .map(url => ({ image: { url } }));

  const payload = {
    content: `${text}\n\n引用元：${link}`
  };

  if (embeds.length > 0) {
    payload.embeds = embeds;
  }

  await axios.post(webhookURL, payload);
}
