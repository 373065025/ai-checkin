<script setup>
// 协议正文（安装后强制弹窗 与 设置页主动查看 共用同一份渲染）
defineProps({
  doc: { type: Object, required: true },
})
</script>

<template>
  <article class="agreement-doc">
    <div class="agreement-meta">
      <span class="tag">条款版本 {{ doc.revision }}</span>
      <span class="tag">更新于 {{ doc.updatedAt }}</span>
    </div>

    <p class="agreement-intro">{{ doc.intro }}</p>

    <section v-for="(s, i) in doc.sections" :key="i" class="agreement-section">
      <h4>{{ s.title }}</h4>
      <p>{{ s.body }}</p>
    </section>

    <p class="agreement-footnote">{{ doc.footnote }}</p>
  </article>
</template>
