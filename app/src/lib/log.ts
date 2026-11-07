import { HOSTNAME } from './host.js'

// どのサーバー（コンテナ）が出したログかを一目で分かるようにするロガー。
// 複数サーバー構成でログが混ざっても HOSTNAME で追跡できる
export const log = {
  info(message: string): void {
    console.log(`INFO [${HOSTNAME}] ${message}`)
  },
  warn(message: string): void {
    console.warn(`WARN [${HOSTNAME}] ${message}`)
  },
  error(message: string, error?: unknown): void {
    if (error === undefined) {
      console.error(`ERROR [${HOSTNAME}] ${message}`)
    } else {
      console.error(`ERROR [${HOSTNAME}] ${message}`, error)
    }
  },
}
