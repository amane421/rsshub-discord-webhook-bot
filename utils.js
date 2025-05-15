const Parser = require('rss-parser');
const parser = new Parser();

function truncate(text, maxLength) {
  return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
}

function extractFormattedContent(item) {
  const lines = item.content.split('\n');
  const title = lines[0] || '';
  const importantLines = [];
  const summaryLines = [];
  let isImportant = false;
  let isSummary = false;

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('---------') || line.startsWith('--------')) {
      isImportant = !isImportant;
      continue;
    }
    if (line.startsWith('【まとめ】')) {
      isSummary = true;
      continue;
    }
    if (isImportant) importantLines.push(line);
    else if (isSummary) summaryLines.push(line);
  }

  return {
    title: title,
    points: importantLines.join('\n'),
    summary: summaryLines.join('\n'),
    url: item.link
  };
}

async function fetchFeedItems(feed) {
  const feedData = await parser.parseURL(feed.url);
  return feedData.items.map(item => {
    if (feed.format === 'formatted') {
      const extracted = extractFormattedContent(item);
      return {
        id: item.guid,
        content: `📢 ${extracted.title}\n\n${extracted.points}\n\n📝 ${extracted.summary}\n🔗 ${extracted.url}`
      };
    } else {
      return {
        id: item.guid,
        content: truncate(item.title + '\n' + item.contentSnippet, 1000)
      };
    }
  });
}

module.exports = { fetchFeedItems };
