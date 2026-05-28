<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const remaining = ref('Loading...')
let interval = null

onMounted(async () => {
  const res = await fetch('/api/target')
  const { target } = await res.json()
  const targetMs = new Date(target).getTime()

  const tick = () => {
    const diff = targetMs - Date.now()
    if (diff <= 0) {
      remaining.value = "It's Friday evening!"
      clearInterval(interval)
      return
    }
    const d = Math.floor(diff / 86400000)
    const h = Math.floor((diff % 86400000) / 3600000)
    const m = Math.floor((diff % 3600000) / 60000)
    const s = Math.floor((diff % 60000) / 1000)
    remaining.value = `${d}d ${h}h ${m}m ${s}s`
  }
  tick()
  interval = setInterval(tick, 1000)
})

onUnmounted(() => clearInterval(interval))
</script>

<template>
  <main>
    <h1>Managing mischief....</h1>
    <p class="time">{{ remaining }}</p>
  </main>
</template>

<style>
main { font-family: system-ui; text-align: center; margin-top: 20vh; }
.time { font-size: 3rem; font-variant-numeric: tabular-nums; }
</style>
