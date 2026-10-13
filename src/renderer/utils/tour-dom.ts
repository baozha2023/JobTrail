export function visibleTourTarget(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return (
    rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  )
}

export function waitForTourLayout(ready: () => boolean, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000
    let timer: ReturnType<typeof setTimeout>
    const clean = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    const abort = () => {
      clean()
      reject(new DOMException('Tour interrupted', 'AbortError'))
    }
    const check = () => {
      if (signal.aborted) return abort()
      if (ready()) {
        clean()
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        clean()
        reject(new Error('Tour target is not ready'))
        return
      }
      timer = setTimeout(check, 16)
    }
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}
