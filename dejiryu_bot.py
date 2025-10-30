'''
DejiRyu Discord automation bot.

This module implements all scheduled flows requested for the DejiKatsu server:
- #😍自己紹介: 4日ごとの自己紹介まとめ
- #📝最新情報: 朝7時のAIニュース配信
- #交流会: 週次リアクションランキング
- #限定コンテンツ: Aircle+コンテンツのローテーション配信
- #イベント情報: 3日前/1日前/6時間前の自動リマインド
- #できたを報告する部屋: 週次達成報告まとめ
- #相談部屋: 5日ごとの相談呼びかけ

The tone follows the lively DejiRyu character inspired by Ryuukuru.
'''

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import aiohttp
import discord
from discord import Intents, Message
from discord.ext import commands, tasks
from zoneinfo import ZoneInfo
from dotenv import load_dotenv

LOGGER = logging.getLogger('dejiryu')


def load_json(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f'Config not found: {path}')
    return json.loads(path.read_text(encoding='utf-8'))


@dataclass
class ExclusiveContentItem:
    title: str
    description: str
    url: Optional[str] = None


@dataclass
class ConsultationPrompt:
    ping_role_id: Optional[int]
    message_variations: List[str]


class Config:
    def __init__(self, data: Dict[str, Any]) -> None:
        if 'channels' not in data:
            raise KeyError('channels section is required in the config file')

        self.discord_token_env: str = data.get('discord_token_env', 'DISCORD_BOT_TOKEN')
        self.guild_id: Optional[int] = int(data['guild_id']) if data.get('guild_id') else None
        self.tz: ZoneInfo = ZoneInfo(data.get('timezone', 'Asia/Tokyo'))

        self.channels: Dict[str, int] = {name: int(channel_id) for name, channel_id in data['channels'].items()}

        ai_news = data.get('ai_news', {})
        self.ai_news_api_key_env: str = ai_news.get('news_api_key_env', 'NEWS_API_KEY')
        self.ai_news_query: str = ai_news.get('news_api_query', 'artificial intelligence')
        self.ai_news_language: str = ai_news.get('news_api_language', 'ja')
        self.ai_news_articles_per_day: int = int(ai_news.get('articles_per_day', 3))

        exclusive = data.get('exclusive_content', {})
        self.exclusive_rotation_days: int = int(exclusive.get('content_rotation_days', 7))
        self.exclusive_items: List[ExclusiveContentItem] = [
            ExclusiveContentItem(
                title=item['title'],
                description=item.get('description', ''),
                url=item.get('url'),
            )
            for item in exclusive.get('items', [])
        ]

        prompt = data.get('consultation_prompt', {})
        role_id_str = prompt.get('ping_role_id')
        self.consultation_prompt = ConsultationPrompt(
            ping_role_id=int(role_id_str) if role_id_str else None,
            message_variations=prompt.get(
                'message_variations',
                [
                    '質問はないか？デジリューの診察時間だぞ。遠慮なく呼んでくれよな！',
                    '困ったらデジリューがいる。相談室でみんなの知恵を借りていこうぜ！',
                ],
            ),
        )

        self._validate()

    def _validate(self) -> None:
        required_channels = {
            'self_intro',
            'ai_news',
            'events',
            'achievements',
            'consultation',
        }
        missing = required_channels - self.channels.keys()
        if missing:
            raise ValueError(f'Missing channels in config: {", ".join(sorted(missing))}')

        if self.exclusive_rotation_days < 1:
            raise ValueError('exclusive_content.content_rotation_days must be >= 1')

        if not self.consultation_prompt.message_variations:
            raise ValueError('At least one consultation message variation is required.')


class StateManager:
    '''JSON-backed state store so schedules survive restarts.'''

    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._data: Dict[str, Any] = {
            'reaction_counts': {},
            'achievement_logs': {},
            'exclusive_rotation_index': 0,
            'events': [],
            'last_consultation_ping': None,
            'last_self_intro_digest': None,
            'last_ai_news_push': None,
        }
        if path.exists():
            try:
                self._data.update(json.loads(path.read_text(encoding='utf-8')))
            except json.JSONDecodeError:
                LOGGER.warning('State file is corrupted. Recreating default state.')

    async def update(self, key: str, value: Any) -> None:
        async with self._lock:
            self._data[key] = value
            self._flush()

    async def mutate(self, key: str, mutate_fn: Callable[[Any], Any]) -> Any:
        async with self._lock:
            current = self._data.get(key)
            new_value = mutate_fn(current)
            self._data[key] = new_value
            self._flush()
            return new_value

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def _flush(self) -> None:
        self._path.write_text(
            json.dumps(self._data, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )


def iso_week_key(dt: datetime) -> str:
    return f'{dt.isocalendar().year}-W{dt.isocalendar().week:02d}'


def next_run_at(hour: int, minute: int, tz: ZoneInfo) -> datetime:
    now = datetime.now(tz)
    candidate = datetime.combine(now.date(), time(hour=hour, minute=minute, tzinfo=tz))
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate


def mention_user(bot: commands.Bot, user_id: int) -> str:
    user = bot.get_user(user_id)
    return user.mention if user else f'<@{user_id}>'


class DejiRyuBot(commands.Bot):
    def __init__(self, config: Config, state: StateManager) -> None:
        intents = Intents.default()
        intents.message_content = True
        intents.members = True
        intents.reactions = True
        intents.guilds = True

        super().__init__(command_prefix='!', intents=intents)
        self.config = config
        self.state = state
        self.http_session: Optional[aiohttp.ClientSession] = None

        self.add_command(self.schedule_event)

    async def setup_hook(self) -> None:
        self.http_session = aiohttp.ClientSession()

    async def close(self) -> None:
        if self.http_session:
            await self.http_session.close()
        await super().close()

    # -------------------------------------------------------------- Events --
    async def on_ready(self) -> None:
        LOGGER.info('DejiRyu online as %s', self.user)
        if not self.self_intro_digest.is_running():
            self.self_intro_digest.start()
        if not self.ai_news_task.is_running():
            self.ai_news_task.start()
        if not self.interaction_report.is_running():
            self.interaction_report.start()
        if not self.exclusive_drop.is_running():
            self.exclusive_drop.start()
        if not self.achievement_report.is_running():
            self.achievement_report.start()
        if not self.consultation_ping.is_running():
            self.consultation_ping.start()
        if not self.event_reminder.is_running():
            self.event_reminder.start()

    async def on_message(self, message: Message) -> None:
        if message.author.bot:
            return

        await self.process_commands(message)

        if message.channel.id == self.config.channels['achievements']:
            await self._record_achievement(message)

    async def on_raw_reaction_add(self, payload: discord.RawReactionActionEvent) -> None:
        await self._handle_reaction_delta(payload, delta=1)

    async def on_raw_reaction_remove(self, payload: discord.RawReactionActionEvent) -> None:
        await self._handle_reaction_delta(payload, delta=-1)

    async def _handle_reaction_delta(
        self,
        payload: discord.RawReactionActionEvent,
        delta: int,
    ) -> None:
        if payload.guild_id is None:
            return
        interaction_channel_id = self.config.channels.get('interaction')
        if not interaction_channel_id:
            return
        if payload.channel_id != interaction_channel_id:
            return

        tz = self.config.tz
        week_key = iso_week_key(datetime.now(tz))

        async def mutate(counts: Optional[Dict[str, Dict[str, int]]]) -> Dict[str, Dict[str, int]]:
            counts = counts or {}
            week_counts = counts.get(week_key, {})
            user_key = str(payload.user_id)
            week_counts[user_key] = max(0, week_counts.get(user_key, 0) + delta)
            counts[week_key] = week_counts
            return counts

        await self.state.mutate('reaction_counts', mutate)

    async def _record_achievement(self, message: Message) -> None:
        tz = self.config.tz
        week_key = iso_week_key(datetime.now(tz))

        async def mutate(logs: Optional[Dict[str, List[int]]]) -> Dict[str, List[int]]:
            logs = logs or {}
            week_logs = logs.get(week_key, [])
            week_logs.append(message.id)
            logs[week_key] = week_logs
            return logs

        await self.state.mutate('achievement_logs', mutate)

    # ------------------------------------------------------------ Commands --
    @commands.command(name='event')
    async def schedule_event(self, ctx: commands.Context, date: str, time_: str, *, title: str) -> None:
        '''
        Register an event for reminder automation.

        Usage:
            !event 2025-03-10 19:30 春のキックオフ会
        '''
        tz = self.config.tz
        try:
            event_datetime = datetime.strptime(f'{date} {time_}', '%Y-%m-%d %H:%M')
        except ValueError:
            await ctx.reply('日付は YYYY-MM-DD HH:MM 形式で頼むぞ！例: `!event 2025-03-10 19:30 春のキックオフ会`')
            return

        event_datetime = event_datetime.replace(tzinfo=tz)
        reminders = [
            event_datetime - timedelta(days=3),
            event_datetime - timedelta(days=1),
            event_datetime - timedelta(hours=6),
        ]

        event_payload = {
            'message_id': ctx.message.id,
            'channel_id': ctx.channel.id,
            'title': title.strip(),
            'event_time': event_datetime.isoformat(),
            'reminders': [dt.isoformat() for dt in reminders],
            'reminded': [],
        }

        async def mutate(events: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
            events = events or []
            events.append(event_payload)
            return events

        await self.state.mutate('events', mutate)
        await ctx.reply(f'了解だぞ！イベント「{title}」の予定をキャッチした。3日前・1日前・6時間前にデジリューが吠えるから覚悟しててくれ！')

    # ---------------------------------------------------------- Schedules --
    @tasks.loop(hours=96)
    async def self_intro_digest(self) -> None:
        channel = self.get_channel(self.config.channels['self_intro'])
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#😍自己紹介 channel not found or invalid.')
            return

        tz = self.config.tz
        now = datetime.now(tz)
        start = now - timedelta(days=4)
        messages = await self._collect_messages_between(channel, start, now)

        grouped: Dict[int, List[Message]] = defaultdict(list)
        for msg in messages:
            grouped[msg.author.id].append(msg)

        if not grouped:
            summary = (
                f'デジリューが巡回完了！{start:%m/%d}〜{now:%m/%d}の間に新しい自己紹介はなかったぞ。\n'
                'まだ名乗ってない仲間は、どしどし自己紹介してくれよな！'
            )
        else:
            lines = [
                f'デジリューの自己紹介パトロールだぞ！{start:%m/%d}〜{now:%m/%d}のニューフェイスをまとめたぜ🔥',
            ]
            for user_id, msgs in grouped.items():
                latest = max(msgs, key=lambda m: m.created_at)
                intro_excerpt = latest.content[:160].replace('\n', ' ')
                if len(latest.content) > 160:
                    intro_excerpt += '…'
                lines.append(f'- {mention_user(self, user_id)} さん：{intro_excerpt or "自己紹介をしてくれたぞ！"}')
            lines.append('')
            lines.append('仲良くなるチャンスを逃すなよ！気になった子にはスレッドで声をかけてみてくれ！')
            summary = '\n'.join(lines)

        await channel.send(summary)
        await self.state.update('last_self_intro_digest', now.isoformat())

    @self_intro_digest.before_loop
    async def before_self_intro_digest(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(15, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(hours=24)
    async def ai_news_task(self) -> None:
        channel = self.get_channel(self.config.channels['ai_news'])
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#📝最新情報 channel not found or invalid.')
            return

        articles = await self.fetch_ai_news()
        today = datetime.now(self.config.tz)

        if not articles:
            await channel.send('デジリュー速報…今日はAIニュースが拾えなかった。ソース追加してくれたらもっと熱いネタを届けられるぞ！')
        else:
            lines = [
                f'おはデジー！{today:%m月%d日}のAIトピックをお届けだぞ☀️🤖',
                '朝のアウトプットに使ってくれよな！',
                '',
            ]
            for article in articles:
                title = article.get('title', 'タイトル未設定')
                url = article.get('url')
                summary = article.get('summary', '')
                block = [f'- **{title}**']
                if summary:
                    block.append(f'  {summary}')
                if url:
                    block.append(f'  {url}')
                lines.append('\n'.join(block))
            await channel.send('\n'.join(lines))

        await self.state.update('last_ai_news_push', today.isoformat())

    @ai_news_task.before_loop
    async def before_ai_news_task(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(7, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(hours=168)
    async def interaction_report(self) -> None:
        interaction_channel_id = self.config.channels.get('interaction')
        if not interaction_channel_id:
            return
        channel = self.get_channel(interaction_channel_id)
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#交流会 channel not found or invalid.')
            return

        tz = self.config.tz
        now = datetime.now(tz)
        last_week = now - timedelta(days=7)
        week_key = iso_week_key(last_week)
        counts: Dict[str, int] = self.state.get('reaction_counts', {}).get(week_key, {})

        if not counts:
            await channel.send('デジリューからの報告だ！先週はリアクションが少なめだったぞ。次はもっとワイワイしようぜ！🔥')
        else:
            sorted_counts = sorted(counts.items(), key=lambda item: item[1], reverse=True)
            lines = [
                f'デジリューの交流会ランキング発表！ ({last_week:%m/%d}〜{now:%m/%d})',
                'リアクション王は誰だ！？',
            ]
            for idx, (user_id, count) in enumerate(sorted_counts[:10], start=1):
                lines.append(f'{idx}. {mention_user(self, int(user_id))}：{count}リアクション')
            lines.append('今週もデジリューを驚かせるリアクション頼むぞ！🌟')
            await channel.send('\n'.join(lines))

        async def mutate(counts_all: Optional[Dict[str, Dict[str, int]]]) -> Dict[str, Dict[str, int]]:
            counts_all = counts_all or {}
            counts_all.pop(week_key, None)
            return counts_all

        await self.state.mutate('reaction_counts', mutate)

    @interaction_report.before_loop
    async def before_interaction_report(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(10, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(hours=24)
    async def exclusive_drop(self) -> None:
        exclusive_channel_id = self.config.channels.get('exclusive')
        if not exclusive_channel_id:
            return
        if not self.config.exclusive_items:
            return

        channel = self.get_channel(exclusive_channel_id)
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#限定コンテンツ channel not found or invalid.')
            return

        now = datetime.now(self.config.tz)
        last_push_iso = self.state.get('last_exclusive_drop')
        if last_push_iso:
            last_push = datetime.fromisoformat(last_push_iso)
            if now - last_push < timedelta(days=self.config.exclusive_rotation_days):
                return

        index = self.state.get('exclusive_rotation_index', 0) % len(self.config.exclusive_items)
        item = self.config.exclusive_items[index]

        lines = [
            'デジリューの極秘コンテンツ搬入だぞ🔥',
            f'**{item.title}**',
            item.description,
        ]
        if item.url:
            lines.append(f'アクセスはこちら👉 {item.url}')
        lines.append('感想や活用例をスレッドで自慢してくれよな！')

        await channel.send('\n'.join(lines))
        await self.state.update('exclusive_rotation_index', index + 1)
        await self.state.update('last_exclusive_drop', now.isoformat())

    @exclusive_drop.before_loop
    async def before_exclusive_drop(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(21, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(hours=168)
    async def achievement_report(self) -> None:
        channel = self.get_channel(self.config.channels['achievements'])
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#できたを報告する部屋 channel not found or invalid.')
            return

        tz = self.config.tz
        now = datetime.now(tz)
        last_week = now - timedelta(days=7)
        week_key = iso_week_key(last_week)
        logs: Dict[str, List[int]] = self.state.get('achievement_logs', {})
        message_ids = logs.get(week_key, [])

        if not message_ids:
            await channel.send('デジリュー通信！先週は「できた！」報告が見当たらなかったぞ…。みんなの挑戦を聞かせてくれ！')
        else:
            guild = self.get_guild(self.config.guild_id) if self.config.guild_id else None
            lines = [
                f'{last_week:%m/%d}〜{now:%m/%d}の「できた！」報告まとめだぞ💪',
                'みんなの成長、デジリューがしっかり見届けた！',
            ]
            for message_id in message_ids:
                try:
                    message = await channel.fetch_message(message_id)
                except discord.NotFound:
                    continue
                author = message.author.mention
                if guild:
                    member = guild.get_member(message.author.id)
                    if member:
                        author = member.mention
                excerpt = message.content[:120].replace('\n', ' ')
                lines.append(f'- {author}：{excerpt}…')
            lines.append('次もド派手な「できた！」を待ってるぞ🔥')
            await channel.send('\n'.join(lines))

        async def mutate(logs_all: Optional[Dict[str, List[int]]]) -> Dict[str, List[int]]:
            logs_all = logs_all or {}
            logs_all.pop(week_key, None)
            return logs_all

        await self.state.mutate('achievement_logs', mutate)

    @achievement_report.before_loop
    async def before_achievement_report(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(20, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(hours=120)
    async def consultation_ping(self) -> None:
        channel = self.get_channel(self.config.channels['consultation'])
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#相談部屋 channel not found or invalid.')
            return

        prompt_cfg = self.config.consultation_prompt
        message = random.choice(prompt_cfg.message_variations)
        ping = f'<@&{prompt_cfg.ping_role_id}>\n' if prompt_cfg.ping_role_id else ''

        await channel.send(
            f'{ping}デジリューからのおたずねタイム！\n{message}\n疑問が浮かんだ瞬間に投げてくれていいんだぞ。'
        )
        await self.state.update('last_consultation_ping', datetime.now(self.config.tz).isoformat())

    @consultation_ping.before_loop
    async def before_consultation_ping(self) -> None:
        await self.wait_until_ready()
        target = next_run_at(12, 0, self.config.tz)
        delay = max(0.0, (target - datetime.now(self.config.tz)).total_seconds())
        await asyncio.sleep(delay)

    @tasks.loop(minutes=15)
    async def event_reminder(self) -> None:
        channel_id = self.config.channels['events']
        channel = self.get_channel(channel_id)
        if not isinstance(channel, discord.TextChannel):
            LOGGER.error('#イベント情報 channel not found or invalid.')
            return

        tz = self.config.tz
        now = datetime.now(tz)
        events: List[Dict[str, Any]] = self.state.get('events', [])
        updated_events: List[Dict[str, Any]] = []

        for event in events:
            event_time = datetime.fromisoformat(event['event_time']).astimezone(tz)
            if event_time < now:
                continue

            reminders = [datetime.fromisoformat(ts).astimezone(tz) for ts in event.get('reminders', [])]
            reminded = set(event.get('reminded', []))

            for reminder_time in reminders:
                key = reminder_time.isoformat()
                if key in reminded:
                    continue
                if reminder_time <= now:
                    await channel.send(
                        '《イベントリマインド》\n'
                        f'「{event["title"]}」まであと {self._reminder_label(event_time, reminder_time)} だぞ！\n'
                        f'開始日時：{event_time:%Y-%m-%d %H:%M}\n'
                        '準備は整ってるか？デジリューはテンションMAXで待ってるぞ🔥'
                    )
                    reminded.add(key)

            event['reminded'] = list(reminded)
            updated_events.append(event)

        await self.state.update('events', updated_events)

    @event_reminder.before_loop
    async def before_event_reminder(self) -> None:
        await self.wait_until_ready()

    async def _collect_messages_between(
        self,
        channel: discord.TextChannel,
        start: datetime,
        end: datetime,
    ) -> List[Message]:
        messages: List[Message] = []
        async for message in channel.history(limit=None, after=start, before=end, oldest_first=True):
            if not message.author.bot:
                messages.append(message)
        return messages

    def _reminder_label(self, event_time: datetime, reminder_time: datetime) -> str:
        delta = event_time - reminder_time
        days = delta.days
        hours = delta.seconds // 3600
        if days > 0:
            return f'{days}日'
        if hours >= 1:
            return f'{hours}時間'
        minutes = max(1, delta.seconds // 60)
        return f'{minutes}分'

    async def fetch_ai_news(self) -> List[Dict[str, str]]:
        '''
        Fetch AI news via NewsAPI.org if credentials are provided.
        Returns a list of dicts with keys: title, url, summary.
        '''
        api_key = os.getenv(self.config.ai_news_api_key_env)
        if not api_key:
            LOGGER.warning('NEWS_API_KEY not set; returning empty news list.')
            return []

        if not self.http_session:
            raise RuntimeError('HTTP session not initialised.')

        params = {
            'q': self.config.ai_news_query,
            'language': self.config.ai_news_language,
            'pageSize': self.config.ai_news_articles_per_day,
            'sortBy': 'publishedAt',
        }

        url = 'https://newsapi.org/v2/everything'
        headers = {'X-Api-Key': api_key}

        async with self.http_session.get(url, headers=headers, params=params) as resp:
            if resp.status != 200:
                LOGGER.error('News API request failed: %s - %s', resp.status, await resp.text())
                return []
            payload = await resp.json()

        articles = []
        for article in payload.get('articles', []):
            articles.append(
                {
                    'title': article.get('title'),
                    'url': article.get('url'),
                    'summary': article.get('description') or '',
                }
            )
        return articles


async def main() -> None:
    logging.basicConfig(level=logging.INFO)

    # Load environment variables with fallbacks: .env -> env.local -> env.example
    # NOTE: Using env.example is for local convenience only. Avoid committing secrets.
    loaded_any = load_dotenv()  # .env
    if not os.getenv('DISCORD_BOT_TOKEN'):
        loaded_any = load_dotenv('env.local') or loaded_any
    if not os.getenv('DISCORD_BOT_TOKEN'):
        if load_dotenv('env.example'):
            LOGGER.warning('Loaded variables from env.example. Do NOT commit real secrets to example files.')

    config_path = Path(os.getenv('DEJIRYU_CONFIG_PATH', 'DEJIRYU_DISCORD/config.json'))
    state_path = Path(os.getenv('DEJIRYU_STATE_PATH', 'DEJIRYU_DISCORD/data/state.json'))

    config = Config(load_json(config_path))
    state = StateManager(state_path)

    token_env = config.discord_token_env
    token = os.getenv(token_env)
    if not token:
        raise RuntimeError(f'Discord token not found. Set environment variable {token_env}.')

    bot = DejiRyuBot(config, state)
    try:
        await bot.start(token)
    finally:
        await bot.close()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        LOGGER.info('DejiRyu shutdown requested. See you next patrol!')
