import type Database from 'better-sqlite3'

type SqliteDatabase = InstanceType<typeof Database>
type LifecycleCallback = () => void

export interface TransactionLifecycle {
  afterCommit(callback: LifecycleCallback): void
  afterRollback(callback: LifecycleCallback): void
}

interface ActiveTransaction {
  lifecycle: TransactionLifecycle
  afterCommit: LifecycleCallback[]
  afterRollback: LifecycleCallback[]
}

export class UnitOfWork {
  private active: ActiveTransaction | undefined

  constructor(private readonly database: SqliteDatabase) {}

  run<T>(operation: (lifecycle: TransactionLifecycle) => T): T {
    if (this.active) return this.runNested(this.active, operation)

    const transaction: ActiveTransaction = {
      afterCommit: [],
      afterRollback: [],
      lifecycle: {
        afterCommit: (callback) => transaction.afterCommit.push(callback),
        afterRollback: (callback) => transaction.afterRollback.push(callback),
      },
    }
    this.active = transaction

    try {
      const result = this.database
        .transaction(() => this.execute(operation, transaction.lifecycle))
        .immediate()
      this.active = undefined
      for (const callback of transaction.afterCommit) {
        try {
          callback()
        } catch (error) {
          console.error('事务提交后清理失败', error)
        }
      }
      return result
    } catch (error) {
      this.active = undefined
      const rollbackErrors: unknown[] = []
      for (const callback of transaction.afterRollback.reverse()) {
        try {
          callback()
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], '事务回滚后恢复失败')
      }
      throw error
    }
  }

  private runNested<T>(
    transaction: ActiveTransaction,
    operation: (lifecycle: TransactionLifecycle) => T,
  ): T {
    const commitHookStart = transaction.afterCommit.length
    const rollbackHookStart = transaction.afterRollback.length
    try {
      return this.database.transaction(() => this.execute(operation, transaction.lifecycle))()
    } catch (error) {
      transaction.afterCommit.splice(commitHookStart)
      const rollbackCallbacks = transaction.afterRollback.splice(rollbackHookStart).reverse()
      const rollbackErrors: unknown[] = []
      for (const callback of rollbackCallbacks) {
        try {
          callback()
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError([error, ...rollbackErrors], '嵌套事务回滚后恢复失败')
      }
      throw error
    }
  }

  private execute<T>(
    operation: (lifecycle: TransactionLifecycle) => T,
    lifecycle: TransactionLifecycle,
  ): T {
    const result = operation(lifecycle)
    if (
      result !== null &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      throw new TypeError('UnitOfWork 只允许同步操作')
    }
    return result
  }
}
