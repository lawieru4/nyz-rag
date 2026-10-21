<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; updated: string };
type Task = { id: string; source: string; status: "已完成" | "运行中" | "等待中"; progress: number; started: string };
type Document = { id: string; sourceId: string; title: string; url: string; content: string; status: "pending" | "processing" | "ready" | "failed"; createdAt: string; updatedAt: string };
type KnowledgeBase = { id: string; name: string; description: string; topK: number; similarityThreshold: number; rerankEnabled: boolean; maxContextLength: number; prompt: string; model: string; createdAt: string; updatedAt: string };

const activeModule = ref("数据源");
const apiBase = "http://localhost:3000";
const dialogOpen = ref(false);
const notice = ref("");
const sources = ref<Source[]>([]);
const tasks = ref<Task[]>([]);
const documents = ref<Document[]>([]);
const documentTotal = ref(0);
const documentQuery = ref("");
const documentSource = ref("");
const documentStatus = ref("");
const documentPage = ref(1);
const documentPageSize = 10;
const documentsLoading = ref(false);
const selectedDocument = ref<Document | null>(null);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const knowledgeBaseDialogOpen = ref(false);
const editingKnowledgeBaseId = ref("");
const knowledgeBaseForm = ref({ name: "", description: "", topK: 5, similarityThreshold: 0.35, rerankEnabled: false, maxContextLength: 6000, prompt: "请依据提供的知识库内容回答问题；若资料不足，请明确说明。", model: "默认模型" });
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const form = ref({ name: "", url: "", kind: "文章 API", frequency: "每天" });
const runningTasks = computed(() => tasks.value.filter((task) => task.status === "运行中").length);
const documentPages = computed(() => Math.max(1, Math.ceil(documentTotal.value / documentPageSize)));

const documentStatuses = {
  pending: "待处理",
  processing: "处理中",
  ready: "已就绪",
  failed: "失败",
} as const;

async function loadKnowledge() {
  const response = await fetch(`${apiBase}/api/knowledge`);
  const data = await response.json();
  sources.value = data.sources.map((source: { id: string; name: string; url: string; kind: string; frequency: string; status: Source["status"]; documentCount: number; updatedAt: string | null }) => ({ ...source, pages: source.documentCount, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
  tasks.value = data.tasks.map((task: { id: string; sourceName: string; status: Task["status"]; progress: number; createdAt: string }) => ({ id: task.id, source: task.sourceName, status: task.status, progress: task.progress, started: new Date(task.createdAt).toLocaleString() }));
}

async function loadKnowledgeBases() {
  try {
    const response = await fetch(`${apiBase}/api/admin/knowledge-bases`);
    if (!response.ok) throw new Error();
    knowledgeBases.value = await response.json();
  } catch {
    notice.value = "知识库列表加载失败，请检查 API 服务";
  }
}

function editKnowledgeBase(item?: KnowledgeBase) {
  editingKnowledgeBaseId.value = item?.id ?? "";
  knowledgeBaseForm.value = item ? { name: item.name, description: item.description, topK: item.topK, similarityThreshold: item.similarityThreshold, rerankEnabled: item.rerankEnabled, maxContextLength: item.maxContextLength, prompt: item.prompt, model: item.model } : { name: "", description: "", topK: 5, similarityThreshold: 0.35, rerankEnabled: false, maxContextLength: 6000, prompt: "请依据提供的知识库内容回答问题；若资料不足，请明确说明。", model: "默认模型" };
  knowledgeBaseDialogOpen.value = true;
}

async function saveKnowledgeBase() {
  const editing = Boolean(editingKnowledgeBaseId.value);
  const response = await fetch(`${apiBase}/api/admin/knowledge-bases${editing ? `/${editingKnowledgeBaseId.value}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(knowledgeBaseForm.value) });
  if (!response.ok) { notice.value = "知识库保存失败，请检查配置"; return; }
  await loadKnowledgeBases();
  knowledgeBaseDialogOpen.value = false;
  notice.value = editing ? "知识库配置已更新" : "知识库已创建";
}

onMounted(() => void loadKnowledge());

async function loadDocuments() {
  documentsLoading.value = true;
  const params = new URLSearchParams({ page: String(documentPage.value), pageSize: String(documentPageSize) });
  if (documentQuery.value.trim()) params.set("query", documentQuery.value.trim());
  if (documentSource.value) params.set("sourceId", documentSource.value);
  if (documentStatus.value) params.set("status", documentStatus.value);
  try {
    const response = await fetch(`${apiBase}/api/admin/documents?${params}`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    documents.value = data.documents;
    documentTotal.value = data.total;
  } catch {
    notice.value = "文档列表加载失败，请检查 API 服务";
  } finally {
    documentsLoading.value = false;
  }
}

function searchDocuments() {
  documentPage.value = 1;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadDocuments(), 250);
}

async function openDocument(document: Document) {
  try {
    const response = await fetch(`${apiBase}/api/admin/documents/${document.id}`);
    if (!response.ok) throw new Error();
    selectedDocument.value = await response.json();
  } catch {
    notice.value = "文档详情加载失败";
  }
}

async function deleteDocument(document: Document) {
  if (!window.confirm(`确定删除《${document.title}》？此操作不可撤销。`)) return;
  const response = await fetch(`${apiBase}/api/admin/documents/${document.id}`, { method: "DELETE" });
  if (!response.ok) {
    notice.value = "文档删除失败";
    return;
  }
  if (documents.value.length === 1 && documentPage.value > 1) documentPage.value -= 1;
  selectedDocument.value = null;
  await Promise.all([loadDocuments(), loadKnowledge()]);
  notice.value = "文档已删除";
}

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
        <button v-for="item in [{ name: '数据源', icon: '◉' }, { name: '文档管理', icon: '▤' }, { name: '知识库', icon: '⌘' }, { name: '问答记录', icon: '☷' }, { name: '模型配置', icon: '⚙' }]" :key="item.name" :class="['nav-item', { selected: activeModule === item.name }]" @click="activeModule = item.name; item.name === '文档管理' && loadDocuments(); item.name === '知识库' && loadKnowledgeBases()">
          <span class="nav-icon">{{ item.icon }}</span>{{ item.name }}<span v-if="item.name === '数据源'" class="nav-count">{{ sources.length }}</span>
        </button>
      </nav>
      <div class="sidebar-bottom"><span class="avatar">NY</span><span class="operator"><b>知识库管理员</b><small>本地演示环境</small></span><span class="more">···</span></div>
    </aside>

    <main class="main-area">
      <header class="topbar"><div class="crumb">管理后台 <span>/</span> {{ activeModule }}</div><div class="top-actions"><span class="environment"><i></i>开发环境</span><button class="icon-button" title="通知" aria-label="通知">♧</button><button class="help-button">帮助中心</button></div></header>
      <div class="content">
        <template v-if="activeModule === '知识库'">
          <div class="page-heading"><div><p class="eyebrow">RETRIEVAL CONFIGURATION</p><h1>知识库</h1><p class="subtitle">维护召回策略、上下文和回答指令</p></div><button class="primary-button" @click="editKnowledgeBase()"><span>＋</span> 新建知识库</button></div>
          <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>
          <section class="section-block knowledge-base-section"><div class="section-heading"><div><h2>知识库配置</h2><p>{{ knowledgeBases.length }} 个知识库</p></div></div><div v-if="knowledgeBases.length" class="knowledge-base-list"><article v-for="item in knowledgeBases" :key="item.id" class="knowledge-base-row"><div class="knowledge-base-main"><div class="knowledge-base-title"><h3>{{ item.name }}</h3><span class="status-pill" :class="item.rerankEnabled ? 'on' : 'off'"><i></i>{{ item.rerankEnabled ? '重排序开启' : '重排序关闭' }}</span></div><p>{{ item.description || '未填写描述' }}</p><dl><div><dt>召回数量</dt><dd>{{ item.topK }}</dd></div><div><dt>相似度阈值</dt><dd>{{ item.similarityThreshold.toFixed(2) }}</dd></div><div><dt>最大上下文</dt><dd>{{ item.maxContextLength.toLocaleString() }} 字符</dd></div><div><dt>模型</dt><dd>{{ item.model }}</dd></div></dl></div><button class="secondary-button" @click="editKnowledgeBase(item)">编辑配置</button></article></div><div v-else class="empty-state">尚未创建知识库 <button class="text-button" @click="editKnowledgeBase()">创建第一个知识库</button></div></section>
        </template>
        <template v-else-if="activeModule === '文档管理'">
          <div class="page-heading"><div><p class="eyebrow">KNOWLEDGE OPERATIONS</p><h1>文档管理</h1><p class="subtitle">检索已收录内容并查看处理状态</p></div><span class="document-total">{{ documentTotal }} 篇文档</span></div>
          <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>
          <section class="section-block document-section">
            <div class="document-filters"><label class="search-field"><span aria-hidden="true">⌕</span><input v-model="documentQuery" placeholder="搜索标题、网址或正文" @input="searchDocuments" /></label><select v-model="documentSource" aria-label="筛选数据源" @change="documentPage = 1; loadDocuments()"><option value="">全部数据源</option><option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option></select><select v-model="documentStatus" aria-label="筛选文档状态" @change="documentPage = 1; loadDocuments()"><option value="">全部状态</option><option v-for="(label, status) in documentStatuses" :key="status" :value="status">{{ label }}</option></select></div>
            <div class="table-wrap document-table-wrap"><table><thead><tr><th>文档</th><th>数据源</th><th>状态</th><th>最后更新</th><th></th></tr></thead><tbody>
              <tr v-for="document in documents" :key="document.id"><td><button class="document-title" @click="openDocument(document)"><b>{{ document.title }}</b><small>{{ document.url }}</small></button></td><td>{{ sources.find((source) => source.id === document.sourceId)?.name ?? '未知数据源' }}</td><td><span :class="['status-pill', document.status === 'ready' ? 'on' : 'off']"><i></i>{{ documentStatuses[document.status] }}</span></td><td>{{ new Date(document.updatedAt).toLocaleString() }}</td><td><div class="row-actions"><button title="查看详情" aria-label="查看详情" @click="openDocument(document)">↗</button><button title="删除文档" aria-label="删除文档" @click="deleteDocument(document)">×</button></div></td></tr>
            </tbody></table></div>
            <div v-if="documentsLoading" class="empty-state">正在加载文档…</div>
            <div v-else-if="documents.length === 0" class="empty-state">{{ documentQuery || documentSource || documentStatus ? '没有符合条件的文档' : '知识库中还没有文档' }}</div>
            <div class="pagination"><span>共 {{ documentTotal }} 篇</span><button aria-label="上一页" :disabled="documentPage <= 1 || documentsLoading" @click="documentPage -= 1; loadDocuments()">←</button><span>{{ documentPage }} / {{ documentPages }}</span><button aria-label="下一页" :disabled="documentPage >= documentPages || documentsLoading" @click="documentPage += 1; loadDocuments()">→</button></div>
          </section>
        </template>
        <template v-else>
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
        </template>
      </div>
    </main>

    <div v-if="dialogOpen" class="modal-backdrop" @click.self="dialogOpen = false"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><p class="eyebrow">NEW CONNECTION</p><h2 id="dialog-title">添加数据源</h2></div><button class="close-button" aria-label="关闭" @click="dialogOpen = false">×</button></header><form @submit.prevent="addSource"><label>数据源名称<input v-model="form.name" autofocus placeholder="例如：产品帮助中心" required /></label><label>来源地址<input v-model="form.url" type="url" placeholder="https://example.com" required /></label><div class="form-grid"><label>来源类型<select v-model="form.kind"><option>文章 API</option><option>网页站点</option></select></label><label>同步频率<select v-model="form.frequency"><option>每小时</option><option>每 6 小时</option><option>每天</option><option>手动</option></select></label></div><div class="dialog-note">新增来源默认暂停，确认授权和抓取规则后再启动。</div><footer><button type="button" class="secondary-button" @click="dialogOpen = false">取消</button><button type="submit" class="primary-button">添加来源</button></footer></form></section></div>
    <div v-if="selectedDocument" class="modal-backdrop" @click.self="selectedDocument = null"><section class="dialog document-dialog" role="dialog" aria-modal="true" aria-labelledby="document-title"><header><div><p class="eyebrow">DOCUMENT DETAIL</p><h2 id="document-title">{{ selectedDocument.title }}</h2></div><button class="close-button" aria-label="关闭" @click="selectedDocument = null">×</button></header><div class="document-detail-meta"><span>{{ sources.find((source) => source.id === selectedDocument?.sourceId)?.name ?? '未知数据源' }}</span><span>{{ documentStatuses[selectedDocument.status] }}</span><a :href="selectedDocument.url" target="_blank" rel="noreferrer">打开原文 ↗</a></div><p class="document-content">{{ selectedDocument.content || '暂无正文内容' }}</p><footer><button class="secondary-button" @click="selectedDocument = null">关闭</button><button class="danger-button" @click="deleteDocument(selectedDocument)">删除文档</button></footer></section></div>
    <div v-if="knowledgeBaseDialogOpen" class="modal-backdrop" @click.self="knowledgeBaseDialogOpen = false"><section class="dialog knowledge-base-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-dialog-title"><header><div><p class="eyebrow">KNOWLEDGE BASE</p><h2 id="knowledge-base-dialog-title">{{ editingKnowledgeBaseId ? '编辑知识库' : '新建知识库' }}</h2></div><button class="close-button" aria-label="关闭" @click="knowledgeBaseDialogOpen = false">×</button></header><form @submit.prevent="saveKnowledgeBase"><label>名称<input v-model="knowledgeBaseForm.name" required maxlength="100" placeholder="例如：产品帮助中心" /></label><label>描述<input v-model="knowledgeBaseForm.description" maxlength="500" placeholder="知识库的内容范围" /></label><div class="form-grid"><label>召回数量<input v-model.number="knowledgeBaseForm.topK" type="number" min="1" max="100" required /></label><label>相似度阈值<input v-model.number="knowledgeBaseForm.similarityThreshold" type="number" min="0" max="1" step="0.01" required /></label><label>最大上下文长度<input v-model.number="knowledgeBaseForm.maxContextLength" type="number" min="256" step="256" required /></label><label>模型<input v-model="knowledgeBaseForm.model" required maxlength="100" /></label></div><label class="toggle-field"><input v-model="knowledgeBaseForm.rerankEnabled" type="checkbox" />启用重排序</label><label>回答提示词<textarea v-model="knowledgeBaseForm.prompt" rows="5" maxlength="10000" /></label><footer><button type="button" class="secondary-button" @click="knowledgeBaseDialogOpen = false">取消</button><button type="submit" class="primary-button">保存配置</button></footer></form></section></div>
  </div>
</template>
