const ENABLE_DEBUG = (() => {
  try {
    const v = localStorage.getItem('shmax_debug')
    return v === '1' || v === 'true'
  } catch {
    return false
  }
})()

export function createLogger(scope) {
  const tag = `[SHMAX:${scope}]`
  return {
    debug: (...args) => {
      if (ENABLE_DEBUG) console.debug(tag, ...args)
    },
    info: (...args) => console.info(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args)
  }
}
