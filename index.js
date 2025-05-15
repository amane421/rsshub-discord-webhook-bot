const fetch = require('node-fetch');
const { fetchFeedItems } = require('./utils.js');
const fs = require('fs');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CACHE_FILE = './posted_ids.json';
const FEEDS = require('./feeds.json');

function loadCache() {
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf-8');
    return new Set(JSON.parse(data));
  } catch (e) {
    return new Set();
  }
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache]), 'utf-8');
}

async function postToDiscord(content, embed = null) {
  const body = embed ? { embeds: [embed] } : { content };
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function main() {
  const cache = loadCache();

  for (const feed of FEEDS) {
    const items = await fetchFeedItems(feed);

    for (const item of items) {
      if (cache.has(item.id)) continue;

      await postToDiscord(item.content);
      cache.add(item.id);
    }
  }

  saveCache(cache);
}

main();
