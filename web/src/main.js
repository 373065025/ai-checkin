import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import Dashboard from './views/Dashboard.vue'
import Tasks from './views/Tasks.vue'
import Logs from './views/Logs.vue'
import Settings from './views/Settings.vue'
import './styles.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: Dashboard },
    { path: '/tasks', component: Tasks },
    { path: '/logs', component: Logs },
    { path: '/settings', component: Settings },
  ],
})

createApp(App).use(router).mount('#app')
