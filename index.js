const fs = require('fs');
const axios = require('axios');
const http = require('http');
require('dotenv').config();

// Renderが期待するポート番号を環境変数から取得
const PORT = process.env.PORT || 10000;

// Twitter API認証情報
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

// feeds.jsonを読み込む
let feeds;
try {
  feeds = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
  console.log(`Loaded ${feeds.length} feeds from configuration`);
} catch (err) {
  console.error('Error loading feeds.json:', err.message);
  feeds = [];
}

const CACHE_FILE = './posted_ids.json';
const STATUS_FILE = './status.json';

// ステータス情報をロード
function loadStatus() {
  try {
    if (fs.existsSync(STATUS_FILE)) {
      return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
    }
    return {};
  } catch (err) {
    console.error(`Error loading status: ${err.message}`);
    return {};
  }
}

// ステータス情報を保存
function saveStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (err) {
    console.error(`Error saving status: ${err.message}`);
  }
}

// 投稿済みIDをロード
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

// 投稿済みIDを保存
function savePostedIds(set) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify([...set], null, 2));
  } catch (err) {
    console.error(`Error saving posted IDs: ${err.message}`);
  }
}

// TwitterのURLからユーザー名を抽出
function extractTwitterUsername(url) {
  const patterns = [
    /twitter\.com\/([^\/\?]+)/i,
    /x\.com\/([^\/\?]+)/i,
    /nitter\.[^\/]+\/([^\/\?]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      // @から始まる場合は除去
      return match[1].startsWith('@') ? match[1].substring(1) : match[1];
    }
  }
  
  return null;
}

// Discordに送信するコンテンツをフォーマット
function formatContent(tweet, name) {
  return `📰 **${name}**\n${tweet.text}\nhttps://twitter.com/${tweet.author_id}/status/${tweet.id}`;
}

// Twitter APIからツイートを取得
async function fetchTweetsFromAPI(username) {
  if (!TWITTER_BEARER_TOKEN) {
    throw new Error('Twitter Bearer Token is not configured. Please set TWITTER_BEARER_TOKEN environment variable.');
  }

  try {
    // まずユーザーIDを取得
    const userResponse = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
      headers: {
        'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
      }
    });

    if (!userResponse.data.data) {
      throw new Error(`User not found: ${username}`);
    }

    const userId = userResponse.data.data.id;
    console.log(`Found user ID for ${username}: ${userId}`);

    // ユーザーのツイートを取得
    const tweetsResponse = await axios.get(`https://api.twitter.com/2/users/${userId}/tweets`, {
      headers: {
        'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
      },
      params: {
        'max_results': 10,
        'tweet.fields': 'created_at,author_id',
        'exclude': 'retweets,replies'
      }
    });

    if (!tweetsResponse.data.data) {
      return { items: [] };
    }

    // レスポンスをパース
    const tweets = tweetsResponse.data.data.map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      author_id: userId,
      created_at: tweet.created_at,
      link: `https://twitter.com/${username}/status/${tweet.id}`
    }));

    return {
      items: tweets
    };
  } catch (error) {
    console.error(`Error fetching tweets from Twitter API: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}, Data:`, error.response.data);
    }
    throw error;
  }
}

// エラー通知をDiscordに送信
async function sendErrorNotification(feed, errorMessage) {
  const status = loadStatus();
  const currentTime = Date.now();
  const lastErrorTime = status[`${feed.name}_last_error`] || 0;
  
  // 最後のエラーから1時間以上経過している場合のみ通知
  if (currentTime - lastErrorTime > 3600000) {
    try {
      const content = `⚠️ **エラー通知**\n${feed.name}のツイート取得中にエラーが発生しました: ${errorMessage}`;
      
      await axios.post(feed.webhook, { content });
      console.log(`✅ Sent error notification for ${feed.name}`);
      
      // エラー通知時刻を保存
      status[`${feed.name}_last_error`] = currentTime;
      saveStatus(status);
    } catch (err) {
      console.error(`❌ Failed to send error notification: ${err.message}`);
    }
  }
}

// フィードをチェックする処理
async function checkFeeds() {
  const postedIds = loadPostedIds();
  const status = loadStatus();
  console.log(`Starting to check ${feeds.length} feeds...`);

  for (const feed of feeds) {
    console.log(`Processing feed: ${feed.name}`);
    
    try {
      // ユーザー名を抽出
      const username = extractTwitterUsername(feed.url);
      
      if (!username) {
        console.error(`❌ Could not extract username from URL: ${feed.url}`);
        continue;
      }
      
      console.log(`Checking tweets for: ${username}`);
      
      // Twitter APIからツイートを取得
      const feedData = await fetchTweetsFromAPI(username);
      
      // 最終チェック時刻を更新
      status[`${feed.name}_last_check`] = Date.now();
      status[`${feed.name}_error_count`] = 0; // エラーカウントをリセット
      saveStatus(status);
      
      if (!feedData.items || feedData.items.length === 0) {
        console.log(`No new tweets found for ${username}`);
        continue;
      }
      
      console.log(`Found ${feedData.items.length} tweets for ${username}`);
      
      // ツイートを処理
      for (const tweet of feedData.items) {
        const tweetId = tweet.id;
        
        if (postedIds.has(tweetId)) {
          console.log(`Tweet already posted: ${tweetId}`);
          continue;
        }
        
        // 投稿済みに追加
        postedIds.add(tweetId);
        
        // Discord用のコンテンツをフォーマット
        const content = feed.raw
          ? tweet.text
          : formatContent(tweet, feed.name);
        
        try {
          // Discordに投稿
          await axios.post(feed.webhook, { content });
          console.log(`✅ Posted tweet: ${tweetId}`);
          
          // 連続投稿を避けるための短い遅延
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (webhookErr) {
          console.error(`❌ Error posting to Discord: ${webhookErr.message}`);
        }
      }
    } catch (err) {
      console.error(`❌ Error processing feed ${feed.name}: ${err.message}`);
      
      // エラーカウントを増やす
      status[`${feed.name}_error_count`] = (status[`${feed.name}_error_count`] || 0) + 1;
      saveStatus(status);
      
      // エラー通知を送信
      await sendErrorNotification(feed, err.message);
    }
  }

  savePostedIds(postedIds);
  console.log("Feed check completed");
}

// 定期的にフィードをチェック
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
    const uptime = process.uptime();
    res.end(`Twitter Discord Webhook Bot is running!\nUptime: ${Math.floor(uptime / 60)} minutes ${Math.floor(uptime % 60)} seconds`);
  } else if (req.url === '/status') {
    // ステータスページを提供
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const status = loadStatus();
    const statusOutput = {
      uptime: process.uptime(),
      feeds: feeds.map(feed => ({
        name: feed.name,
        url: feed.url,
        lastCheck: status[`${feed.name}_last_check`] || 0,
        errorCount: status[`${feed.name}_error_count`] || 0
      }))
    };
    res.end(JSON.stringify(statusOutput, null, 2));
  } else if (req.url === '/trigger') {
    // トリガーエンドポイントを追加
    console.log("Manual trigger received, checking feeds...");
    checkFeeds().then(() => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Feed check triggered successfully!');
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error triggering feed check: ${err.message}`);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// サーバーを起動
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
