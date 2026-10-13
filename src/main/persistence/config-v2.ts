// Published v2 validation rules stay fixed. Defaults apply only to new configurations.
import { z } from 'zod'
const aiSchema = z.strictObject({
  baseUrl: z
    .string()
    .trim()
    .refine((value) => {
      try {
        const endpoint = new URL(value)
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
        return (
          (endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && loopback)) &&
          !endpoint.username &&
          !endpoint.password
        )
      } catch {
        return false
      }
    }, 'AI Base URL 必须是 HTTPS 或本机回环 HTTP 地址'),
  modelId: z.string().trim(),
  apiKey: z.string().trim().max(8192, 'AI API Key 无效'),
  multimodal: z.boolean(),
  contextWindowK: z
    .number()
    .int()
    .min(8, 'AI 上下文窗口须为 8–2048k')
    .max(2048, 'AI 上下文窗口须为 8–2048k'),
  compactThresholdPercent: z
    .number()
    .int()
    .min(50, 'AI 自动压缩阈值须为 50%–90%')
    .max(90, 'AI 自动压缩阈值须为 50%–90%'),
})
const mcpSchema = z.strictObject({
  enabled: z.boolean(),
  requireWriteConfirmation: z.boolean(),
})

// Persisted step identifiers belong to this frozen format, not a mutable UI registry.
const appStep = z.enum([
  'opportunities',
  'calendar',
  'statuses',
  'industries',
  'resumes',
  'companies',
  'discovery',
  'agent',
  'settings',
])
const discoveryStep = z.enum([
  'accounts',
  'account-list',
  'qr-panel',
  'platforms',
  'keyword',
  'city',
  'salary',
  'search',
  'results',
  'details',
  'new-search',
  'history',
])
function tourState<T extends z.ZodType<string>>(step: T) {
  return z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('pending'), stepId: z.null() }),
    z.strictObject({ status: z.literal('inProgress'), stepId: step }),
    z.strictObject({ status: z.literal('completed'), stepId: z.null() }),
    z.strictObject({ status: z.literal('skipped'), stepId: z.null() }),
  ])
}
const onboardingSchema = z.strictObject({
  app: tourState(appStep),
  discovery: tourState(discoveryStep),
})

const settingsSchema = z.strictObject({
  themeMode: z.enum(['light', 'dark', 'system']),
  statusFlowTheme: z.enum(['violet', 'ocean', 'gold']),
  locale: z.enum(['zh-CN', 'en-US']),
  closeBehavior: z.enum(['tray', 'quit']),
  launchAtStartup: z.boolean(),
  companyReadValidityMonths: z.number().int().positive(),
  onboarding: onboardingSchema,
  mcp: mcpSchema,
  ai: aiSchema,
})
export const CONFIG_V2_SCHEMA = settingsSchema.extend({
  configVersion: z.literal(2),
})

export const CONFIG_V2_DEFAULTS: z.infer<typeof CONFIG_V2_SCHEMA> = {
  configVersion: 2,
  themeMode: 'system',
  statusFlowTheme: 'violet',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  companyReadValidityMonths: 3,
  onboarding: {
    app: { status: 'pending', stepId: null },
    discovery: { status: 'pending', stepId: null },
  },
  mcp: {
    enabled: true,
    requireWriteConfirmation: true,
  },
  ai: {
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
    apiKey: '',
    multimodal: false,
    contextWindowK: 256,
    compactThresholdPercent: 80,
  },
}
