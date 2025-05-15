const fs = require('fs');
const axios = require('axios');
const Parser = require('rss-parser');
const http = require('http');
const https = require('https');
const cheerio = require('cheerio');
require('dotenv').config();

// Renderが期待するポート番号を環境変数から取得
const PORT = process.env.PORT || 10000;

// カスタムHTTPSエージェントの作成（証明書エラーを無視）
const httpsAgent = new https.Agent({
  rejectUnauthorized: false // 自己署名証明書を許可
});

// ユーザーエージェントのローテーション
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0'
];

// ランダムなユーザーエージェントを取得
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// RSSパーサーの作成
const parser = new Parser({
  headers: {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  timeout: 20000,
  customFields: {
    item: [
      ['media:content', 'media'],
      ['content:encoded', 'contentEncoded']
    ]
  }
});

// axiosのデフォルト設定
axios.defaults.timeout = 20000;
axios.defaults.httpsAgent = httpsAgent;

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
  return `📰 **${name}**\n${item.title || 'No title'}\n${item.link || ''}`;
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

// HTMLページをスクレイピングしてツイートを抽出
async function scrapeTwitter(username) {
  console.log(`Attempting to scrape tweets for: ${username}`);
  
  const urls = [
    `https://nitter.poast.org/${username}`,
    `https://nitter.bird.froth.zone/${username}`,
    `https://birdsiteonline.eu.org/${username}`,
    `https://tweet.lambda.dance/${username}`
  ];
  
  for (const url of urls) {
    try {
      console.log(`Trying to scrape from: ${url}`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml,application/xml',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      
      if (response.status === 200) {
        const html = response.data;
        const $ = cheerio.load(html);
        const tweets = [];
        
        // nitterのHTMLパターンを検出
        $('.timeline-item, .tweet-card, .tweet, article').each((i, elem) => {
          if (i >= 10) return false; // 最大10件まで
          
          const tweetElem = $(elem);
          
          // 様々なセレクタパターンを試す
          const tweetId = tweetElem.attr('id') || 
                         tweetElem.find('[data-tweet-id]').attr('data-tweet-id') ||
                         tweetElem.find('a[href*="/status/"]').attr('href')?.split('/status/')[1]?.split('?')[0];
          
          const tweetContent = tweetElem.find('.tweet-content, .tweet-text, [data-testid="tweetText"]').text().trim() || 
                              tweetElem.find('p').text().trim();
          
          const tweetLink = tweetId ? 
                           `https://twitter.com/${username}/status/${tweetId}` : 
                           tweetElem.find('a[href*="/status/"]').attr('href');
          
          const tweetDate = tweetElem.find('.tweet-date a, time').attr('title') || 
                           tweetElem.find('.tweet-date a, time').attr('datetime') ||
                           new Date().toISOString();
          
          if ((tweetId || tweetLink) && tweetContent) {
            const uniqueId = tweetId || tweetLink;
            tweets.push({
              id: uniqueId,
              title: tweetContent.substring(0, 100) + (tweetContent.length > 100 ? '...' : ''),
              content: tweetContent,
              contentSnippet: tweetContent,
              link: tweetLink || `https://twitter.com/${username}/status/${tweetId}`,
              pubDate: tweetDate
            });
          }
        });
        
        if (tweets.length > 0) {
          console.log(`Successfully scraped ${tweets.length} tweets from ${url}`);
          return {
            items: tweets
          };
        } else {
          console.log(`No tweets found at ${url} using standard selectors`);
          
          // 代替パターンを試す
          let altSelector = '';
          
          if (url.includes('nitter.poast.org')) {
            altSelector = '.timeline-item, .timeline .tweet';
          } else if (url.includes('bird.froth.zone')) {
            altSelector = '.item, .timeline .status';
          } else {
            altSelector = 'article, .status-card, .tweet';
          }
          
          const altTweets = [];
          
          $(altSelector).each((i, elem) => {
            if (i >= 10) return false;
            
            const textContent = $(elem).text().trim();
            const link = $(elem).find('a[href*="/status/"]').attr('href');
            
            if (textContent && link) {
              // ツイートIDの抽出を試みる
              const idMatch = link.match(/\/status\/(\d+)/);
              const id = idMatch ? idMatch[1] : `scraped-${i}-${Date.now()}`;
              
              altTweets.push({
                id: id,
                title: textContent.substring(0, 100) + (textContent.length > 100 ? '...' : ''),
                content: textContent,
                contentSnippet: textContent,
                link: link.startsWith('http') ? link : `${url.split('/').slice(0, 3).join('/')}${link}`,
                pubDate: new Date().toISOString()
              });
            }
          });
          
          if (altTweets.length > 0) {
            console.log(`Successfully scraped ${altTweets.length} tweets using alternative selectors from ${url}`);
            return {
              items: altTweets
            };
          }
        }
      }
    } catch (err) {
      console.log(`Error scraping ${url}: ${err.message}`);
      // 失敗しても次のURLを試す
    }
  }
  
  throw new Error(`Failed to scrape tweets for ${username} from all sources`);
}

// nitterのURLからRSSフィードURLに変換
function convertToRssUrl(url) {
  const username = extractTwitterUsername(url);
  if (!username) return null;
  
  return [
    `${url}/rss`, // 基本URLに/rssを追加
    `https://nitter.poast.org/${username}/rss`,
    `https://nitter.bird.froth.zone/${username}/rss`,
    `https://birdsiteonline.eu.org/${username}/rss`,
    `https://tweet.lambda.dance/${username}/rss`
  ];
}

// RSSフィードを試行
async function tryRSS(urls) {
  if (typeof urls === 'string') {
    urls = [urls];
  }
  
  for (const url of urls) {
    try {
      console.log(`Attempting to fetch RSS from: ${url}`);
      return await parser.parseURL(url);
    } catch (err) {
      console.log(`RSS parser failed for ${url}: ${err.message}`);
      
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': getRandomUserAgent()
          }
        });
        
        try {
          return await parser.parseString(response.data);
        } catch (parseErr) {
          console.log(`Parse failed after successful fetch: ${parseErr.message}`);
          // 次のURLを試す
        }
      } catch (axiosErr) {
        console.log(`Axios fetch failed for ${url}: ${axiosErr.message}`);
        // 次のURLを試す
      }
    }
  }
  
  throw new Error('All RSS URLs failed');
}

// フィードのチェック
async function checkFeeds() {
  const postedIds = loadPostedIds();
  console.log(`Starting to check ${feeds.length} feeds...`);

  for (const feed of feeds) {
    console.log(`Processing feed: ${feed.name}`);
    
    let feedData = null;
    
    try {
      // まずRSSフィードを試す
      const rssUrls = convertToRssUrl(feed.url);
      if (rssUrls) {
        try {
          feedData = await tryRSS(rssUrls);
          console.log(`Successfully fetched RSS feed for ${feed.name}`);
        } catch (rssErr) {
          console.log(`All RSS attempts failed for ${feed.name}: ${rssErr.message}`);
        }
      }
      
      // RSSが失敗した場合はスクレイピングを試す
      if (!feedData) {
        const username = extractTwitterUsername(feed.url);
        
        if (username) {
          try {
            console.log(`RSS failed, attempting to scrape tweets for username: ${username}`);
            feedData = await scrapeTwitter(username);
          } catch (scrapeErr) {
            console.error(`❌ Scraping failed for ${feed.name} (${username}): ${scrapeErr.message}`);
          }
        } else {
          console.error(`❌ Could not extract Twitter username from URL: ${feed.url}`);
        }
      }
    } catch (err) {
      console.error(`❌ All methods failed for feed ${feed.name}: ${err.message}`);
    }
    
    if (!feedData || !feedData.items || feedData.items.length === 0) {
      console.error(`❌ No feed data found for ${feed.name}`);
      continue;
    }
    
    try {
      console.log(`Found ${feedData.items.length} items in feed ${feed.name}`);
      
      for (const item of feedData.items) {
        const postId = item.link || item.id || item.guid;
        
        if (!postId) {
          console.log(`Skipping item without ID in feed ${feed.name}`);
          continue;
        }
        
        if (postedIds.has(postId)) {
          console.log(`Skipping already posted item: ${postId}`);
          continue;
        }

        // 新しい投稿をキャッシュに追加
        postedIds.add(postId);
        
        const content = feed.raw
          ? item.content || item.contentSnippet || item.title
          : formatContent(item, feed.name);
          
        console.log(`Posting to webhook: ${feed.webhook.substring(0, 30)}...`);
        
        try {
          await axios.post(feed.webhook, { content });
          console.log(`✅ Posted: ${item.title || 'No title'}`);
          
          // 連続投稿を避けるための短い遅延
          await new Promise(resolve => setTimeout(resolve, 1000));
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
    const uptime = process.uptime();
    res.end(`RSSHub Discord Webhook Bot is running!\nUptime: ${Math.floor(uptime / 60)} minutes ${Math.floor(uptime % 60)} seconds`);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// サーバーを起動
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
