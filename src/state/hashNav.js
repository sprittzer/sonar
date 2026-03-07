import { computed, ref } from 'vue'

function normalize(hash) {
  const raw = (hash || '').replace(/^#/, '')
  if (!raw) return '/chats'
  return raw.startsWith('/') ? raw : `/${raw}`
}

const currentPath = ref(normalize(window.location.hash))

window.addEventListener('hashchange', () => {
  currentPath.value = normalize(window.location.hash)
})

function navigate(path) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  window.location.hash = normalized
}

const activeSection = computed(() => {
  if (currentPath.value.startsWith('/contacts')) return 'contacts'
  if (currentPath.value.startsWith('/groups')) return 'groups'
  if (currentPath.value.startsWith('/settings')) return 'settings'
  if (currentPath.value.startsWith('/chat/')) return 'chat'
  return 'chats'
})

const activeChatType = computed(() => {
  const match = currentPath.value.match(/^\/chat\/(peer|group)\/.+$/)
  return match ? match[1] : ''
})

const activeChatId = computed(() => {
  const match = currentPath.value.match(/^\/chat\/(peer|group)\/(.+)$/)
  return match ? decodeURIComponent(match[2]) : ''
})

export function useHashNav() {
  return {
    currentPath,
    activeSection,
    activeChatType,
    activeChatId,
    navigate
  }
}
