import { hostname } from 'os'

// どのサーバー（コンテナ）が処理したかをログやレスポンスで示すための識別子
export const HOSTNAME = hostname()
