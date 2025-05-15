const fs = require('fs');
const axios = require('axios');
const Parser = require('rss-parser');
const http = require('http');
require('dotenv').config();

// Renderが期待するポート番号を環境変数から取得
const PORT = process.env.PORT || 3000;

// カスタムユーザーエージェントを持つRSSパーサーの作成
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },
  timeout: 10000 // タイムアウトを増やす
});

const feeds = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
const CACHE_FILE = './posted_ids.json';

function loadPostedIds() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function savePostedIds(set) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify([...set], null, 2));
}

function formatContent(item, name) {
  return `📰 **${name}**\n${item.title}\n${item.link}`;
}

async function checkFeeds() {
  const postedIds = loadPostedIds();
  console.log(`Starting to check ${feeds.length} feeds...`);

  for (const feed of feeds) {
    try {
      console.log(`Checking feed: ${feed.name} (${feed.url})`);
      
      // Axiosを使ってRSSフィードを取得する代替手段
      let feedData;
      try {
        // まずパーサーを使用
        feedData = await parser.parseURL(feed.url);
      } catch (parseError) {
        console.log(`Parser failed, trying with axios: ${parseError.message}`);
        // パーサーが失敗した場合、axiosで直接取得を試みる
        const response = await axios.get(feed.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          timeout: 10000
        });
        // 取得したXMLをパースする
        feedData = await parser.parseString(response.data);
      }

      for (const item of feedData.items) {
        const postId = item.link || item.guid;
        if (postedIds.has(postId)) continue;

        postedIds.add(postId);

        const content = feed.raw
          ? item.contentSnippet || item.title
          : formatContent(item, feed.name);

        await axios.post(feed.webhook, { content });
        console.log(`✅ Posted: ${item.title}`);
      }
    } catch (err) {
      console.error(`❌ Error checking feed ${feed.name}: ${err.message}`);
    }
  }

  savePostedIds(postedIds);
  console.log("Feed check completed");
}

// 定期的にフィードをチェックする
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 3600000; // デフォルトは1時間
console.log(`Will check feeds every ${CHECK_INTERVAL / 60000} minutes`);

// 初回実行
checkFeeds();

// 定期実行を設定
setInterval(checkFeeds, CHECK_INTERVAL);

// HTTPサーバーを作成してRenderがポートを検出できるようにする
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RSSHub Discord Webhook Bot is running!');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// サーバーを起動
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
