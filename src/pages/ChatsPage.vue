<template>
  <section class="route-panel">
    <h2>Чаты</h2>
    <div class="list">
      <button v-for="thread in chatThreads" :key="thread.key" class="list-item" @click="openThread(thread.key)">
        <div class="title-row">
          <strong>{{ thread.label }}</strong>
          <span v-if="thread.unread > 0" class="badge">{{ thread.unread }}</span>
        </div>
        <div class="small">{{ thread.preview }}</div>
      </button>
      <div v-if="chatThreads.length === 0" class="placeholder">Чатов пока нет. Открой Контакты или Группы.</div>
    </div>
  </section>
</template>

<script setup>
import { useHashNav } from '../state/hashNav'
import { useMeshApp } from '../state/useMeshApp'

const { chatThreads } = useMeshApp()
const { navigate } = useHashNav()

function openThread(threadKey) {
  if (threadKey.startsWith('peer:')) {
    const peerId = threadKey.replace('peer:', '')
    navigate(`/chat/peer/${encodeURIComponent(peerId)}`)
    return
  }

  if (threadKey.startsWith('group:')) {
    const groupId = threadKey.replace('group:', '')
    navigate(`/chat/group/${encodeURIComponent(groupId)}`)
  }
}
</script>
