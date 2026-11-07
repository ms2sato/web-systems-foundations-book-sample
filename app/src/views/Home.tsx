import type { FC } from 'hono/jsx'
import { html } from 'hono/html'

const Home: FC<{ hostname: string }> = ({ hostname }) => (
  <html lang="ja">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Sample App - ジョブ冪等性デモ</title>
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body>
      <h1>Sample App - ジョブ冪等性デモ</h1>

      <div class="server-info">
        <p>このページを表示しているサーバー: <span class="hostname">{hostname}</span></p>
        <p class="note">ブラウザをリロードすると、別のサーバーが応答するかもしれません。</p>
      </div>

      <div class="section">
        <h2>1. 画像をアップロード（署名付きURL）</h2>
        <form id="uploadForm">
          <input type="file" id="file" accept="image/*" required />
          <button type="submit">アップロード</button>
        </form>
        <div id="uploadResult" class="result"></div>
        <p class="note">※ ファイルはブラウザから直接S3にアップロード → DB登録 → サムネイル生成ジョブ投入</p>
      </div>

      <div class="section">
        <h2>2. アップロード済みファイル</h2>
        <div class="toolbar">
          <button onclick="loadFiles()">更新</button>
          <button onclick="toggleSelectAll()">全選択</button>
          <button id="createArchiveBtn" onclick="createArchive()" disabled>ZIPアーカイブを作成</button>
          <button id="debugArchiveBtn" class="debug" onclick="createArchiveDebug()" disabled>2件同時投入（デバッグ用）</button>
        </div>
        <div id="fileList" class="file-list">
          <div class="empty-message">読み込み中...</div>
        </div>
        <div id="archiveResult" class="result"></div>
        <p class="note">→ ジョブの状態は <a href="/admin/queues" target="_blank">Bull Board</a> で確認できます</p>
      </div>

      <div class="section">
        <h2>3. アーカイブ一覧</h2>
        <button onclick="loadArchives()">更新</button>
        <div id="archiveList" class="archive-list">
          <div class="empty-message">読み込み中...</div>
        </div>
      </div>

      <div class="section debug-section">
        <h3>デバッグ機能について</h3>
        <p><strong>パターン1（サムネイル生成）:</strong> 各ファイルの「サムネイル2回生成」ボタンで、同じファイルに対して2つのジョブを投入。Unique制約で重複防止を体験。</p>
        <p><strong>パターン2（ZIPアーカイブ）:</strong> 「2件同時投入」ボタンで、同じアーカイブに対して2つのジョブを投入。状態フラグ+ロックで同時実行防止を体験。</p>
      </div>

      <div class="links">
        <h3>管理画面</h3>
        <a href="/admin/queues" target="_blank">Bull Board（ジョブキュー）</a>
        <a href="http://localhost:9000" target="_blank">S3 Manager（ストレージ）</a>
        <a href="http://localhost:3001/explore" target="_blank">Grafana（ログ）</a>
        <a href="http://localhost:3001/d/error-watch" target="_blank">エラーウォッチ（エラー監視）</a>
      </div>

      <script src="/app.js" defer></script>
    </body>
  </html>
)

// hono/jsx はコンポーネントの出力に <!DOCTYPE html> を含めないため、
// hono/html の html タグで先頭に付与してから返す
export const renderHomePage = (hostname: string) => html`<!DOCTYPE html>${<Home hostname={hostname} />}`
