<script setup lang="ts">
import { computed, ref } from "vue";

type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; updated: string };
type Task = { id: string; source: string; status: "已完成" | "运行中" | "等待中"; progress: number; started: string };

const activeModule = ref("数据源");
const apiBase = "http://localhost:3000";
const dialogOpen = ref(false);
const notice = ref("");
const sources = ref<Source[]>([]);
const tasks = ref<Task[]>([]);
const form = ref({ name: "", url: "", kind: "文章 API", frequency: "每天" });
const runningTasks = computed(() => tasks.value.filter((task) => task.status === "运行中").length);

async function loadKnowledge() {
  const response = await fetch(`${apiBase}/api/knowledge`);
  const data = await response.json();
  sources.value = data.sources.map((source: { id: string; name: string; url: string; kind: string; frequency: string; status: Source["status"]; documentCount: number; updatedAt: string | null }) => ({ ...source, pages: source.documentCount, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
  tasks.value = data.tasks.map((task: { id: string; sourceName: string; status: Task["status"]; progress: number; createdAt: string }) => ({ id: task.id, source: task.sourceName, status: task.status, progress: task.progress, started: new Date(task.createdAt).toLocaleString() }));
}

loadKnowledge();

async function addSource() {
  const name = form.value.name.trim();
  const url = form.value.url.trim();
  try {
    const parsed = new URL(url);
    if (!name || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    notice.value = "请填写名称和有效的 http(s) 地址";
    return;
  }
  const response = await fetch(`${apiBase}/api/admin/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form.value, name, url }) });
  if (!response.ok) { notice.value = "数据源添加失败"; return; }
  await loadKnowledge();
  form.value = { name: "", url: "", kind: "文章 API", frequency: "每天" };
  dialogOpen.value = false;
  notice.value = "数据源已添加，当前保存在本地演示状态";
}

function toggleSource(source: Source) {
  source.status = source.status === "运行中" ? "已暂停" : "运行中";
}

async function startCrawl(source: Source) {
  const response = await fetch(`${apiBase}/api/admin/sources/${source.id}/sync`, { method: "POST" });
  if (!response.ok) { notice.value = "同步任务创建失败"; return; }
  await loadKnowledge();
  notice.value = `${source.name} 的同步任务已加入处理队列`;
}
</script>

<template>
  <div class="admin-shell">
    <aside class="sidebar">
      <a class="brand" href="/"><span class="brand-mark">N</span><span>NYZ <b>KNOWLEDGE OPS</b></span></a>
      <div class="workspace-label">工作空间</div>
      <nav aria-label="管理模块">
        <button v-for="item in [{ name: '数据源', icon: '◉' }, { name: '文档管理', icon: '▤' }, { name: '知识库', icon: '⌘' }, { name: '问答记录', icon: '☷' }, { name: '模型配置', icon: '⚙' }]" :key="item.name" :class="['nav-item', { selected: activeModule === item.name }]" @click="activeModule = item.name">
          <span class="nav-icon">{{ item.icon }}</span>{{ item.name }}<span v-if="item.name === '数据源'" class="nav-count">{{ sources.length }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom"><span class="avatar">NY</span><span class="operator"><b>知识库管理员</b><small>本地演示环境</small></span><span class="more">···</span></div>
    </aside>

    <main class="main-area">
      <header class="topbar"><div class="crumb">管理后台 <span>/</span> {{ activeModule }}</div><div class="top-actions"><span class="environment"><i></i>开发环境</span><button class="icon-button" title="通知" aria-label="通知">♧</button><button class="help-button">帮助中心</button></div></header>
      <div class="content">
        <div class="page-heading"><div><p class="eyebrow">KNOWLEDGE OPERATIONS</p><h1>{{ activeModule }}</h1><p class="subtitle">管理内容来源与自动同步任务</p></div><button class="primary-button" @click="dialogOpen = true"><span>＋</span> 添加数据源</button></div>

        <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>

        <section class="summary-row" aria-label="数据源概览">
          <article class="summary-item"><span class="summary-label">数据源</span><strong>{{ sources.length }}</strong><small>已配置来源</small><span class="summary-glyph">◉</span></article>
          <article class="summary-item"><span class="summary-label">收录文章</span><strong>{{ sources.reduce((total, source) => total + source.pages, 0) }}</strong><small>来自全部数据源</small><span class="summary-glyph">▤</span></article>
          <article class="summary-item"><span class="summary-label">执行中任务</span><strong>{{ runningTasks }}</strong><small>队列与抓取进度</small><span class="summary-glyph">↻</span></article>
          <article class="summary-item"><span class="summary-label">最近同步</span><strong class="time-value">10<span>分钟</span></strong><small>NYZ 文章库</small><span class="summary-glyph">◷</span></article>
        </section>

        <section class="section-block">
          <div class="section-heading"><div><h2>数据源</h2><p>配置文章接口或站点，并管理同步计划</p></div><button class="text-button" @click="activeModule = '数据源'">查看全部 <span>↗</span></button></div>
          <div class="table-wrap"><table><thead><tr><th>名称</th><th>类型</th><th>同步频率</th><th>文章数</th><th>状态</th><th>最近同步</th><th></th></tr></thead><tbody>
             <tr v-for="source in sources" :key="source.id"><td><div class="source-name"><span class="source-symbol">{{ source.kind === '文章 API' ? 'A' : 'W' }}</span><span><b>{{ source.name }}</b><small>{{ source.url }}</small></span></div></td><td>{{ source.kind }}</td><td>{{ source.frequency }}</td><td class="numeric">{{ source.pages }}</td><td><span :class="['status-pill', source.status === '运行中' ? 'on' : 'off']"><i></i>{{ source.status }}</span></td><td>{{ source.updated }}</td><td><div class="row-actions"><button title="立即同步" aria-label="立即同步" @click="startCrawl(source)">↻</button><button title="暂停或启用" aria-label="暂停或启用" @click="toggleSource(source)">{{ source.status === '运行中' ? 'Ⅱ' : '▶' }}</button><button title="更多操作" aria-label="更多操作">···</button></div></td></tr>
          </tbody></table></div>
          <div v-if="sources.length === 0" class="empty-state">尚未添加数据源 <button class="text-button" @click="dialogOpen = true">添加第一个来源</button></div>
        </section>

        <section class="section-block task-section">
          <div class="section-heading"><div><h2>抓取任务</h2><p>查看近期同步状态与处理进度</p></div><button class="text-button" @click="activeModule = '抓取任务'">任务记录 <span>↗</span></button></div>
          <div class="task-list"><div v-for="task in tasks" :key="task.id" class="task-row"><span class="task-state" :class="task.status === '运行中' ? 'working' : task.status === '已完成' ? 'done' : 'waiting'">{{ task.status === '已完成' ? '✓' : task.status === '运行中' ? '↻' : '·' }}</span><div class="task-info"><b>{{ task.source }} <span>{{ task.id }}</span></b><small>{{ task.started }}</small></div><div class="progress-wrap"><div class="progress-track"><i :style="{ width: `${task.progress}%` }"></i></div><small>{{ task.status === '运行中' ? `${task.progress}%` : task.status === '已完成' ? '完成' : '排队中' }}</small></div><span class="task-result">{{ task.status === '已完成' ? '新增 0 篇' : task.status === '运行中' ? '正在解析文章' : '等待 Worker' }}</span><button class="row-more" aria-label="任务选项">···</button></div></div>
        </section>
        <footer class="disclaimer"><span>i</span>当前页面使用本地演示数据，后台 API 与数据库接入将在对应模块实现。</footer>
      </div>
    </main>

    <div v-if="dialogOpen" class="modal-backdrop" @click.self="dialogOpen = false"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><p class="eyebrow">NEW CONNECTION</p><h2 id="dialog-title">添加数据源</h2></div><button class="close-button" aria-label="关闭" @click="dialogOpen = false">×</button></header><form @submit.prevent="addSource"><label>数据源名称<input v-model="form.name" autofocus placeholder="例如：产品帮助中心" required /></label><label>来源地址<input v-model="form.url" type="url" placeholder="https://example.com" required /></label><div class="form-grid"><label>来源类型<select v-model="form.kind"><option>文章 API</option><option>网页站点</option></select></label><label>同步频率<select v-model="form.frequency"><option>每小时</option><option>每 6 小时</option><option>每天</option><option>手动</option></select></label></div><div class="dialog-note">新增来源默认暂停，确认授权和抓取规则后再启动。</div><footer><button type="button" class="secondary-button" @click="dialogOpen = false">取消</button><button type="submit" class="primary-button">添加来源</button></footer></form></section></div>
  </div>
</template>
