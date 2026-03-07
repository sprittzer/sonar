import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

if (!window.location.hash) {
  window.location.hash = '/chats'
}

createApp(App).mount('#app')
