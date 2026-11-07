import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// recommended 系の一式に、このサンプルのコーディング方針と重なる項目を明示設定した構成。
// 型情報を使う recommendedTypeChecked を使うため、parserOptions.projectService が必要
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // if / else / for / while は単文でも必ず {} を付ける
      curly: ['error', 'all'],

      // 非 null アサーション `!` の禁止（型は宣言で表現する）
      '@typescript-eslint/no-non-null-assertion': 'error',

      // `as` の制限（型は宣言で表現する）。
      // objectLiteralTypeAssertions のデフォルト 'never' はオブジェクト**リテラル**への
      // アサーション（例: `{} as Foo`）を禁止するもので、`error.meta as {...}` のような
      // 「型情報がないデータへの形の注釈」（プロパティアクセス式へのアサーション）は
      // 対象外なので、既存コード（lib/errors.ts の sqlStateOf / httpStatusOf）と両立する
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'never' },
      ],

      // console の直接呼び出し禁止（ログは lib/log.ts の log を使う）
      'no-console': 'error',

      // catch した error（型は unknown）をログ文字列に `${error}` のまま埋める書き方を
      // 素直に保つため off にする。サンプルは書籍で引用される
      // コードなので、String(error) で包むより読みやすさを優先する
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // lib/log.ts は console 呼び出しの唯一の実装場所なので off
    files: ['src/lib/log.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // index.ts の各 API ハンドラは `await c.req.json()` の戻り値（Hono の型は Promise<any>。
    // このプロジェクトではスキーマバリデーションミドルウェアを使っていない）を分割代入で
    // 受け取っている。以降 typeof 等の実行時チェックで検証してから使っており、
    // 安全性の担保はその実行時チェックが担っている。no-unsafe-* 系は静的型が
    // ないこと自体を検出するためここでは必ず違反になる。全ハンドラをスキーマ
    // バリデーション導入で書き換えるのはこのサンプルの範囲外のため、
    // index.ts に限定して off にする
    files: ['src/index.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // BullMQ の Job は name が string で、payload の型（GenerateThumbnailJobData /
    // CreateArchiveJobData）との対応関係を型では表現できない。この対応関係は
    // ジョブ投入側（index.ts）の satisfies と、ここでの job.name による振り分けが
    // 保証している境界なので、worker.ts に限定して off にする
    files: ['src/worker.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
)
