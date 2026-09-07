export function containsLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`
}
