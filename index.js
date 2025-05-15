const fs = require('fs');
const axios = require('axios');
const Parser = require('rss-parser');
require('dotenv').config();

const parser = new Parser();
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

  for (const feed of feeds) {
    try {
      const feedData = await parser.parseURL(feed.url);

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
      console.error(`❌ Error checking feed ${feed.name}:`, err.message);
    }
  }

  savePostedIds(postedIds);
}

checkFeeds();
