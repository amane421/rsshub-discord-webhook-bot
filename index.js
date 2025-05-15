const fs = require('fs');
const axios = require('axios');
const Parser = require('rss-parser');
const http = require('http');
require('dotenv').config();

// Renderが期待するポート番号を環境変数から取得
const PORT = process.env.PORT || 10000;

// RSSパーサーの作成とカスタマイズ
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  timeout: 15000, // タイムアウトを増やす
  customFields: {
    item: [
      ['media:content', 'media'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

// axiosのデフォルト設定
axios.defaults.timeout = 15000;
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
axios.defaults.headers.common['Accept'] = 'application/rss+xml, application/xml, text/xml, */*';
axios.defaults.headers.common['Accept-Language'] = 'en-US,en;q=0.9';

// ソースURLにFallbackオプションを追加するためfeeds.jsonを読み込み、修正する
let feeds;
try {
  feeds = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
  
  // nitter.poast.orgのURLを代替URLでフォールバック用に準備
  feeds = feeds.map(feed => {
    // 元のURLを保存
    feed.originalUrl = feed.url;
    
    // nitter.poast.orgのURLに代替URLを追加
    if (feed.url.includes('nitter.poast.org')) {
      // Twitterユーザー名を抽出
      const usernameMatch = feed.url.match(/nitter\.poast\.org\/([^\/]+)/);
      if (usernameMatch && usernameMatch[1]) {
        const username = usernameMatch[1];
        feed.fallbackUrls = [
          `https://nitter.net/${username}/rss`, // 代替1
          `https://notabird.site/${username}/rss`, // 代替2
          `https://twiiit.com/${username}/rss`, // 代替3
          `https://nitter.unixfox.eu/${username}/rss` // 代替4
        ];
      }
    }
    return feed;
  });
  
  console.log(`Loaded ${feeds.length} feeds with fallback options`);
} catch (err) {
  console.error('Error loading or processing feeds.json:', err.message);
  feeds = [];
}

const CACHE_FILE = './posted_ids.json';

function loadPostedIds() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      return new Set(JSON.parse(raw));
    }
    return new Set();
  } catch (err) {
    console.error(`Error loading posted IDs: ${err.message}`);
    return new Set();
  }
}

function savePostedIds(set) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify([...set], null, 2));
  } catch (err) {
    console.error(`Error saving posted IDs: ${err.message}`);
  }
}

function formatContent(item, name) {
  // 先頭に改行を入れないようにする
  return `📰 **${name}**\n${item.title}\n${item.link}`;
}

async function tryFetchRSS(url) {
  try {
    console.log(`Attempting to fetch RSS from: ${url}`);
    return await parser.parseURL(url);
  } catch (err) {
    console.log(`RSS parser failed for ${url}: ${err.message}`);
    
    // Axiosで直接取得を試みる
    try {
      const response = await axios.get(url);
      console.log(`Axios fetch successful for ${url}`);
      return await parser.parseString(response.data);
    } catch (axiosErr) {
      console.log(`Axios fetch failed for ${url}: ${axiosErr.message}`);
      throw axiosErr; // 上位で処理するために再スロー
    }
  }
}

async function checkFeeds() {
  const postedIds = loadPostedIds();
  console.log(`Starting to check ${feeds.length} feeds...`);

  for (const feed of feeds) {
    console.log(`Processing feed: ${feed.name}`);
    
    // 最初に元のURLを試す
    let feedData = null;
    let successUrl = null;
    let error = null;
    
    try {
      feedData = await tryFetchRSS(feed.url);
      successUrl = feed.url;
      console.log(`Successfully fetched from primary URL: ${feed.url}`);
    } catch (err) {
      error = err;
      console.log(`Failed to fetch from primary URL: ${feed.url}, Error: ${err.message}`);
      
      // フォールバックURLが存在する場合、それらを試す
      if (feed.fallbackUrls && feed.fallbackUrls.length > 0) {
        console.log(`Trying ${feed.fallbackUrls.length} fallback URLs for ${feed.name}`);
        
        for (const fallbackUrl of feed.fallbackUrls) {
          try {
            feedData = await tryFetchRSS(fallbackUrl);
            successUrl = fallbackUrl;
            console.log(`Successfully fetched from fallback URL: ${fallbackUrl}`);
            break; // 成功したらループを抜ける
          } catch (fallbackErr) {
            console.log(`Fallback URL failed: ${fallbackUrl}, Error: ${fallbackErr.message}`);
            // 続行して次のフォールバックを試す
          }
        }
      }
    }
    
    if (!feedData) {
      console.error(`❌ All attempts failed for feed ${feed.name}: ${error?.message || 'Unknown error'}`);
      continue; // 次のフィードへ
    }
    
    // 成功したURLがある場合、それを使用
    try {
      console.log(`Found ${feedData.items.length} items in feed ${feed.name}`);
      
      for (const item of feedData.items) {
        const postId = item.link || item.guid;
        if (!postId) {
          console.log(`Skipping item without ID in feed ${feed.name}`);
          continue;
        }
        
        if (postedIds.has(postId)) {
          console.log(`Skipping already posted item: ${postId}`);
          continue;
        }

        postedIds.add(postId);
        
        const content = feed.raw
          ? item.contentSnippet || item.title
          : formatContent(item, feed.name);
          
        console.log(`Posting to webhook: ${feed.webhook.substring(0, 30)}...`);
        
        try {
          await axios.post(feed.webhook, { content });
          console.log(`✅ Posted: ${item.title}`);
        } catch (webhookErr) {
          console.error(`❌ Error posting to webhook: ${webhookErr.message}`);
        }
      }
    } catch (processErr) {
      console.error(`❌ Error processing feed data for ${feed.name}: ${processErr.message}`);
    }
  }

  savePostedIds(postedIds);
  console.log("Feed check completed");
}

// 定期的にフィードをチェックする
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 3600000; // デフォルトは1時間
console.log(`Will check feeds every ${CHECK_INTERVAL / 60000} minutes`);

// 初回実行
checkFeeds();

// 定期実行を設定
setInterval(checkFeeds, CHECK_INTERVAL);

// HTTPサーバーを作成
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
