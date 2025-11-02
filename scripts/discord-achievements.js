/* Weekly achievements digest (JST 20:00 weekly)
   - Fetch last 7 days messages from achievements channel
   - Build concise summary and post
*/
const fs = require('fs');
process.env.TZ = process.env.TZ || 'Asia/Tokyo';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || process.env.ACHIEVEMENTS;
const LOG_DIR = 'DEJIRYU_DISCORD/logs';
const LOG_FILE = `${LOG_DIR}/achievements.log`;

function log(line){ 
  fs.mkdirSync(LOG_DIR,{recursive:true}); 
  const logLine = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG_FILE, `${logLine}\n`);
  console.log(logLine); // Also output to stdout for GitHub Actions logs
}
function assertEnv(n,v){ if(!v) throw new Error(`Missing env: ${n}`); }

async function fetchSince(channelId, sinceIso, limitMax=1000){
  const headers = { Authorization: `Bot ${BOT_TOKEN}` };
  const out=[]; let before; const sinceTs = new Date(sinceIso).getTime();
  while(out.length<limitMax){
    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);
    url.searchParams.set('limit','100');
    if(before) url.searchParams.set('before', before);
    const resp = await fetch(url, { headers });
    if(!resp.ok) throw new Error(`Discord fetch failed: ${resp.status}`);
    const batch = await resp.json();
    if(!Array.isArray(batch) || batch.length===0) break;
    for(const m of batch){
      const ts = new Date(m.timestamp).getTime();
      if(ts < sinceTs) return out;
      out.push(m);
    }
    before = batch[batch.length-1].id;
  }
  return out;
}

function getRotatingMessage(patternIndex) {
  const patterns = [
    `やっほー、デジリューだよ。今週は「できた！」報告がまだないみたい。ちょっと寂しいな…😢\n\nでも大丈夫！小さな「できた」でも全然OKだよ。新しいコードが動いた、ちょっと調子がいい日があった、なんでもいいからシェアしてくれると嬉しいな。みんなの成長、一緒に喜びたいから！✨`,
    
    `おはよう、デジリューだよ。今週の「できた！」報告、まだ見当たらないな。\n\n実は「できた」って、大きくなくても全然いいんだ。例えば「エラー直した」「新しいツール試した」「本1ページ読んだ」とか。どんな小さなことでも、積み重ねが大事だからね。気軽に投稿してみてほしいな 😊`,
    
    `やっほー、デジリューだよ。今週の「できた！」報告、待ってるんだけど見当たらないな。\n\n「できた」は恥ずかしがらなくていいよ。誰かと比べる必要もない。自分なりのペースで、自分なりの「できた」を報告してくれるだけでいいんだ。みんな応援してるから、気軽にシェアしてみて！💪`,
    
    `おはよう、デジリューだよ。今週は「できた！」報告が見当たらなくて、ちょっとさみしいな。\n\nでもね、「できた」って思える瞬間って、実は毎日あるかもしれない。朝起きれた、ご飯食べた、それも「できた」の一つかもしれない。技術的なことでも、日常のことでも、なんでもいいから「できた」と思えたことをシェアしてみてほしいな。きっと誰かが「いいね！」って言ってくれるよ 🌟`
  ];
  return patterns[patternIndex % patterns.length];
}

function formatSummary(nonBot){
  const now = new Date();
  const start = new Date(now.getTime() - 7*24*3600*1000);
  if(nonBot.length===0){
    // 4パターンから周期的に選ぶ（週番号で選ぶ）
    const weekOfYear = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 3600 * 1000));
    const patternIndex = weekOfYear % 4;
    log(`No messages found, using rotating message pattern ${patternIndex + 1}`);
    return getRotatingMessage(patternIndex);
  }
  const lines = [
    `${start.getMonth()+1}/${start.getDate()}〜${now.getMonth()+1}/${now.getDate()}の「できた！」報告まとめだぞ💪`,
    'みんなの成長、デジリューがしっかり見届けた！'
  ];
  for(const m of nonBot.slice(0,40)){
    const excerpt = (m.content||'').replace(/\n/g,' ').slice(0,120);
    lines.push(`- <@${m.author.id}>：${excerpt}${excerpt.length===120?'…':''}`);
  }
  lines.push('次もド派手な「できた！」を待ってるぞ🔥');
  return lines.join('\n');
}

async function post(content){
  const resp = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,{
    method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bot ${BOT_TOKEN}`}, body: JSON.stringify({content})
  });
  if(!resp.ok) throw new Error(`Discord post failed: ${resp.status}`);
}

(async()=>{
  try{
    assertEnv('DISCORD_BOT_TOKEN', BOT_TOKEN);
    assertEnv('DISCORD_CHANNEL_ID', CHANNEL_ID);
    const now = new Date();
    const since = new Date(now.getTime()-7*24*3600*1000);
    const raw = await fetchSince(CHANNEL_ID, since.toISOString(), 1200);
    const nonBot = raw.filter(m=>!m.author?.bot);
    log(`Fetched ${raw.length} messages, ${nonBot.length} non-bot.`);
    
    if (nonBot.length === 0) {
      log('No messages found, using rotating message');
    } else {
      const sampleMessages = nonBot.slice(0, 3).map(m => ({
        author: m.author?.username || 'unknown',
        content: (m.content || '').slice(0, 100),
        timestamp: m.timestamp
      }));
      log(`Sample messages: ${JSON.stringify(sampleMessages, null, 2)}`);
    }
    
    const msg = formatSummary(nonBot);
    log(`Final content to post: ${msg.slice(0, 150)}...`);
    await post(msg);
    log('posted achievements digest');
  }catch(e){
    log(`ERROR: ${e.stack||e.message}`);
    console.error(e);
    process.exitCode=1;
  }
})();
