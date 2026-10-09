export const TARGET_DATABASE_VERSION = 4
export const TARGET_CONFIG_VERSION = 1

export class DatabaseVersionError extends Error {
  constructor(version: number) {
    super(`不支持的数据库结构版本：${version}，需要版本 ${TARGET_DATABASE_VERSION}`)
    this.name = 'DatabaseVersionError'
  }
}
