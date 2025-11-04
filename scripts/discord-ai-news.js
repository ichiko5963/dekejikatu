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
const NEWS_API_KEY = process.env.NEWS_API_KEY || process.env.NEWS_API_KEY_ENV; // support both names

const LOG_DIR = 'DEJIRYU_DISCORD/logs';
const LOG_FILE = `${LOG_DIR}/ai-news.log`;
const DATA_DIR = 'DEJIRYU_DISCORD/data';
const SENT_URLS_FILE = `${DATA_DIR}/ai-news-sent.json`;

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  console.log(line);
}

function assertEnv(name, value) {
  if (!value) throw new Error(`Missing required env: ${name}`);
}

// 実行日のJSTでの日付範囲を計算（その日の00:00:00から23:59:59まで）
function getTodayDateRange() {
  const now = new Date();
  // UTC時刻を取得
  const utcNow = now.getTime();
  
  // JSTに変換（UTC+9時間）
  const jstOffset = 9 * 60 * 60 * 1000; // 9時間をミリ秒に変換
  const jstNow = new Date(utcNow + jstOffset);
  
  // JSTでの年月日を取得
  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = jstNow.getUTCMonth();
  const jstDate = jstNow.getUTCDate();
  
  // その日の00:00:00 JSTをUTCに変換
  const startJST = new Date(Date.UTC(jstYear, jstMonth, jstDate, 0, 0, 0));
  const startUTC = new Date(startJST.getTime() - jstOffset);
  
  // その日の23:59:59 JSTをUTCに変換
  const endJST = new Date(Date.UTC(jstYear, jstMonth, jstDate, 23, 59, 59, 999));
  const endUTC = new Date(endJST.getTime() - jstOffset);
  
  // NewsAPIはISO 8601形式を要求（YYYY-MM-DDTHH:mm:ss形式）
  const fromStr = startUTC.toISOString().slice(0, 19); // YYYY-MM-DDTHH:mm:ss
  const toStr = endUTC.toISOString().slice(0, 19);
  
  return { from: fromStr, to: toStr };
}

// 過去に送信したURLを読み込む
function loadSentUrls() {
  try {
    if (fs.existsSync(SENT_URLS_FILE)) {
      const content = fs.readFileSync(SENT_URLS_FILE, 'utf8');
      const data = JSON.parse(content);
      return new Set(data.urls || []);
    }
  } catch (err) {
    log(`Failed to load sent URLs: ${err.message}`);
  }
  return new Set();
}

// 送信したURLを保存（最新100件まで保持）
function saveSentUrls(urls) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const urlArray = Array.from(urls);
    // 最新100件だけ保持（古いものを削除）
    const limited = urlArray.slice(-100);
    fs.writeFileSync(SENT_URLS_FILE, JSON.stringify({ urls: limited }, null, 2));
    log(`Saved ${limited.length} sent URLs to ${SENT_URLS_FILE}`);
  } catch (err) {
    log(`Failed to save sent URLs: ${err.message}`);
  }
}

async function fetchNewsFromNewsAPI() {
  if (!NEWS_API_KEY) {
    log('NewsAPI key not set, skipping NewsAPI fetch');
    return [];
  }
  
  // 実行日のJSTでの日付範囲を取得
  const dateRange = getTodayDateRange();
  log(`Fetching news for date range: ${dateRange.from} to ${dateRange.to} (JST today)`);
  
  // 過去に送信したURLを読み込む
  const sentUrls = loadSentUrls();
  log(`Loaded ${sentUrls.size} previously sent URLs`);
  
  // Try Japanese first, then English as fallback
  const queries = [
    { q: 'artificial intelligence OR 生成AI', language: 'ja' },
    { q: 'artificial intelligence OR generative AI', language: 'en' }
  ];
  
  for (const query of queries) {
    try {
      const params = new URLSearchParams({
        q: query.q,
        language: query.language,
        pageSize: '20', // 多めに取得して重複除外後に選択
        sortBy: 'popularity',  // popularityで注目度の高いものを優先
        from: dateRange.from,  // その日の00:00:00
        to: dateRange.to,      // その日の23:59:59
      });
      log(`Trying NewsAPI with query: ${query.q} (${query.language}), date range: ${dateRange.from} to ${dateRange.to}`);
      
      const resp = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`, {
        headers: { 'X-Api-Key': NEWS_API_KEY },
      });
      
      if (!resp.ok) {
        const text = await resp.text();
        log(`NewsAPI HTTP ${resp.status}: ${text.slice(0, 200)}`);
        continue; // try next query
      }
      
      const data = await resp.json();
      log(`NewsAPI response status: ${data.status}, totalResults: ${data.totalResults || 0}`);
      
      if (data.status === 'error') {
        log(`NewsAPI error: ${data.message || 'unknown'}`);
        continue;
      }
      
      // 有効な記事を取得し、過去に送信していないものだけをフィルタ
      const items = (data.articles || [])
        .map(a => ({
          title: a.title,
          url: a.url,
          summary: a.description || a.content?.slice(0, 200) || '',
          publishedAt: a.publishedAt,
        }))
        .filter(a => a.title && a.url) // filter out invalid
        .filter(a => !sentUrls.has(a.url)); // 過去に送信していないものだけ
      
      log(`Found ${items.length} new articles (after filtering duplicates)`);
      
      if (items.length > 0) {
        // 最も注目度の高い3件を返す
        const selected = items.slice(0, 3);
        log(`NewsAPI success: selected ${selected.length} articles for today`);
        return selected;
      }
    } catch (err) {
      log(`NewsAPI exception: ${err.message}`);
      continue;
    }
  }
  
  log('NewsAPI: all queries failed or returned no results for today');
  return [];
}

function fallbackFormat(items) {
  const date = new Date();
  const jstDate = date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const head = `おはよう、デジリューだよ。${jstDate}はAIの動きが気になる朝。さくっと行こっか。`;
  if (!items.length) {
    return `${head}\n\n速報的に概要のみ：${jstDate}は目立ったニュースが拾えなかったぞ。別ソースも当たってみるね（Impact: 低）`;
  }
  const bullets = items.slice(0, 3).map(i => `- ${i.title}：${(i.summary || '詳細は本文で確認してね').replace(/\n/g, ' ')}  \n  ${i.url}`).join('\n');
  const tail = `時間がない人は、最初の1本だけでもOK。今日もいい一歩にしようね ☕`;
  return `${head}\n\n${bullets}\n\n${tail}`;
}

async function summarizeWithOpenAI(rawItems) {
  if (!OPENAI_API_KEY || !rawItems.length) return null;
  const date = new Date();
  const jstDate = date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const theme = '生成AI/AI政策/産業導入の動き';
  const trimmed = rawItems.slice(0, 3).map(i => ({
    title: i.title?.slice(0, 120) || '',
    url: i.url,
    summary: (i.summary || '').replace(/\n/g, ' ').slice(0, 280),
    publishedAt: i.publishedAt,
  }));
  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a Japanese tech editor who writes concise, accurate daily AI news digests for Discord. Avoid hype. Always mention the specific date of the news.' },
      { role: 'user', content: `以下のニュースは${jstDate}（本日）に公開された最新のAI関連ニュースです。本日の最も注目を集めている3件を厳選し、指示フォーマットで日本語で出力。\n- 日付: ${jstDate}（必ず明記）\n- テーマヒント: ${theme}\n- 形式: 導入1行（日付を含む）→箇条書き3件のみ（各1〜2行+リンク）→締め。300〜500文字。煽らず冷静に。必ず「本日${jstDate}の」という表現を含める。\n\n${JSON.stringify(trimmed, null, 2)}` },
    ],
    temperature: 0.4,
    max_tokens: 600,
  };
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      log(`OpenAI HTTP ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    log(`OpenAI exception: ${err.message}`);
    return null;
  }
}

async function postToDiscord(channelId, content) {
  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${BOT_TOKEN}` },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Discord post failed: ${resp.status} - ${text.slice(0, 200)}`);
  }
}

(async () => {
  try {
    assertEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    assertEnv('DISCORD_CHANNEL_ID', CHANNEL_ID);

    const date = new Date();
    const jstDate = date.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' });
    log(`Starting AI news fetch for ${jstDate}. NEWS_API_KEY present: ${!!NEWS_API_KEY}, OPENAI_API_KEY present: ${!!OPENAI_API_KEY}`);

    const raw = await fetchNewsFromNewsAPI();
    log(`Fetched ${raw.length} items from NewsAPI for today`);

    if (raw.length === 0) {
      log('No new articles found for today. Posting fallback message.');
      const msg = fallbackFormat([]);
      await postToDiscord(CHANNEL_ID, msg);
      log('Posted fallback message');
      return;
    }

    // 送信するURLを記録
    const sentUrls = loadSentUrls();
    raw.forEach(item => {
      if (item.url) {
        sentUrls.add(item.url);
      }
    });
    saveSentUrls(sentUrls);
    log(`Marked ${raw.length} URLs as sent`);

    const ai = await summarizeWithOpenAI(raw);
    const msg = ai || fallbackFormat(raw);

    await postToDiscord(CHANNEL_ID, msg);
    log(`Posted ai-news successfully for ${jstDate}`);
  } catch (e) {
    log(`ERROR: ${e.stack || e.message}`);
    console.error(e);
    process.exitCode = 1;
  }
})();
