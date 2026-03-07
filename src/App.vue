<template>
  <main class="page">
    <section class="app-shell">
      <header class="topbar">
        <h1>HEX Messenger</h1>
        <nav class="nav">
          <button class="nav-link" :class="{ active: activeSection === 'chats' }" @click="navigate('/chats')">Чаты</button>
          <button class="nav-link" :class="{ active: activeSection === 'contacts' }" @click="navigate('/contacts')">Контакты</button>
          <button class="nav-link" :class="{ active: activeSection === 'groups' }" @click="navigate('/groups')">Группы</button>
          <button class="nav-link" :class="{ active: activeSection === 'settings' }" @click="navigate('/settings')">Настройки</button>
        </nav>
      </header>

      <ChatsPage v-if="activeSection === 'chats'" />
      <ContactsPage v-else-if="activeSection === 'contacts'" />
      <GroupsPage v-else-if="activeSection === 'groups'" />
      <SettingsPage v-else-if="activeSection === 'settings'" />
      <ChatPage v-else-if="activeSection === 'chat'" :chat-type="activeChatType" :chat-id="activeChatId" />
      <ChatsPage v-else />
    </section>
  </main>
</template>

<script setup>
import ChatPage from './pages/ChatPage.vue'
import ChatsPage from './pages/ChatsPage.vue'
import ContactsPage from './pages/ContactsPage.vue'
import GroupsPage from './pages/GroupsPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import { useHashNav } from './state/hashNav'

const { activeSection, activeChatType, activeChatId, navigate } = useHashNav()
</script>
