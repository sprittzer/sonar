<template>
  <section class="route-panel">
    <div class="chat-header">
      <h2>{{ label }}</h2>
      <p class="small">
        {{ chatType === 'group' ? 'Групповой чат' : 'Личный чат' }}
        <span v-if="chatType === 'peer'" class="e2ee-badge" :class="isEncrypted ? 'encrypted' : 'plain'">
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
      <div v-if="chatType === 'peer'" class="call-controls">
        <button v-if="peerCallState === 'idle'" class="btn" @click="startCall">Видео звонок</button>
        <button v-if="isIncomingRinging" class="btn" @click="acceptCall">Принять</button>
        <button v-if="isIncomingRinging" class="btn danger" @click="rejectCall">Отклонить</button>
        <button v-if="canEndCall" class="btn danger" @click="endCall">Завершить</button>
        <span class="secure-status" :class="`status-${peerCallState}`">{{ callStatusText }}</span>
      </div>
      <div v-if="chatType === 'peer' && (localCallStream || remoteCallStream)" class="call-videos">
        <video ref="remoteVideoRef" class="video remote" autoplay playsinline></video>
        <video ref="localVideoRef" class="video local" autoplay muted playsinline></video>
      </div>
      <p v-if="peerCallError" class="send-error">{{ peerCallError }}</p>
      <p v-if="sendError" class="send-error">{{ sendError }}</p>
    </div>

    <div class="messages">
      <div v-for="item in messages" :key="item.localKey" :class="['bubble', item.outgoing ? 'out' : 'in']">
        <div class="meta">
          {{ item.outgoing ? 'Ты' : item.from }} • {{ formatTime(item.ts) }}
          <span v-if="item.encrypted" class="lock-icon" title="AES">🔒</span>
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
  e2eeSessions,
  openOrCreatePeerChat,
  openOrCreateGroupChat,
  getThreadEncryptionEnabled,
  setThreadEncryption,
  getHandshakeStatusByPeer,
  getHandshakeErrorByPeer,
  ensureE2eeForPeer,
  callState,
  callError,
  currentCallPeerId,
  incomingCallFrom,
  localCallStream,
  remoteCallStream,
  startVideoCall,
  acceptIncomingCall,
  rejectIncomingCall,
  endVideoCall
} = useMeshApp()

const threadKey = computed(() => `${props.chatType}:${props.chatId}`)
const label = computed(() => getThreadLabel(threadKey.value))
const messages = computed(() => getMessages(threadKey.value))
const localVideoRef = ref(null)
const remoteVideoRef = ref(null)
const isEncrypted = computed(() =>
  props.chatType === 'peer' && e2eeSessions.value.has(props.chatId)
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
  if (secureStatus.value === 'failed') {
    return getHandshakeErrorByPeer(props.chatId) || 'Ошибка обмена ключами'
  }
  return 'Инициализация...'
})
const isPeerCallContext = computed(() =>
  props.chatType === 'peer' && currentCallPeerId.value === props.chatId
)
const peerCallState = computed(() => {
  if (props.chatType !== 'peer') return 'idle'
  if (!isPeerCallContext.value && incomingCallFrom.value !== props.chatId) return 'idle'
  if (incomingCallFrom.value === props.chatId && callState.value === 'ringing') return 'ringing'
  return callState.value
})
const isIncomingRinging = computed(() => incomingCallFrom.value === props.chatId && callState.value === 'ringing')
const canEndCall = computed(() => {
  const s = peerCallState.value
  return s === 'calling' || s === 'connecting' || s === 'in-call' || s === 'error'
})
const callStatusText = computed(() => {
  if (peerCallState.value === 'ringing') return 'Входящий звонок...'
  if (peerCallState.value === 'calling') return 'Исходящий звонок...'
  if (peerCallState.value === 'connecting') return 'Соединение...'
  if (peerCallState.value === 'in-call') return 'В звонке'
  if (peerCallState.value === 'error') return 'Ошибка звонка'
  return 'Без звонка'
})
const peerCallError = computed(() => (isPeerCallContext.value || isIncomingRinging.value) ? callError.value : '')

watch(
  () => [props.chatType, props.chatId],
  async ([type, id]) => {
    if (!type || !id) return

    if (type === 'peer') {
      const peer = peers.value.find((p) => p.nodeId === id)
      if (peer) openOrCreatePeerChat(peer)
      if (getThreadEncryptionEnabled(`peer:${id}`)) {
        await ensureE2eeForPeer(id)
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

watch([localCallStream, localVideoRef], ([stream, el]) => {
  if (el) el.srcObject = stream || null
}, { immediate: true })

watch([remoteCallStream, remoteVideoRef], ([stream, el]) => {
  if (el) el.srcObject = stream || null
}, { immediate: true })

async function startCall() {
  sendError.value = ''
  try {
    await startVideoCall(props.chatId)
  } catch (e) {
    sendError.value = e?.message || 'Не удалось начать звонок.'
  }
}

async function acceptCall() {
  sendError.value = ''
  try {
    await acceptIncomingCall()
  } catch (e) {
    sendError.value = e?.message || 'Не удалось принять звонок.'
  }
}

async function rejectCall() {
  sendError.value = ''
  await rejectIncomingCall()
}

async function endCall() {
  sendError.value = ''
  await endVideoCall(true)
}
</script>

<style scoped>
.secure-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.call-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.call-videos {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
}

.video {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 10px;
  background: #111827;
  object-fit: cover;
}

.video.local {
  transform: scaleX(-1);
}
</style>
