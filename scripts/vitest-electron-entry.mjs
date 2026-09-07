const rawArgs = process.env.ZHIJI_VITEST_ARGS ?? '[]'
const args = JSON.parse(rawArgs)
if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
  throw new Error('Invalid Vitest arguments')

if (args[0] === 'run' && !args.includes('--watch') && !args.includes('-w')) {
  const { parseCLI, startVitest } = await import('vitest/node')
  const parsed = parseCLI(['vitest', ...args])
  const context = await startVitest('test', parsed.filter, parsed.options)
  // Electron's run-as-Node process keeps internal file handles alive even after
  // Vitest and Vite have closed. Exit only after Vitest has produced the final
  // result so those runtime handles do not add a false ten-second leak warning.
  await context.exit(true)
} else {
  process.argv = [process.execPath, 'vitest', ...args]
  await import('vitest/vitest.mjs')
}
