<script setup lang="ts">
import { onMounted, ref } from "vue";

const question = ref("");
const answer = ref("");
const busy = ref(false);
const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const sourcesCount = ref(0);
const documentsCount = ref(0);
const lastUpdated = ref<string | null>(null);
const sources = ref<Array<{ documentId: string; title: string; url: string }>>([]);
const messageId = ref("");
const feedback = ref<"positive" | "negative" | null>(null);
const feedbackBusy = ref(false);

onMounted(async () => {
  const response = await fetch(`${apiBase}/api/knowledge`);
  if (!response.ok) return;
  const data = await response.json();
  sourcesCount.value = data.stats.sources;
  documentsCount.value = data.stats.documents;
  lastUpdated.value = data.stats.lastUpdated;
});

async function ask() {
  const value = question.value.trim();
  if (!value || busy.value) return;
  busy.value = true;
  answer.value = "";
  feedback.value = null;
  try {
    const response = await fetch(`${apiBase}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "请求失败");
    answer.value = data.answer;
    sources.value = data.sources;
    messageId.value = data.messageId;
  } catch (error) {
    answer.value = error instanceof Error ? error.message : "无法连接 API 服务";
  } finally {
    busy.value = false;
  }
}

async function sendFeedback(rating: "positive" | "negative") {
  if (!messageId.value || feedbackBusy.value || feedback.value) return;
  feedbackBusy.value = true;
  try {
    const response = await fetch(`${apiBase}/api/messages/${messageId.value}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (!response.ok) throw new Error();
    feedback.value = rating;
  } catch {
    answer.value = `${answer.value}\n\n评价提交失败，请稍后重试。`;
  } finally {
    feedbackBusy.value = false;
  }
}
</script>

<template>
  <main class="shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="NYZ RAG 首页"><span class="brand-mark">N</span><span>NYZ <b>知识问答</b></span></a>
      <div class="status"><span></span>文章知识库</div>
    </header>

    <section class="workspace">
      <aside class="rail" aria-label="主导航">
        <button class="rail-button active" aria-label="问答" title="问答">✳</button>
        <button class="rail-button" aria-label="搜索" title="搜索">⌕</button>
        <div class="rail-bottom"><button class="rail-button" aria-label="设置" title="设置">⚙</button></div>
      </aside>

      <section class="conversation">
        <div class="intro">
          <p class="eyebrow">NYZ ARTICLE INTELLIGENCE</p>
          <h1>从文章中，<span>找到答案。</span></h1>
          <p class="lede">向知识库提问，回答将基于已收录的文章内容。</p>
        </div>

        <form class="composer" @submit.prevent="ask">
          <label for="question">你的问题</label>
          <textarea id="question" v-model="question" rows="3" placeholder="例如：文章中提到的核心观点是什么？" @keydown.meta.enter.prevent="ask" @keydown.ctrl.enter.prevent="ask"></textarea>
          <div class="composer-footer">
            <span>Enter 换行 <i>·</i> ⌘ Enter 提交</span>
            <button type="submit" :disabled="busy || !question.trim()"><span>{{ busy ? "正在检索" : "提问" }}</span><b aria-hidden="true">↗</b></button>
          </div>
        </form>

        <section v-if="answer" class="answer" aria-live="polite">
          <div class="answer-heading"><span class="answer-icon">✳</span><div><strong>回答</strong><small>基于知识库检索</small></div></div>
          <p>{{ answer }}</p>
            <div class="sources"><span>引用来源</span><a v-for="source in sources" :key="source.documentId" :href="source.url" target="_blank" rel="noreferrer">{{ source.title }} ↗</a><span v-if="!sources.length" class="empty-source">暂无匹配文章</span></div>
            <div class="answer-feedback"><span>{{ feedback ? '感谢反馈' : '这个回答有帮助吗？' }}</span><button :disabled="feedbackBusy || !!feedback" :class="{ chosen: feedback === 'positive' }" aria-label="回答有帮助" title="有帮助" @click="sendFeedback('positive')">👍</button><button :disabled="feedbackBusy || !!feedback" :class="{ chosen: feedback === 'negative' }" aria-label="回答需要改进" title="需要改进" @click="sendFeedback('negative')">👎</button></div>
        </section>

        <div v-else class="suggestions">
          <p>试试这样提问</p>
          <button @click="question = '最近收录的文章有哪些主要主题？'">最近收录的文章有哪些主要主题？ <span>↗</span></button>
          <button @click="question = '帮我总结一篇文章的核心观点'">帮我总结一篇文章的核心观点 <span>↗</span></button>
        </div>
        <footer>回答由知识库内容生成，请结合原文核实重要信息。</footer>
      </section>

      <aside class="context-panel">
        <div class="panel-title"><span>知识库状态</span><span class="live-dot"></span></div>
        <div class="index-state"><div class="index-icon">▤</div><strong>准备就绪</strong><p>问答服务已连接</p></div>
        <div class="panel-divider"></div>
         <div class="metric"><span>收录文章</span><b>{{ documentsCount }}</b></div>
         <div class="metric"><span>数据源</span><b>{{ sourcesCount }}</b></div>
         <div class="panel-note"><span>i</span><p>{{ lastUpdated ? `最近更新于 ${new Date(lastUpdated).toLocaleString()}` : "等待管理端完成首次同步。" }}</p></div>
      </aside>
    </section>
  </main>
</template>
