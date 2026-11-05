# サンプル環境

本書の内容を体験するためのサンプル環境です。

## 構成

- **LoadBalancer**: ロードバランサー（nginx、ポート 8080）
- **App**: Honoアプリ（スケール可能）
- **Worker**: ジョブ処理ワーカー（スケール可能）
- **PostgreSQL**: データベース（ポート 5432）
- **Redis**: セッション/キャッシュ/ジョブキュー（ポート 6379）
- **Garage**: S3互換ストレージ（ポート 3900）
- **S3 Manager**: S3管理UI（ポート 9000）
- **Loki**: ログ集約サーバー（ポート 3100）
- **Promtail**: ログ収集エージェント
- **Grafana**: ログ可視化UI（ポート 3001）

## 起動方法

```bash
git clone git@github.com:ms2sato/web-systems-foundations-book-sample.git
cd web-systems-foundations-book-sample
docker compose up
```

`docker compose up` だけで、S3互換ストレージ（Garage）のクラスタ設定・バケット作成・アクセスキー登録・CORS設定と、データベースのマイグレーション適用まで自動的に完了する（`garage-init` / `db-init` サービスがそれぞれ一度だけ実行し、app / worker はその完了を待って起動する）。手動での追加作業は不要。

S3互換ストレージ（Garage）の資格情報は、見れば分かる全ゼロのダミー値を compose に直書きしている（ローカル専用。実際のプロジェクトでは compose に直書きせず `.env` などに分離すること）。

### app の npm バージョンについて

`app` は公開直後の悪意あるパッケージを取り込まないよう、npm の age gate（`min-release-age`、公開から7日は新しいバージョンを取り込まない設定）を有効にしている。この機能は npm 11.10.0 以降でないと効かないため、Dockerfile 内で `node:22-slim` 同梱の npm を明示的に入れ替えている（Node 本体は 22 系のまま）。`docker compose up` でビルドすれば自動的に反映される。

セキュリティ修正を公開直後でも即時に取り込みたい場合は、設定ファイル（`.npmrc`）自体は変更せず、一時的にコマンドで無効化する：

```bash
npm install <パッケージ名> --min-release-age=0
```

`package.json` の `overrides.vite` は、`vitest`（direct dependency）が `vite` を `^6 || ^7 || ^8` という広い範囲で許容しているため付けている。これが無いと `npm update` のたびに vite が意図せずメジャー8系まで上がってしまう（実測で確認済み）。vitest が vite 8系に正式移行して脆弱性修正が8系のみになったら、この override ごと外して7系止まりの制約を解除すること。

## アクセス先

| サービス | URL |
|---------|-----|
| アプリ | http://localhost:8080 |
| Bull Board（ジョブキュー管理） | http://localhost:8080/admin/queues |
| S3 Manager（ストレージ管理） | http://localhost:9000 |
| Grafana（ログ表示） | http://localhost:3001 |

## 機能

### 1. ファイルアップロード（署名付きURL）

ブラウザから直接S3にファイルをアップロードします。サーバーを経由しないため、大容量ファイルでもサーバーに負荷がかかりません。

### 2. ZIPアーカイブ作成（ジョブキュー）

アップロードしたファイルを選択して「ZIPアーカイブを作成」ボタンを押すと、Workerがバックグラウンドで処理します。Bull Boardでジョブの状態を確認できます。

### 3. ログ集約（Grafana + Loki）

各コンテナのログをLokiに集約し、Grafanaで可視化します。

1. Grafana（http://localhost:3001）にアクセス
2. 左メニューから「Explore」を選択
3. データソースで「Loki」を選択
4. Label filtersで `service` を選び、見たいサービスを選択
   - `app`: アプリケーションサーバー
   - `worker`: ワーカー
   - `loadbalancer`: ロードバランサー（nginx）
   - `postgres`: データベース
   - `redis`: Redis
5. 「Run query」をクリックでログを表示

「エラーウォッチ」ダッシュボードを同梱している（左メニューの Dashboards から開く）。直近5分に ERROR ログがあるとタイルが赤くなる。エラー監視サービスの疑似体験として、ジョブの失敗やスイーパーの故障に「気づく」体験に使える。

## スケールアウトを試す

デフォルトでアプリは2台、ワーカーは1台で起動します（`docker-compose.yml` の `deploy.replicas` で設定）。

コマンドラインから台数を変更することもできます：

```bash
# アプリを3台に増やす
docker compose up -d --scale app=3

# ワーカーを2台に増やす
docker compose up -d --scale worker=2
```

ブラウザをリロードすると、異なるサーバー（ホスト名）が応答することを確認できます。

この体験を通じて：
- 複数台のサーバーで動くことを実感できる
- リクエストがどのインスタンスに振られるかわからないことを体験できる
- だからこそセッションやファイルの「外部化」が必要、という理解につながる

## テスト

```bash
docker compose exec app npm run test
```

テストはデモ用のデータベース（`app`）ではなく、同じ PostgreSQL 内のテスト専用データベース（`app_test`）に接続します。テストはクリーンアップとしてレコードを削除するため、デモと同じデータベースを使うとアップロード済みファイルが消えてしまいます。データベースを分けることで、テストを何度実行してもデモ画面のデータは変化しません。

`app_test` は初回の `docker compose up` 時に初期化スクリプト（`db/init/`）で自動作成され、テスト開始時に最新のスキーマが自動適用されます。初期化スクリプトは PostgreSQL のデータボリュームが空のときしか実行されないため、**この変更より前から環境を起動している場合**は、一度だけ手動で作成してください：

```bash
docker compose exec db psql -U postgres -c 'CREATE DATABASE app_test'
```

## 停止

```bash
docker compose down
```

データを削除する場合：

```bash
docker compose down -v
```

## ライセンス

MIT ライセンスです。詳細は [LICENSE](./LICENSE) を参照してください。
