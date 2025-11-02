/*
  Self-intro digest poster
  - Collect last 10 days of non-bot messages from a channel
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
  const logLine = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG_FILE, `${logLine}\n`);
  console.log(logLine); // Also output to stdout for GitHub Actions logs
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

function getRotatingMessage(patternIndex) {
  const patterns = [
    `最近はいろんなAI好きが自己紹介してくれてるみたい。機械学習や生成AIに興味がある人、実際にAIツールを使ってみてる人、それぞれの楽しみ方があるのが面白いな。\n\n新しく参加した人も、どんなAIツール使ってるか、どんなことに興味があるか、気軽に自己紹介してくれると嬉しいよ 😊`,
    
    `いろんなAI好きが自己紹介してくれてて、ほんとに嬉しい。チャットボット作りにハマってる人もいれば、画像生成AIで創作してる人もいるし、それぞれの関わり方があって参考になるな。\n\nまだ自己紹介してない人も、短い一言からでもOK。どんなAI体験してるか、ぜひシェアしてほしいな。`,
    
    `AIに興味がある人たちの自己紹介、どんどん増えてて楽しい。研究してる人もいれば、趣味で触ってる人もいて、バランスがいい感じ。自然言語処理に興味ある人もいるし、データサイエンスやってる人もいて、刺激になるな。\n\nこれからもいろんな自己紹介、待ってるよ ✨`
  ];
  return patterns[patternIndex % patterns.length];
}

function buildFallbackSummary(nonBot) {
  const byUser = new Map();
  for (const m of nonBot) {
    const key = m.author.id;
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key).push(m);
  }
  const now = new Date();
  const start = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
  if (byUser.size === 0) {
    // メッセージがない場合は、3パターンから周期的に選ぶ（日付の日にちで選ぶ）
    const dayOfMonth = now.getDate();
    const patternIndex = dayOfMonth % 3;
    log(`No messages found, using rotating message pattern ${patternIndex + 1}`);
    return getRotatingMessage(patternIndex);
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
  const start = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
  
  // すべてのメッセージを取得（上限は100件程度）
  const examples = nonBot
    .slice(0, 100)
    .map(m => {
      const content = (m.content || '').trim();
      return content ? `- ${m.author.username}: ${content}` : null;
    })
    .filter(Boolean)
    .join('\n\n');
  
  log(`Sending ${nonBot.length} messages to OpenAI (showing first ${Math.min(100, nonBot.length)} in prompt)`);
  if (examples) {
    log(`Sample messages (first 500 chars): ${examples.slice(0, 500)}`);
  }

  const prompt = `以下はDiscordの#自己紹介チャンネルの直近10日分の実際のメッセージ内容です。これらのメッセージから、実際に自己紹介してくれた人の具体的な内容（趣味、特技、興味のあることなど）を反映したサマリーを作成してください。

重要な要件:
- 実際のメッセージ内容を具体的に反映する（「様々な趣味」などの抽象表現は避ける）
- デジリューの口調（軽やかで前向き、簡潔で読みやすい）
- 200〜350文字程度
- 絵文字は最大1つまで
- 固有名詞（ゲーム名、作品名など）は自然に含めてOK

メッセージ一覧:
${examples}

上記のメッセージ内容を基に、具体的で温かみのあるサマリーを作成してください。`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'あなたは「デジリュー」というDiscord向けナビゲーターボットです。口調は軽やかで前向き、簡潔で読みやすく。実際のメッセージ内容を具体的に反映し、抽象的な表現は避けます。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.6,
      max_tokens: 500,
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
    const since = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
    log(`Collecting messages since ${since.toISOString()} from ${CHANNEL_ID}`);

    const raw = await fetchMessagesSince(CHANNEL_ID, since.toISOString(), 800);
    const nonBot = raw.filter(m => !m.author?.bot);
    log(`Fetched ${raw.length} messages, ${nonBot.length} non-bot.`);
    
    // デバッグ: 取得したメッセージのサンプルをログに出力
    if (nonBot.length > 0) {
      const sampleMessages = nonBot.slice(0, 3).map(m => ({
        author: m.author?.username || 'unknown',
        content: (m.content || '').slice(0, 100),
        timestamp: m.timestamp
      }));
      log(`Sample messages: ${JSON.stringify(sampleMessages, null, 2)}`);
    } else {
      log('No non-bot messages found in the period');
    }

    // メッセージがない場合は3パターンから選ぶ
    if (nonBot.length === 0) {
      const now = new Date();
      const dayOfMonth = now.getDate();
      const patternIndex = dayOfMonth % 3;
      log(`No messages found, using rotating message pattern ${patternIndex + 1}`);
      const content = getRotatingMessage(patternIndex);
      await postMessage(CHANNEL_ID, content);
      log('Posted rotating message successfully.');
      console.log('summary::posted rotating message (no messages found)');
      console.log(`window::${since.toISOString()}..${now.toISOString()}`);
      return;
    }
    
    const ai = await summarizeWithOpenAI(nonBot);
    log(`OpenAI summary result: ${ai ? 'success' : 'failed or skipped'}`);
    if (ai) {
      log(`OpenAI summary preview: ${ai.slice(0, 200)}...`);
    }
    const fallback = buildFallbackSummary(nonBot);
    const content = ai || fallback;
    log(`Final content to post: ${content.slice(0, 150)}...`);

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
