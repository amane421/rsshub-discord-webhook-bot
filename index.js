// index.js
import fetch from 'node-fetch';
import { parseFeed } from './utils.js';
import feeds from './feeds.json' assert { type: 'json' };
import fs from 'fs/promises';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CACHE_FILE = './posted_ids.json';

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    return new Set(JSON.parse(data));
  } catch (e) {
    return new Set();
  }
}

async function saveCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify([...cache]), 'utf-8');
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
  const cache = await loadCache();

  for (const feed of feeds) {
    const { url, format } = feed;
    const items = await parseFeed(url);

    for (const item of items) {
      if (cache.has(item.id)) continue;

      if (format === 'raw') {
        await postToDiscord(item.content);
      } else {
        const embed = {
          title: item.title,
          description: `${item.points}\n\n${item.summary}`,
          url: item.link,
        };
        await postToDiscord(null, embed);
      }

      cache.add(item.id);
    }
  }
  await saveCache(cache);
}

main();
