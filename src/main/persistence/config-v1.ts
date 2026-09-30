// Published v1 validation rules stay fixed. Defaults apply only to new configurations.
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
const settingsSchema = z.strictObject({
  themeMode: z.enum(['light', 'dark', 'system']),
  statusFlowTheme: z.enum(['violet', 'ocean', 'gold']),
  locale: z.enum(['zh-CN', 'en-US']),
  closeBehavior: z.enum(['tray', 'quit']),
  launchAtStartup: z.boolean(),
  companyReadValidityMonths: z.number().int().positive(),
  mcp: mcpSchema,
  ai: aiSchema,
})
export const CONFIG_V1_SCHEMA = settingsSchema.extend({
  configVersion: z.literal(1),
})

export const CONFIG_V1_DEFAULTS: z.infer<typeof CONFIG_V1_SCHEMA> = {
  configVersion: 1,
  themeMode: 'system',
  statusFlowTheme: 'violet',
  locale: 'zh-CN',
  closeBehavior: 'quit',
  launchAtStartup: false,
  companyReadValidityMonths: 3,
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
