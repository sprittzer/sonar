<template>
  <section class="route-panel">
    <h2>Группы</h2>

    <div class="row">
      <input v-model.trim="newGroupName" class="input" placeholder="Название группы" />
      <button class="btn" @click="submitCreateGroup">Создать</button>
    </div>

    <div class="member-picker">
      <label v-for="peer in peers" :key="peer.nodeId" class="member-item">
        <input type="checkbox" :value="peer.nodeId" v-model="selectedMembers" />
        <span>{{ peer.displayName || peer.nodeId }}</span>
      </label>
    </div>
    <p v-if="groupError" class="error">{{ groupError }}</p>

    <div class="list">
      <button v-for="group in groups" :key="group.id" class="list-item" @click="openGroup(group.id)">
        <div class="title-row">
          <strong>{{ group.name }}</strong>
        </div>
        <div class="small">{{ group.members.length }} участников</div>
      </button>
      <div v-if="groups.length === 0" class="placeholder">Группы пока не созданы.</div>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { useHashNav } from '../state/hashNav'
import { useMeshApp } from '../state/useMeshApp'

const { groups, peers, createGroup, openOrCreateGroupChat } = useMeshApp()
const { navigate } = useHashNav()

const newGroupName = ref('')
const selectedMembers = ref([])
const groupError = ref('')

function submitCreateGroup() {
  groupError.value = ''
  try {
    const group = createGroup(newGroupName.value, selectedMembers.value)
    openOrCreateGroupChat(group)
    newGroupName.value = ''
    selectedMembers.value = []
    navigate(`/chat/group/${encodeURIComponent(group.id)}`)
  } catch (error) {
    groupError.value = error?.message || 'Не удалось создать группу.'
  }
}

function openGroup(groupId) {
  navigate(`/chat/group/${encodeURIComponent(groupId)}`)
}
</script>
