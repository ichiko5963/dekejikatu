# デジリュー Discord オートメーション導入ガイド

デジカツのマスコット「デジリュー」が Discord サーバー内で巡回・投稿・リマインドをこなすための実装セットです。  
Slack 版リュークル資料をベースにしつつ、Discord Bot で動くように組み直しています。

## ディレクトリ構成

```
DEJIRYU_DISCORD/
├─ config.example.json        # チャンネルIDやローテーション設定のテンプレ
├─ dejiryu_bot.py             # デジリューの本体スクリプト
├─ requirements.txt           # Python 依存ライブラリ
├─ data/                      # 状態管理ファイル（初回起動で生成）
└─ docs/                      # セットアップ＆運用ドキュメント
```

## 必要環境

- Python 3.11 以上（推奨 3.12）
- Discord Bot Token
- NewsAPI.org の API キー（AIニュース配信用・任意）
- ローカル実行または常時稼働できるホスティング環境（例: GitHub Actions, Railway, Fly.io）

## セットアップ手順

1. **依存パッケージのインストール**
   ```bash
   cd DEJIRYU_DISCORD
   python -m venv .venv
   source .venv/bin/activate  # Windows は .venv\\Scripts\\activate
   pip install -r requirements.txt
   ```

2. **設定ファイルの作成**
   ```bash
   cp config.example.json config.json
   ```
   - `discord_token_env`: Bot トークンを入れる環境変数名
   - `guild_id`: メインで動かすサーバーID（メンション整形用・任意）
   - `channels`: 各機能で使うチャンネルの ID  
     Discord のメッセージメニュー「リンクをコピー」→ URL の末尾がチャンネル ID です。
   - `ai_news`: NewsAPI.org を使う場合のみ設定（未設定だとニュース投稿はスキップ）
   - `exclusive_content`: 限定コンテンツのローテーション候補
   - `consultation_prompt`: 相談部屋の呼びかけ文とロール ID

3. **環境変数の定義（.env 推奨／フォールバック対応）**
   - 早道: ルートにある `env.example` を `.env` にコピーして中身を埋める
     ```bash
     cp env.example .env
     # .env を開いて DISCORD_BOT_TOKEN などを設定
     ```
   - フォールバック読み込み順: `.env` → `env.local` → `env.example`
     - どうしても `.env` を用意できない場合、`env.local` や `env.example` に書いても起動します
     - ただし実運用の秘密値は `.env`（または環境のSecrets）で管理推奨
   - 直接エクスポートする場合（.envを使わない場合）
     ```bash
     export DISCORD_BOT_TOKEN=xxxxxxxxxxxxxxxx
     export NEWS_API_KEY=yyyyyyyyyyyyyyyy      # AIニュースを使う場合のみ
     export DEJIRYU_CONFIG_PATH=$(pwd)/config.json
     export DEJIRYU_STATE_PATH=$(pwd)/data/state.json
     ```

4. **ローカルテスト実行**
   ```bash
   python dejiryu_bot.py
   ```
   ログに `DejiRyu online as ...` が出れば接続成功です。止めるときは `Ctrl+C` を押してください。

5. **常駐させる場合**
   - `systemd` や `pm2` などのプロセスマネージャーに `python dejiryu_bot.py` を登録
   - GitHub Actions や Railway で動かす場合は、Secrets に環境変数を保存し `python DEJIRYU_DISCORD/dejiryu_bot.py` を実行するワークフローを組みます

## 追加のセットアップ資料

- `docs/DISCORD_BOT_INVITE_GUIDE.md`: Discord Developer Portal での Bot 作成〜招待ガイド
- `docs/DEJIRYU_AUTOMATION_PLAYBOOK.md`: チャンネル別の自動化シナリオと運用Tips

## トラブルシューティング

- **ImportError: No module named 'discord'**
  - 仮想環境が有効になっていないか、`pip install -r requirements.txt` が未実行です。
- **ニュースが投稿されない**
  - `NEWS_API_KEY` を設定しているか、NewsAPI 側でレート制限にかかっていないかを確認してください。
- **イベントリマインドが走らない**
  - `!event` コマンドで登録した日時が過ぎていないか、チャンネル ID が `config.json` と一致しているか確認。

## 次にやること

- `config.json` に本番チャンネル ID を入力
- Discord サーバーに Bot を招待（招待手順は別紙参照）
- テストサーバーで 1 週間ほど試運転し、メッセージ文面を調整
