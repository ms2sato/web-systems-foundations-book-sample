-- テスト専用データベース。vitest（npm run test）はデモ用の app ではなくこちらに接続する。
-- このスクリプトは Postgres のデータボリュームが空のとき（初回起動時）だけ実行される。
CREATE DATABASE app_test;
