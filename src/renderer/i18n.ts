import { createI18n } from 'vue-i18n'
import zhCn from './locales/zh-cn'
import enUs from './locales/en-us'

export const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCn,
    'en-US': enUs,
  },
})
