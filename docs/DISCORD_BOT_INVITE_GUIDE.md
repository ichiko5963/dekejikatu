# Discord Bot 作成 & 招待ガイド（デジリュー版）

Slack とは手順が違うので、Discord でボットを動かすまでの流れをまとめました。

## 1. Developer Portal でアプリを作成

1. https://discord.com/developers/applications を開く
2. 「New Application」→ 名前を例: `DejiRyu` にする
3. 左メニュー **Bot** → 「Add Bot」→ 「Yes, do it!」
4. Bot アイコンはお好みで。デジリューのイラストを設定しておくと雰囲気が出ます。

## 2. Bot Token を取得

1. Bot ページの **Reset Token** → 「Copy Token」  
   ※流出すると誰でもボットを操作できるので、環境変数で管理してください。
2. `config.example.json` の `discord_token_env` に合わせて、`.env` やホスティング側に保存する

## 3. 必要な権限を設定

1. Bot ページ下部の **Privileged Gateway Intents**
   - 「MESSAGE CONTENT INTENT」を **ON**
   - 「GUILD MEMBERS INTENT」を **ON**（リアクション集計でメンション表示に使います）
2. 左メニュー **OAuth2 > URL Generator**
   - SCOPES: `bot`
   - BOT PERMISSIONS: `Send Messages`, `Read Message History`, `Add Reactions`, `Use Slash Commands`
   - 生成された URL を控えておく

## 4. サーバーに招待

1. 生成した OAuth2 URL をブラウザで開く
2. 対象の Discord サーバー（本番またはテスト環境）を選択
3. 権限を確認して「Authorize」

> デジリューの一言: 「まずはテストサーバーに呼んで、挙動をチェックしてから本番に迎えてくれよな！」

## 5. チャンネル ID の取得方法

1. Discord のユーザー設定 → 「詳細設定」→ 「開発者モード」を ON
2. 目的のチャンネルを右クリック → 「リンクをコピー」
3. URL 末尾の数字がチャンネル ID（例: `https://discord.com/channels/1234567890/0987654321` の `0987654321`）
4. `config.json` の対応するキーに貼り付け

## 6. ローカルからの接続確認

1. 仮想環境をアクティブ化し、`DISCORD_BOT_TOKEN` をセット
2. `python DEJIRYU_DISCORD/dejiryu_bot.py`
3. コンソールに `DejiRyu online as ...` が表示され、Discord 上で Bot のステータスがオンラインになれば成功

## 7. セキュリティと運用メモ

- Bot Token を GitHub に push しない（`.env` + Secrets 管理が基本）
- NewsAPI のキーも Secrets で管理し、不要なときは未設定のままで OK
- 定期的に Discord Developer Portal を確認し、権限変更がないかをチェック

これでデジリューをサーバーに呼び込む準備は完了です。次は `DEJIRYU_AUTOMATION_PLAYBOOK.md` を見ながら、各チャンネルでの挙動をチューニングしてください。  
「設定が終わったら、デジリューに『準備完了だぞ！』って声をかけてやってくれよな🔥」
