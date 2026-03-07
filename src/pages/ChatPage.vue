<template>
  <section class="route-panel">
    <div class="chat-header">
      <h2>{{ label }}</h2>
      <p class="small">
        {{ chatType === 'group' ? 'Групповой чат' : 'Личный чат' }}
        <span v-if="chatType === 'peer'" class="omemo-badge" :class="isEncrypted ? 'encrypted' : 'plain'">
          {{ isEncrypted ? '🔒 Зашифрован' : '🔓 Нет шифрования' }}
        </span>
      </p>
      <div v-if="chatType === 'peer'" class="secure-controls">
        <label class="secure-toggle">
          <input type="checkbox" :checked="secureEnabled" @change="onSecureToggle" />
          <span>Шифровать чат</span>
        </label>
        <span class="secure-status" :class="`status-${secureStatus}`">
          {{ secureStatusText }}
        </span>
      </div>
      <p v-if="sendError" class="send-error">{{ sendError }}</p>
    </div>

    <div class="messages">
      <div v-for="item in messages" :key="item.localKey" :class="['bubble', item.outgoing ? 'out' : 'in']">
        <div class="meta">
          {{ item.outgoing ? 'Ты' : item.from }} • {{ formatTime(item.ts) }}
          <span v-if="item.encrypted" class="lock-icon" title="OMEMO">🔒</span>
        </div>
        <div v-if="item.decryptFailed" class="decrypt-error">🔒 Зашифровано — ключ недоступен</div>
        <div v-else>{{ item.text }}</div>
      </div>
      <div v-if="messages.length === 0" class="placeholder">Начни переписку.</div>
    </div>

    <div class="composer">
      <input v-model="chatInput" class="input" placeholder="Сообщение" @keyup.enter="send" />
      <button class="btn" @click="send">Отправить</button>
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useMeshApp } from '../state/useMeshApp'

const props = defineProps({
  chatType: {
    type: String,
    default: ''
  },
  chatId: {
    type: String,
    default: ''
  }
})

const chatInput = ref('')
const sendError = ref('')
const {
  getMessages,
  getThreadLabel,
  markThreadRead,
  sendChatToThread,
  formatTime,
  peers,
  groups,
  omemoSessions,
  openOrCreatePeerChat,
  openOrCreateGroupChat,
  getThreadEncryptionEnabled,
  setThreadEncryption,
  getHandshakeStatusByPeer,
  ensureOmemoForPeer
} = useMeshApp()

const threadKey = computed(() => `${props.chatType}:${props.chatId}`)
const label = computed(() => getThreadLabel(threadKey.value))
const messages = computed(() => getMessages(threadKey.value))
const isEncrypted = computed(() =>
  props.chatType === 'peer' && omemoSessions.value.has(props.chatId)
)
const secureEnabled = computed(() =>
  props.chatType === 'peer' && getThreadEncryptionEnabled(threadKey.value)
)
const secureStatus = computed(() => {
  if (props.chatType !== 'peer') return 'idle'
  return getHandshakeStatusByPeer(props.chatId)
})
const secureStatusText = computed(() => {
  if (!secureEnabled.value) return 'Режим выключен'
  if (secureStatus.value === 'ready') return 'Сессия готова'
  if (secureStatus.value === 'pending') return 'Ожидание обмена ключами...'
  if (secureStatus.value === 'failed') return 'Ошибка обмена ключами'
  return 'Инициализация...'
})

watch(
  () => [props.chatType, props.chatId],
  async ([type, id]) => {
    if (!type || !id) return

    if (type === 'peer') {
      const peer = peers.value.find((p) => p.nodeId === id)
      if (peer) openOrCreatePeerChat(peer)
      if (getThreadEncryptionEnabled(`peer:${id}`)) {
        await ensureOmemoForPeer(id)
      }
    }

    if (type === 'group') {
      const group = groups.value.find((g) => g.id === id)
      if (group) openOrCreateGroupChat(group)
    }

    sendError.value = ''
    markThreadRead(`${type}:${id}`)
  },
  { immediate: true }
)

async function onSecureToggle(event) {
  sendError.value = ''
  const nextEnabled = event.target.checked
  await setThreadEncryption(threadKey.value, nextEnabled)
}

async function send() {
  const text = chatInput.value.trim()
  if (!text) return
  sendError.value = ''
  try {
    await sendChatToThread(threadKey.value, text)
    chatInput.value = ''
    markThreadRead(threadKey.value)
  } catch (e) {
    sendError.value = e?.message || 'Не удалось отправить сообщение.'
  }
}
</script>

<style scoped>
.secure-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
