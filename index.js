const fetch = require('node-fetch');
const { parseFeed } = require('./utils.js');
const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CACHE_FILE = './posted_ids.json';
const FEEDS = require('./feeds.json');

// キャッシュ読み込み
function loadCache() {
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
    return new Set(JSON.parse(data));
  } catch (e) {
    return new Set();
  }
}

// キャッシュ保存
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache]), 'utf-8');
}

// Discordに投稿
async function postToDiscord(content, embed = null) {
  const body = embed ? { embeds: [embed] } : { content };
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// メイン処理
async function main() {
  const cache = loadCache();

  for (const feed of FEEDS) {
    const { url, format } = feed;
    const items = await parseFeed(url);

    for (const item of items) {
      if (cache.has(item.id)) continue;

      if (format === 'raw') {
        await postToDiscord(item.content);
      } else {
        const embed = {
          title: item.title,
          description: `${item.points || ''}\n\n${item.summary || ''}`.trim(),
          url: item.link,
        };
        await postToDiscord(null, embed);
      }

      cache.add(item.id);
    }
  }

  saveCache(cache);
}

main();
