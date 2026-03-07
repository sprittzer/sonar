<template>
  <section class="route-panel">
    <h2>Контакты</h2>
    <div class="list">
      <button v-for="peer in peers" :key="peer.nodeId" class="list-item" @click="openContact(peer)">
        <div class="title-row"><strong>{{ peer.displayName || peer.nodeId }}</strong></div>
        <div class="small">{{ peer.nodeId.slice(0, 8) }} • {{ peer.address }}:{{ peer.port }}</div>
      </button>
      <div v-if="peers.length === 0" class="placeholder">Пользователи не найдены.</div>
    </div>
  </section>
</template>

<script setup>
import { useHashNav } from '../state/hashNav'
import { useMeshApp } from '../state/useMeshApp'

const { peers, openOrCreatePeerChat } = useMeshApp()
const { navigate } = useHashNav()

function openContact(peer) {
  const key = openOrCreatePeerChat(peer)
  const peerId = key.replace('peer:', '')
  navigate(`/chat/peer/${encodeURIComponent(peerId)}`)
}
</script>
