/*
  Self-intro digest poster
  - Collect last 4 days of non-bot messages from a channel
  - Optionally summarize with OpenAI
  - Post a warm digest message back to the channel
*/

const fs = require('fs');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
process.env.TZ = process.env.TZ || 'Asia/Tokyo';

const LOG_DIR = 'DEJIRYU_DISCORD/logs';
const LOG_FILE = `${LOG_DIR}/selfintro.log`;

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
}

function assertEnv(name, value) {
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
}

async function fetchMessagesSince(channelId, sinceIso, limitMax = 500) {
  const headers = { Authorization: `Bot ${BOT_TOKEN}` };
  const messages = [];
  let before = undefined;
  const sinceTs = new Date(sinceIso).getTime();

  while (messages.length < limitMax) {
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit', '100');
    if (before) url.searchParams.set('before', before);

    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Discord fetch messages failed: ${resp.status}`);
    const batch = await resp.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const m of batch) {
      const created = new Date(m.timestamp).getTime();
      if (created < sinceTs) {
        return messages; // we went past the window
      }
      messages.push(m);
    }
    before = batch[batch.length - 1].id;
  }
  return messages;
}

function buildFallbackSummary(nonBot) {
  const byUser = new Map();
  for (const m of nonBot) {
    const key = m.author.id;
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(m);
  }
  const now = new Date();
  const start = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
  if (byUser.size === 0) {
    return (
      `やっほー、デジリューだよ。${start.getMonth() + 1}/${start.getDate()}〜${now.getMonth() + 1}/${now.getDate()}は新しい自己紹介は見当たらなかったみたい。` +
      '\nまだ名乗っていない人は、短い一言からでも歓迎だよ。みんなでつながろう！'
    );
  }
  const lines = [
    `やっほー、デジリューだよ。${start.getMonth() + 1}/${start.getDate()}〜${now.getMonth() + 1}/${now.getDate()}の自己紹介をまとめてお届け！`,
  ];
  for (const [userId, msgs] of byUser.entries()) {
    const latest = msgs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    const excerpt = (latest.content || '').replace(/\n/g, ' ').slice(0, 160) + (latest.content && latest.content.length > 160 ? '…' : '');
    lines.push(`- <@${userId}> さん：${excerpt || '自己紹介をしてくれたよ！'}`);
  }
  lines.push('');
  lines.push('気になった人には、まずは一言リアクションやスレッドでご挨拶してみようね 😊');
  return lines.join('\n');
}

async function summarizeWithOpenAI(nonBot) {
  if (!OPENAI_API_KEY) return null;
  const now = new Date();
  const start = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
  const examples = nonBot
    .slice(0, 50)
    .map(m => `- user:${m.author.username} (${m.author.id}) => ${m.content?.slice(0, 200) || ''}`)
    .join('\n');

  const prompt = `以下はDiscordの#自己紹介チャンネルの直近4日分の抜粋です。日本語で、温度感のある歓迎メッセージ+簡単な抜粋を200〜300字でまとめてください。固有名詞は伏せ気味に、絵文字は最大1つ。期間: ${start.toISOString()} 〜 ${now.toISOString()}\n\n${examples}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a Japanese copywriter who writes warm, concise summaries for a Discord community.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 450,
    }),
  });
  if (!resp.ok) {
    log(`OpenAI failed: ${resp.status}`);
    return null;
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function postMessage(channelId, content) {
  const resp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${BOT_TOKEN}`,
    },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`Discord post failed: ${resp.status}`);
  return resp.json();
}

(async () => {
  try {
    assertEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    assertEnv('DISCORD_CHANNEL_ID', CHANNEL_ID);

    const now = new Date();
    const since = new Date(now.getTime() - 4 * 24 * 3600 * 1000);
    log(`Collecting messages since ${since.toISOString()} from ${CHANNEL_ID}`);

    const raw = await fetchMessagesSince(CHANNEL_ID, since.toISOString(), 800);
    const nonBot = raw.filter(m => !m.author?.bot);
    log(`Fetched ${raw.length} messages, ${nonBot.length} non-bot.`);

    const ai = await summarizeWithOpenAI(nonBot);
    const fallback = buildFallbackSummary(nonBot);
    const content = ai || fallback;

    await postMessage(CHANNEL_ID, content);
    log('Posted digest successfully.');

    // job summary (stdout)
    console.log('summary::posted self-intro digest');
    console.log(`window::${since.toISOString()}..${now.toISOString()}`);
  } catch (err) {
    log(`ERROR: ${err.stack || err.message}`);
    console.error(err);
    process.exitCode = 1;
  }
})();
