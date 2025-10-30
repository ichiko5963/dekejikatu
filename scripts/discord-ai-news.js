/*
  AI News daily poster (JST 07:00 target)
  - Fetch 3–5 AI-related articles (NewsAPI if API key available)
  - Summarize/normalize with OpenAI into a concise Discord-friendly message
  - Post to target channel via Discord REST
*/

const fs = require('fs');

process.env.TZ = process.env.TZ || 'Asia/Tokyo';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || process.env.AI_NEWS_CHANNEL_ID; // fallback alias
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const LOG_DIR = 'DEJIRYU_DISCORD/logs';
const LOG_FILE = `${LOG_DIR}/ai-news.log`;

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

function assertEnv(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}

async function fetchNewsFromNewsAPI() {
  if (!NEWS_API_KEY) return [];
  const params = new URLSearchParams({
    q: 'artificial intelligence OR generative AI',
    language: 'ja',
    pageSize: '8',
    sortBy: 'publishedAt',
  });
  const resp = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, {
    headers: { 'X-Api-Key': NEWS_API_KEY },
  });
  if (!resp.ok) {
    log(`NewsAPI failed: ${resp.status}`);
    return [];
  }
  const data = await resp.json();
  const items = (data.articles || []).map(a => ({
    title: a.title,
    url: a.url,
    summary: a.description || '',
  }));
  return items.slice(0, 5);
}

function fallbackFormat(items) {
  const date = new Date();
  const head = `おはよう、デジリューだよ。今日はAIの動きが気になる朝。さくっと行こっか。`;
  if (!items.length) {
    return `${head}\n\n速報的に概要のみ：今日は目立ったニュースが拾えなかったぞ。別ソースも当たってみるね（Impact: 低）`;
  }
  const bullets = items.slice(0, 5).map(i => `- ${i.title}：${(i.summary || '詳細は本文で確認してね').replace(/\n/g, ' ')}  \n  ${i.url}`).join('\n');
  const tail = `時間がない人は、最初の1本だけでもOK。今日もいい一歩にしようね ☕`;
  return `${head}\n\n${bullets}\n\n${tail}`;
}

async function summarizeWithOpenAI(rawItems) {
  if (!OPENAI_API_KEY || !rawItems.length) return null;
  const date = new Date();
  const theme = '生成AI/AI政策/産業導入の動き';
  const trimmed = rawItems.slice(0, 5).map(i => ({
    title: i.title?.slice(0, 120) || '',
    url: i.url,
    summary: (i.summary || '').replace(/\n/g, ' ').slice(0, 280),
  }));
  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a Japanese tech editor who writes concise, accurate daily AI news digests for Discord. Avoid hype.' },
      { role: 'user', content: `以下のニュースから本日の要点を3〜5本に整理し、指示フォーマットで日本語で出力。\n- 日付: ${date.toLocaleDateString('ja-JP')}\n- テーマヒント: ${theme}\n- 形式: 導入1行→箇条書き3〜5件（各1〜2行+リンク）→締め。350〜650文字。煽らず冷静に。${JSON.stringify(trimmed, null, 2)}` },
    ],
    temperature: 0.4,
    max_tokens: 600,
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    log(`OpenAI failed: ${resp.status}`);
    return null;
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function postToDiscord(channelId, content) {
  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`Discord post failed: ${resp.status}`);
}

(async () => {
  try {
    assertEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    assertEnv('DISCORD_CHANNEL_ID', CHANNEL_ID);

    const raw = await fetchNewsFromNewsAPI();
    log(`fetched items: ${raw.length}`);

    const ai = await summarizeWithOpenAI(raw);
    const msg = ai || fallbackFormat(raw);

    await postToDiscord(CHANNEL_ID, msg);
    log('posted ai-news successfully');
  } catch (e) {
    log(`ERROR: ${e.stack || e.message}`);
    console.error(e);
    process.exitCode = 1;
  }
})();
