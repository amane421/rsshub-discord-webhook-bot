const fs = require('fs');
const axios = require('axios');
const http = require('http');
require('dotenv').config();

// Renderが期待するポート番号を環境変数から取得
const PORT = process.env.PORT || 10000;

// Twitter API認証情報
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;

// 環境変数からストレージパスを取得（Renderの場合は永続ディレクトリを使用）
const STORAGE_PATH = process.env.PERSISTENT_STORAGE_DIR || './';

// 重要なファイルのパス
const CACHE_FILE = `${STORAGE_PATH}/posted_ids.json`;
const STATUS_FILE = `${STORAGE_PATH}/status.json`;
const USER_ID_CACHE_FILE = `${STORAGE_PATH}/user_ids.json`;
const LOCK_FILE = `${STORAGE_PATH}/check_in_progress.lock`;

// feeds.jsonを読み込む
let feeds;
try {
  feeds = JSON.parse(fs.readFileSync('./feeds.json', 'utf-8'));
  console.log(`Loaded ${feeds.length} feeds from configuration`);
} catch (err) {
  console.error('Error loading feeds.json:', err.message);
  feeds = [];
}

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

// ユーザーIDキャッシュをロード
function loadUserIdCache() {
  try {
    if (fs.existsSync(USER_ID_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(USER_ID_CACHE_FILE, 'utf-8'));
    }
    return {};
  } catch (err) {
    console.error(`Error loading user ID cache: ${err.message}`);
    return {};
  }
}

// ユーザーIDキャッシュを保存
function saveUserIdCache(cache) {
  try {
    fs.writeFileSync(USER_ID_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error(`Error saving user ID cache: ${err.message}`);
  }
}

// ロックファイルをチェック
function isLocked() {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      // ロックファイルの作成時間を確認
      const lockData = fs.readFileSync(LOCK_FILE, 'utf-8');
      const lockTime = parseInt(lockData);
      const now = Date.now();
      
      // 30分以上前のロックは無効とみなす（クラッシュ対策）
      if (now - lockTime > 30 * 60 * 1000) {
        console.log("Found stale lock file. Removing it.");
        fs.unlinkSync(LOCK_FILE);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`Error checking lock file: ${err.message}`);
      return false;
    }
  }
  return false;
}

// ロックを作成
function createLock() {
  try {
    fs.writeFileSync(LOCK_FILE, Date.now().toString());
    return true;
  } catch (err) {
    console.error(`Error creating lock file: ${err.message}`);
    return false;
  }
}

// ロックを解除
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (err) {
    console.error(`Error releasing lock: ${err.message}`);
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
  // URLを検出するための正規表現
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  
  // 元のテキストを保持
  const originalText = tweet.text;
  
  // 引用URLを抽出（参照元のXのURL以外）
  const urls = originalText.match(urlRegex) || [];
  const quotedUrls = urls.filter(url => 
    !url.includes('twitter.com') && 
    !url.includes('x.com') && 
    !url.includes('/status/')
  );
  
  // ツイート本文からTwitter/XのURLを削除
  let cleanText = originalText.replace(/https:\/\/(twitter\.com|x\.com)\/[^\/]+\/status\/\d+/g, '').trim();
  
  // 投稿者に応じてフォーマットを変更
  if (name === 'angorou7') {
    // angorou7の場合はツイート内容をそのまま使用し、末尾に引用URLを追加
    let content = cleanText;
    
    // 引用URLがある場合はそれを追加
    if (quotedUrls.length > 0) {
      // すでにURLがテキスト内に含まれている場合は追加しない
      const uniqueUrls = quotedUrls.filter(url => !content.includes(url));
      if (uniqueUrls.length > 0) {
        content += '\n\n' + uniqueUrls.join('\n');
      }
    }
    
    return content;
  } else {
    // Crypto_AI_chan_などの場合はシンプルなフォーマットを適用

    // 必要に応じて改行を整理（連続する改行を1つに）
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
    
    // 先頭行を抽出（タイトルとして使用）
    const lines = cleanText.split('\n');
    let title = lines[0].trim();
    
    // タイトルが短すぎる場合は複数行を結合
    if (title.length < 15 && lines.length > 1) {
      title = lines.slice(0, 2).join(' ').trim();
    }
    
    // 本文を整形（タイトル以降の部分）
    let body = title + '\n';
    
    // 本文から箇条書きを抽出（行頭の・、•、◆、◇、★、☆、→などで始まる行）
    const bulletPoints = lines.slice(1).filter(line => 
      /^[•◆◇★☆→・\-\*\+]/.test(line.trim()) || 
      /^\d+[\.\)]/.test(line.trim())
    );
    
    // 箇条書きがあれば追加
    if (bulletPoints.length > 0) {
      // 既存の箇条書きを使用
      body += bulletPoints.join('\n');
    } else {
      // 箇条書きがなければ本文から抜粋して箇条書き形式に
      const contentLines = lines.slice(1).filter(line => line.trim().length > 5);
      if (contentLines.length > 0) {
        body += contentLines.map(line => `- ${line.trim()}`).join('\n');
      }
    }
    
    // ツイートURLを削除（参照元のXのURLのみ）
    body = body.replace(/https:\/\/(twitter\.com|x\.com)\/[^\/]+\/status\/\d+/g, '');
    
    // 引用URLがあれば追加
    if (quotedUrls.length > 0) {
      // 既にURLが含まれていないか確認
      const uniqueUrls = quotedUrls.filter(url => !body.includes(url));
      if (uniqueUrls.length > 0) {
        body += '\n\n' + uniqueUrls.join('\n');
      }
    }
    
    // 余分な改行を削除して整形
    body = body.replace(/\n{3,}/g, '\n\n').trim();
    
    return body;
  }
}

// レート制限情報を管理するオブジェクト
const rateLimits = {
  lastReset: Date.now(),
  remainingRequests: 75, // デフォルトの制限値
  resetTime: Date.now() + 900000, // 15分後にリセット

  // レスポンスヘッダーからレート制限情報を更新
  update(headers) {
    if (headers['x-rate-limit-remaining']) {
      this.remainingRequests = parseInt(headers['x-rate-limit-remaining']);
    }
    if (headers['x-rate-limit-reset']) {
      this.resetTime = parseInt(headers['x-rate-limit-reset']) * 1000;
    }
    console.log(`Rate limit info: ${this.remainingRequests} requests remaining, resets at ${new Date(this.resetTime).toISOString()}`);
  },

  // レート制限に達したか確認
  async checkAndWait() {
    // 残りリクエスト数が少ない場合（より保守的な値に設定）
    if (this.remainingRequests <= 20) {
      const now = Date.now();
      const waitTime = Math.max(300000, this.resetTime - now + 10000); // 最低5分、必要なら待機時間を延長
      
      console.log(`Rate limit approaching, waiting for ${Math.ceil(waitTime/1000)} seconds...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      // リセット後は制限をデフォルト値に戻す
      this.remainingRequests = 75;
      this.resetTime = Date.now() + 900000;
    }
    
    // リクエスト数を事前に減らしておく（安全策）
    this.remainingRequests--;
  }
};

// Twitter APIからツイートを取得
async function fetchTweetsFromAPI(username) {
  if (!TWITTER_BEARER_TOKEN) {
    throw new Error('Twitter Bearer Token is not configured. Please set TWITTER_BEARER_TOKEN environment variable.');
  }

  try {
    // ユーザーIDキャッシュをロード
    const userIdCache = loadUserIdCache();
    let userId;
    
    // キャッシュにユーザーIDがあるか確認
    if (userIdCache[username]) {
      userId = userIdCache[username];
      console.log(`Using cached user ID for ${username}: ${userId}`);
    } else {
      // レート制限をチェック
      await rateLimits.checkAndWait();
      
      // まずユーザーIDを取得
      const userResponse = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
        headers: {
          'Authorization': `Bearer ${TWITTER_BEARER_TOKEN}`
        }
      });

      // レート制限情報を更新
      if (userResponse.headers) {
        rateLimits.update(userResponse.headers);
      }

      if (!userResponse.data.data) {
        throw new Error(`User not found: ${username}`);
      }

      userId = userResponse.data.data.id;
      console.log(`Found user ID for ${username}: ${userId}`);
      
      // ユーザーIDをキャッシュに保存
      userIdCache[username] = userId;
      saveUserIdCache(userIdCache);
    }

    // ユーザーID取得後、少し待機（レート制限対策）
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2秒待機
    
    // レート制限をチェック（2回目のAPI呼び出し前）
    await rateLimits.checkAndWait();
    
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

    // レート制限情報を更新
    if (tweetsResponse.headers) {
      rateLimits.update(tweetsResponse.headers);
    }

    if (!tweetsResponse.data.data) {
      return { items: [] };
    }

    // レスポンスをパース
    const tweets = tweetsResponse.data.data.map(tweet => ({
      id: tweet.id,
      text: tweet.text,
      author_id: userId,
      created_at: tweet.created_at || new Date().toISOString(),
      link: `https://twitter.com/${username}/status/${tweet.id}`
    }));

    return {
      items: tweets
    };
  } catch (error) {
    console.error(`Error fetching tweets from Twitter API: ${error.message}`);
    if (error.response) {
      console.error(`Status: ${error.response.status}, Data:`, error.response.data);
      
      // レート制限エラーの場合は待機時間を設定
      if (error.response.status === 429) {
        const resetTime = error.response.headers['x-rate-limit-reset'];
        if (resetTime) {
          rateLimits.resetTime = parseInt(resetTime) * 1000;
          rateLimits.remainingRequests = 0;
          console.log(`Rate limit exceeded, reset time: ${new Date(rateLimits.resetTime).toISOString()}`);
        } else {
          // ヘッダーがない場合はデフォルトの待機時間（15分）
          rateLimits.resetTime = Date.now() + 900000;
          rateLimits.remainingRequests = 0;
        }
      }
    }
    throw error;
  }
}

// 同じ内容のツイートかどうかをチェック（重複防止）
function isSimilarTweet(newText, postedTexts, threshold = 0.85) {
  if (!postedTexts.length) return false;
  
  // 簡易的な類似度チェック
  for (const text of postedTexts) {
    // 両方のテキストを小文字に変換して比較
    const a = newText.toLowerCase();
    const b = text.toLowerCase();
    
    // 短いほうの長さの85%以上が一致していれば類似と判断
    const minLength = Math.min(a.length, b.length);
    let matchCount = 0;
    
    for (let i = 0; i < minLength; i++) {
      if (a[i] === b[i]) matchCount++;
    }
    
    const similarity = matchCount / minLength;
    if (similarity >= threshold) {
      return true;
    }
  }
  
  return false;
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
  // 同時実行を防ぐためのロックチェック
  if (isLocked()) {
    console.log("Another check process is already running. Skipping.");
    return;
  }
  
  // ロックを作成
  if (!createLock()) {
    console.error("Failed to create lock. Aborting check.");
    return;
  }
  
  try {
    const postedIds = loadPostedIds();
    const status = loadStatus();
    const recentTexts = []; // 最近投稿したテキストを追跡（重複防止用）
    
    console.log(`Starting to check ${feeds.length} feeds...`);

    for (const feed of feeds) {
      console.log(`Processing feed: ${feed.name}`);
      
      // 再試行カウンター
      let retryCount = 0;
      const maxRetries = 3;
      
      while (retryCount < maxRetries) {
        try {
          // ユーザー名を抽出
          const username = extractTwitterUsername(feed.url);
          
          if (!username) {
            console.error(`❌ Could not extract username from URL: ${feed.url}`);
            break;
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
            break;
          }
          
          console.log(`Found ${feedData.items.length} tweets for ${username}`);
          
          // ツイートを処理（新しい順に処理）
          const sortedItems = feedData.items.sort((a, b) => {
            return new Date(b.created_at) - new Date(a.created_at);
          });
          
          for (const tweet of sortedItems) {
            const tweetId = tweet.id;
            
            // IDベースの重複チェック
            if (postedIds.has(tweetId)) {
              console.log(`Tweet already posted (ID check): ${tweetId}`);
              continue;
            }
            
            // 内容ベースの重複チェック
            if (isSimilarTweet(tweet.text, recentTexts)) {
              console.log(`Similar tweet already posted (content check): ${tweetId}`);
              postedIds.add(tweetId); // 重複としてマーク
              continue;
            }
            
            // 投稿済みに追加
            postedIds.add(tweetId);
            recentTexts.push(tweet.text); // 重複チェック用に保存
            
            // 最大50件のテキストを保持（メモリ節約）
            if (recentTexts.length > 50) {
              recentTexts.shift();
            }
            
            // Discord用のコンテンツをフォーマット
            const content = feed.raw
              ? tweet.text
              : formatContent(tweet, feed.name);
            
            try {
              // Discordに投稿
              await axios.post(feed.webhook, { content });
              console.log(`✅ Posted tweet: ${tweetId}`);
              
              // 連続投稿を避けるための短い遅延
              await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5秒の遅延
            } catch (webhookErr) {
              console.error(`❌ Error posting to Discord: ${webhookErr.message}`);
            }
          }
          
          // 処理成功したらループを抜ける
          break;
          
        } catch (err) {
          retryCount++;
          console.error(`❌ Error processing feed ${feed.name} (attempt ${retryCount}/${maxRetries}): ${err.message}`);
          
          // エラーカウントを増やす
          status[`${feed.name}_error_count`] = (status[`${feed.name}_error_count`] || 0) + 1;
          saveStatus(status);
          
          if (retryCount >= maxRetries) {
            // 最大再試行回数に達したらエラー通知を送信
            await sendErrorNotification(feed, err.message);
            break;
          }
          
          // レート制限エラーの場合は長めに待機
          if (err.response && err.response.status === 429) {
            // レート制限リセット時間がある場合はそれを使用、なければデフォルト値
            const resetTime = err.response.headers['x-rate-limit-reset'] 
              ? parseInt(err.response.headers['x-rate-limit-reset']) * 1000 
              : Date.now() + 900000;
              
            const waitTime = Math.max(60000, resetTime - Date.now() + 5000); // 最低1分、リセット時間+5秒まで待機
            console.log(`Rate limit error, waiting for ${Math.ceil(waitTime/1000)} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          } else {
            // その他のエラーの場合も少し待機
            const waitTime = 30000 * retryCount; // リトライごとに待機時間を増やす
            console.log(`Waiting for ${waitTime/1000} seconds before retry...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      }
      
                // 次のフィードを処理する前に長めに待機（レート制限対策）
      console.log(`Waiting 10 seconds before processing next feed...`);
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10秒待機
    }

    savePostedIds(postedIds);
    console.log("Feed check completed");
  } finally {
    // 処理完了後にロックを解除
    releaseLock();
  }
}

// 古いIDを定期的にクリーンアップする処理
function cleanupOldPostedIds() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const ids = JSON.parse(raw);
      
      // 最大1000件に制限
      if (ids.length > 1000) {
        const trimmedIds = ids.slice(-1000); // 最新の1000件を保持
        fs.writeFileSync(CACHE_FILE, JSON.stringify(trimmedIds, null, 2));
        console.log(`Cleaned up posted IDs, kept most recent 1000 of ${ids.length}`);
      }
    }
  } catch (err) {
    console.error(`Error cleaning up old posted IDs: ${err.message}`);
  }
  
  // 24時間ごとに実行
  setTimeout(cleanupOldPostedIds, 24 * 60 * 60 * 1000);
}

// 定期的にフィードをチェック設定
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 7200000; // デフォルトは2時間
console.log(`Will check feeds every ${CHECK_INTERVAL / 60000} minutes`);

// 起動直後に実行するかどうかを決定する環境変数（デフォルトは遅延実行）
const RUN_IMMEDIATELY = process.env.RUN_IMMEDIATELY === 'true';

if (RUN_IMMEDIATELY) {
  // 即時実行が指定された場合のみ直ちに実行
  console.log('Running first check immediately as requested...');
  checkFeeds();
} else {
  // 通常は1時間待機してから初回実行（レート制限回避）
  const INITIAL_DELAY = parseInt(process.env.INITIAL_DELAY) || 3600000; // デフォルト1時間
  console.log(`Scheduling first check in ${INITIAL_DELAY / 60000} minutes to avoid rate limits...`);
  setTimeout(checkFeeds, INITIAL_DELAY);
}

// 定期実行の設定（初回実行とは別に設定）
console.log(`Setting up regular check every ${CHECK_INTERVAL / 60000} minutes`);
setInterval(checkFeeds, CHECK_INTERVAL);

// 定期的なクリーンアップ処理を開始
cleanupOldPostedIds();

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
        errorCount: status[`${feed.name}_error_count`] || 0,
        lastError: status[`${feed.name}_last_error`] || 0
      })),
      rateLimit: {
        remainingRequests: rateLimits.remainingRequests,
        resetTime: new Date(rateLimits.resetTime).toISOString()
      },
      lock: {
        isLocked: isLocked()
      }
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
