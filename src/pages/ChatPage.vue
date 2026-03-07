<template>
  <section class="route-panel">
    <div class="chat-header">
      <h2>{{ label }}</h2>
      <p class="small">{{ chatType === 'group' ? 'Групповой чат' : 'Личный чат' }}</p>
    </div>

    <div class="messages">
      <div v-for="item in messages" :key="item.localKey" :class="['bubble', item.outgoing ? 'out' : 'in']">
        <div class="meta">{{ item.outgoing ? 'Ты' : item.from }} • {{ formatTime(item.ts) }}</div>
        <div>{{ item.text }}</div>
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
const {
  getMessages,
  getThreadLabel,
  markThreadRead,
  sendChatToThread,
  formatTime,
  peers,
  groups,
  openOrCreatePeerChat,
  openOrCreateGroupChat
} = useMeshApp()

const threadKey = computed(() => `${props.chatType}:${props.chatId}`)
const label = computed(() => getThreadLabel(threadKey.value))
const messages = computed(() => getMessages(threadKey.value))

watch(
  () => [props.chatType, props.chatId],
  ([type, id]) => {
    if (!type || !id) return

    if (type === 'peer') {
      const peer = peers.value.find((p) => p.nodeId === id)
      if (peer) openOrCreatePeerChat(peer)
    }

    if (type === 'group') {
      const group = groups.value.find((g) => g.id === id)
      if (group) openOrCreateGroupChat(group)
    }

    markThreadRead(`${type}:${id}`)
  },
  { immediate: true }
)

async function send() {
  const text = chatInput.value.trim()
  if (!text) return
  await sendChatToThread(threadKey.value, text)
  chatInput.value = ''
  markThreadRead(threadKey.value)
}
</script>
