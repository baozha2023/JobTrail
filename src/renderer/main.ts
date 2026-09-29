import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { i18n } from './i18n'
import './styles.css'
import { reportRendererFault } from './diagnostics'

window.addEventListener('error', (event) => reportRendererFault('process.uncaught', event.error))
window.addEventListener('unhandledrejection', (event) =>
  reportRendererFault('process.unhandled-rejection', event.reason),
)
const application = createApp(App).use(createPinia()).use(i18n)
application.config.errorHandler = (error) => reportRendererFault('vue.component', error)
application.mount('#app')
void nextTick()
  .then(() => window.velopackApi.rendererHealthy())
  .catch((error) => reportRendererFault('startup.renderer-healthy', error))
