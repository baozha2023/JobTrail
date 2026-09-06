const rawArgs = process.env.ZHIJI_VITEST_ARGS ?? '[]'
const args = JSON.parse(rawArgs)
if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new Error('Invalid Vitest arguments')
process.argv = [process.execPath, 'vitest', ...args]
await import('vitest/vitest.mjs')

