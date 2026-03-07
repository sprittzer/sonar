import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function importFresh(relativePath) {
  const moduleUrl = pathToFileURL(path.resolve(relativePath)).href
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`${moduleUrl}?t=${nonce}`)
}

export function createLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, String(v)]))

  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
    removeItem(key) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    get length() {
      return store.size
    }
  }
}

export function ensureBase64Globals() {
  if (!globalThis.btoa) {
    globalThis.btoa = (binary) => Buffer.from(binary, 'binary').toString('base64')
  }

  if (!globalThis.atob) {
    globalThis.atob = (base64) => Buffer.from(base64, 'base64').toString('binary')
  }
}
