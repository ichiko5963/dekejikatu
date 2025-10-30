/* Consultation prompt poster (JST 12:00 every 5 days)
   - Posts a friendly prompt to the consultation channel
*/
const fs = require('fs');
process.env.TZ = process.env.TZ || 'Asia/Tokyo';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || process.env.CONSULTATION;
const ROLE_ID = process.env.CONSULTATION_ROLE_ID || '';
const LOG_DIR = 'DEJIRYU_DISCORD/logs';
const LOG_FILE = `${LOG_DIR}/consultation.log`;

function log(line){ fs.mkdirSync(LOG_DIR,{recursive:true}); fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`); }
function assertEnv(n,v){ if(!v) throw new Error(`Missing env: ${n}`); }

const VARIATIONS = [
  '質問はないか？デジリューの診察時間だぞ。遠慮なく呼んでくれよな！',
  'お困りごとはないか？みんなの知恵を集めて一歩進めよう。',
  '詰まってるなら、その場で聞けばOK。軽い相談でもウェルカムだ！'
];

async function post(content){
  const resp = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,{
    method:'POST',
    headers:{'Content-Type':'application/json', Authorization:`Bot ${BOT_TOKEN}`},
    body: JSON.stringify({content})
  });
  if(!resp.ok) throw new Error(`Discord post failed: ${resp.status}`);
}

(async()=>{
  try{
    assertEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    assertEnv('DISCORD_CHANNEL_ID', CHANNEL_ID);
    const msg = VARIATIONS[Math.floor(Math.random()*VARIATIONS.length)];
    const ping = ROLE_ID ? `<@&${ROLE_ID}>\n` : '';
    await post(`${ping}デジリューからのおたずねタイム！\n${msg}\n思いついた瞬間に投げてくれていいんだぞ。`);
    log('posted consultation prompt');
  }catch(e){
    log(`ERROR: ${e.stack||e.message}`);
    console.error(e);
    process.exitCode=1;
  }
})();
