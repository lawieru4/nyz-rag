<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { DocumentRecord, DocumentSummary } from "@nyz-rag/types";
import { createApiClient, ApiError } from "@nyz-rag/api-client";

type Source = { id: string; name: string; url: string; kind: string; frequency: string; status: "运行中" | "已暂停"; pages: number; updated: string };
type Task = { id: string; source: string; status: "已完成" | "运行中" | "等待中" | "失败"; progress: number; started: string; error?: string };
type Document = DocumentSummary;
type KnowledgeBase = { id: string; name: string; description: string; topK: number; similarityThreshold: number; rerankEnabled: boolean; maxContextLength: number; prompt: string; model: string; createdAt: string; updatedAt: string };
type ChatLog = {
  id: string; sessionId?: string; supersededAt?: string; question: string; answer: string; answerMode: "generated" | "extractive"; model?: string; retrievalMs?: number; firstTokenMs?: number; totalMs?: number; promptTokens?: number; completionTokens?: number;
  sources: Array<{ documentId: string; title: string; url: string; repostSource?: string }>;
  chunks: Array<{ chunkId: string; documentId: string; citation: number; title: string; sectionPath: string[]; excerpt: string; score: number; vectorScore?: number; keywordScore?: number; rerankScore?: number }>;
  rating: "positive" | "negative" | null; createdAt: string;
};
type ModelProvider = { id: string; name: string; provider: string; baseUrl: string; chatModel: string; embeddingModel: string; rerankModel: string; temperature: number; maxTokens: number; credentialEnv: string; enabled: boolean; isDefault: boolean; createdAt: string; updatedAt: string };

const activeModule = ref("数据源");
const client = createApiClient(import.meta.env.VITE_API_URL ?? "http://localhost:3000");
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
const selectedDocument = ref<DocumentRecord | null>(null);
const knowledgeBases = ref<KnowledgeBase[]>([]);
const chatLogs = ref<ChatLog[]>([]);
const chatLogTotal = ref(0);
const chatLogQuery = ref("");
const chatLogRating = ref("");
const chatLogPage = ref(1);
const chatLogsLoading = ref(false);
const selectedChatLog = ref<ChatLog | null>(null);
const modelProviders = ref<ModelProvider[]>([]);
const modelProviderDialogOpen = ref(false);
const editingModelProviderId = ref("");
const modelProviderForm = ref({ name: "", provider: "OpenAI 兼容", baseUrl: "", chatModel: "", embeddingModel: "", rerankModel: "", temperature: 0.3, maxTokens: 1024, credentialEnv: "OPENAI_API_KEY", enabled: false, isDefault: false });
const knowledgeBaseDialogOpen = ref(false);
const editingKnowledgeBaseId = ref("");
const knowledgeBaseForm = ref({ name: "", description: "", topK: 5, similarityThreshold: 0.35, rerankEnabled: false, maxContextLength: 6000, prompt: "请依据提供的知识库内容回答问题；若资料不足，请明确说明。", model: "默认模型" });
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const form = ref({ name: "", url: "", kind: "文章 API", frequency: "每天" });
const runningTasks = computed(() => tasks.value.filter((task) => task.status === "运行中").length);
const documentPages = computed(() => Math.max(1, Math.ceil(documentTotal.value / documentPageSize)));
const chatLogPages = computed(() => Math.max(1, Math.ceil(chatLogTotal.value / documentPageSize)));

const documentStatuses = {
  pending: "待处理",
  processing: "处理中",
  ready: "已就绪",
  failed: "失败",
} as const;
const embeddingStatuses = { pending: "待向量化", queued: "向量排队中", processing: "向量化中", ready: "已向量化", failed: "向量化失败" } as const;
const documentBusy = (document: Document) => document.embedding?.status === "queued" || document.embedding?.status === "processing" || document.processingStatus === "cleaning";

async function loadKnowledge() {
  const data = await client.request<{
    sources: Array<{ id: string; name: string; url: string; kind: string; frequency: string; status: Source["status"]; documentCount: number; updatedAt: string | null }>;
    tasks: Array<{ id: string; sourceName: string; status: Task["status"]; progress: number; createdAt: string; error?: string }>;
  }>("/api/knowledge");
  sources.value = data.sources.map((source) => ({ ...source, pages: source.documentCount, updated: source.updatedAt ? new Date(source.updatedAt).toLocaleString() : "尚未同步" }));
  tasks.value = data.tasks.map((task) => ({ id: task.id, source: task.sourceName, status: task.status, progress: task.progress, started: new Date(task.createdAt).toLocaleString(), error: task.error }));
}

async function loadKnowledgeBases() {
  try {
    knowledgeBases.value = await client.request<KnowledgeBase[]>("/api/admin/knowledge-bases");
  } catch {
    notice.value = "知识库列表加载失败，请检查 API 服务";
  }
}

async function loadChatLogs() {
  chatLogsLoading.value = true;
  const params = new URLSearchParams({ page: String(chatLogPage.value), pageSize: String(documentPageSize) });
  if (chatLogQuery.value.trim()) params.set("query", chatLogQuery.value.trim());
  if (chatLogRating.value) params.set("rating", chatLogRating.value);
  try {
    const data = await client.request<{ logs: ChatLog[]; total: number }>(`/api/admin/chat-logs?${params}`);
    chatLogs.value = data.logs;
    chatLogTotal.value = data.total;
  } catch {
    notice.value = "问答记录加载失败，请检查 API 服务";
  } finally {
    chatLogsLoading.value = false;
  }
}

async function loadModelProviders() {
  try {
    modelProviders.value = await client.request<ModelProvider[]>("/api/admin/model-providers");
  } catch {
    notice.value = "模型配置加载失败，请检查 API 服务";
  }
}

function editModelProvider(provider?: ModelProvider) {
  editingModelProviderId.value = provider?.id ?? "";
  modelProviderForm.value = provider ? { name: provider.name, provider: provider.provider, baseUrl: provider.baseUrl, chatModel: provider.chatModel, embeddingModel: provider.embeddingModel, rerankModel: provider.rerankModel, temperature: provider.temperature, maxTokens: provider.maxTokens, credentialEnv: provider.credentialEnv, enabled: provider.enabled, isDefault: provider.isDefault } : { name: "", provider: "OpenAI 兼容", baseUrl: "", chatModel: "", embeddingModel: "", rerankModel: "", temperature: 0.3, maxTokens: 1024, credentialEnv: "OPENAI_API_KEY", enabled: false, isDefault: false };
  modelProviderDialogOpen.value = true;
}

async function saveModelProvider() {
  const editing = Boolean(editingModelProviderId.value);
  try {
    await client.request(`/api/admin/model-providers${editing ? `/${editingModelProviderId.value}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(modelProviderForm.value) });
    await loadModelProviders();
    modelProviderDialogOpen.value = false;
    notice.value = editing ? "模型配置已更新" : "模型配置已添加";
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : "模型配置保存失败，请检查 API 服务";
  }
}

async function toggleModelProvider(provider: ModelProvider) {
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...configuration } = provider;
  try {
    await client.request(`/api/admin/model-providers/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...configuration, enabled: !provider.enabled }) });
    await loadModelProviders();
    notice.value = provider.enabled ? "模型配置已停用" : "模型配置已启用";
  } catch {
    notice.value = "模型状态更新失败";
  }
}

async function deleteModelProvider(provider: ModelProvider) {
  if (!window.confirm(`确定删除模型配置“${provider.name}”？`)) return;
  try {
    await client.request(`/api/admin/model-providers/${provider.id}`, { method: "DELETE" });
    await loadModelProviders();
    notice.value = "模型配置已删除";
  } catch {
    notice.value = "模型配置删除失败";
  }
}

function editKnowledgeBase(item?: KnowledgeBase) {
  editingKnowledgeBaseId.value = item?.id ?? "";
  knowledgeBaseForm.value = item ? { name: item.name, description: item.description, topK: item.topK, similarityThreshold: item.similarityThreshold, rerankEnabled: item.rerankEnabled, maxContextLength: item.maxContextLength, prompt: item.prompt, model: item.model } : { name: "", description: "", topK: 5, similarityThreshold: 0.35, rerankEnabled: false, maxContextLength: 6000, prompt: "请依据提供的知识库内容回答问题；若资料不足，请明确说明。", model: "默认模型" };
  knowledgeBaseDialogOpen.value = true;
}

async function saveKnowledgeBase() {
  const editing = Boolean(editingKnowledgeBaseId.value);
  try {
    await client.request(`/api/admin/knowledge-bases${editing ? `/${editingKnowledgeBaseId.value}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(knowledgeBaseForm.value) });
    await loadKnowledgeBases();
    knowledgeBaseDialogOpen.value = false;
    notice.value = editing ? "知识库配置已更新" : "知识库已创建";
  } catch {
    notice.value = "知识库保存失败，请检查配置";
  }
}

let documentRefreshTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void loadKnowledge();
  documentRefreshTimer = setInterval(() => {
    if (activeModule.value === "文档管理" && !documentsLoading.value) void loadDocuments();
  }, 3000);
});
onUnmounted(() => { clearInterval(documentRefreshTimer); clearTimeout(searchTimer); });

async function loadDocuments() {
  documentsLoading.value = true;
  const params = new URLSearchParams({ page: String(documentPage.value), pageSize: String(documentPageSize) });
  if (documentQuery.value.trim()) params.set("query", documentQuery.value.trim());
  if (documentSource.value) params.set("sourceId", documentSource.value);
  if (documentStatus.value) params.set("status", documentStatus.value);
  try {
    const data = await client.request<{ documents: Document[]; total: number }>(`/api/admin/documents?${params}`);
    documents.value = data.documents;
    documentTotal.value = data.total;
    if (selectedDocument.value) {
      const updated = documents.value.find((document) => document.id === selectedDocument.value?.id);
      // 列表只含摘要字段：正文变化时重新拉取详情，否则只合并状态。
      if (updated && updated.updatedAt !== selectedDocument.value.updatedAt) void openDocument(updated);
      else if (updated) selectedDocument.value = { ...selectedDocument.value, ...updated };
    }
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
    selectedDocument.value = await client.request<DocumentRecord>(`/api/admin/documents/${document.id}`);
  } catch {
    notice.value = "文档详情加载失败";
  }
}

async function reprocessDocument(document: Document) {
  try {
    await client.request(`/api/admin/documents/${document.id}/reprocess`, { method: "POST" });
    notice.value = `《${document.title}》已加入清洗与切片队列`;
    await loadDocuments();
  } catch {
    notice.value = "文档重处理任务创建失败";
  }
}

async function embedDocument(document: Document) {
  try {
    await client.request(`/api/admin/documents/${document.id}/embed`, { method: "POST" });
    notice.value = `《${document.title}》已加入向量化队列`;
    await loadDocuments();
  } catch (err) {
    notice.value = err instanceof ApiError ? err.message : "向量化任务创建失败，请检查 API 服务";
  }
}

async function deleteDocument(document: Document) {
  if (!window.confirm(`确定删除《${document.title}》？此操作不可撤销。`)) return;
  try {
    await client.request(`/api/admin/documents/${document.id}`, { method: "DELETE" });
    if (documents.value.length === 1 && documentPage.value > 1) documentPage.value -= 1;
    selectedDocument.value = null;
    await Promise.all([loadDocuments(), loadKnowledge()]);
    notice.value = "文档已删除";
  } catch {
    notice.value = "文档删除失败";
  }
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
  try {
    await client.request("/api/admin/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form.value, name, url }) });
    await loadKnowledge();
    form.value = { name: "", url: "", kind: "文章 API", frequency: "每天" };
    dialogOpen.value = false;
    notice.value = "数据源已添加，当前保存在本地演示状态";
  } catch {
    notice.value = "数据源添加失败";
  }
}

async function toggleSource(source: Source) {
  const status = source.status === "运行中" ? "已暂停" : "运行中";
  try {
    await client.request(`/api/admin/sources/${source.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
    source.status = status;
    notice.value = status === "运行中" ? "数据源已启用" : "数据源已暂停";
  } catch {
    notice.value = "数据源状态更新失败，请检查 API 服务";
  }
}

async function startCrawl(source: Source) {
  try {
    await client.request(`/api/admin/sources/${source.id}/sync`, { method: "POST" });
    await loadKnowledge();
    notice.value = `${source.name} 的同步任务已加入处理队列`;
  } catch (err) {
    notice.value = err instanceof ApiError ? `同步任务创建失败：${err.message}` : "同步任务创建失败";
  }
}
</script>

<template>
  <div class="admin-shell">
    <aside class="sidebar">
      <a class="brand" href="/"><span class="brand-mark">N</span><span>NYZ <b>KNOWLEDGE OPS</b></span></a>
      <div class="workspace-label">工作空间</div>
      <nav aria-label="管理模块">
        <button v-for="item in [{ name: '数据源', icon: '◉' }, { name: '文档管理', icon: '▤' }, { name: '知识库', icon: '⌘' }, { name: '问答记录', icon: '☷' }, { name: '模型配置', icon: '⚙' }]" :key="item.name" :class="['nav-item', { selected: activeModule === item.name }]" @click="activeModule = item.name; item.name === '文档管理' && loadDocuments(); item.name === '知识库' && loadKnowledgeBases(); item.name === '问答记录' && loadChatLogs(); item.name === '模型配置' && loadModelProviders()">
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
            <div class="table-wrap document-table-wrap"><table><thead><tr><th>文档</th><th>数据源</th><th>状态</th><th>向量化</th><th>最后更新</th><th></th></tr></thead><tbody>
              <tr v-for="document in documents" :key="document.id"><td><button class="document-title" @click="openDocument(document)"><b>{{ document.title }}</b><small>{{ document.url }}</small></button></td><td>{{ sources.find((source) => source.id === document.sourceId)?.name ?? '未知数据源' }}</td><td><span :class="['status-pill', document.processingStatus === 'chunked' ? 'on' : 'off']"><i></i>{{ document.processingStatus === 'chunked' ? `已切片 ${document.chunkCount}` : document.processingStatus === 'cleaning' ? '清洗中' : document.processingStatus === 'failed' ? '处理失败' : '待处理' }}</span></td><td><span :class="['status-pill', document.embedding?.status === 'ready' ? 'on' : 'off']" :title="document.embedding?.error"><i></i>{{ embeddingStatuses[document.embedding?.status ?? 'pending'] }}</span></td><td>{{ new Date(document.updatedAt).toLocaleString() }}</td><td><div class="row-actions"><button :disabled="documentBusy(document) || !document.chunkCount" title="向量化或重试" aria-label="向量化或重试" @click="embedDocument(document)">向量化</button><button :disabled="documentBusy(document)" title="重新清洗与切片" aria-label="重新清洗与切片" @click="reprocessDocument(document)">↻</button><button title="查看详情" aria-label="查看详情" @click="openDocument(document)">↗</button><button :disabled="documentBusy(document)" title="删除文档" aria-label="删除文档" @click="deleteDocument(document)">×</button></div></td></tr>
            </tbody></table></div>
            <div v-if="documentsLoading" class="empty-state">正在加载文档…</div>
            <div v-else-if="documents.length === 0" class="empty-state">{{ documentQuery || documentSource || documentStatus ? '没有符合条件的文档' : '知识库中还没有文档' }}</div>
            <div class="pagination"><span>共 {{ documentTotal }} 篇</span><button aria-label="上一页" :disabled="documentPage <= 1 || documentsLoading" @click="documentPage -= 1; loadDocuments()">←</button><span>{{ documentPage }} / {{ documentPages }}</span><button aria-label="下一页" :disabled="documentPage >= documentPages || documentsLoading" @click="documentPage += 1; loadDocuments()">→</button></div>
          </section>
        </template>
        <template v-else-if="activeModule === '问答记录'">
          <div class="page-heading"><div><p class="eyebrow">CONVERSATION AUDIT</p><h1>问答记录</h1><p class="subtitle">查看用户提问、模型回答、引用来源与评价</p></div><span class="document-total">{{ chatLogTotal }} 条记录</span></div>
          <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>
          <section class="section-block document-section">
            <div class="document-filters"><label class="search-field"><span aria-hidden="true">⌕</span><input v-model="chatLogQuery" placeholder="搜索问题、回答或来源" @input="chatLogPage = 1; loadChatLogs()" /></label><select v-model="chatLogRating" aria-label="筛选评价" @change="chatLogPage = 1; loadChatLogs()"><option value="">全部评价</option><option value="rated">已评价</option><option value="unrated">未评价</option></select></div>
            <div class="table-wrap document-table-wrap"><table><thead><tr><th>用户提问</th><th>引用来源</th><th>评价</th><th>时间</th><th></th></tr></thead><tbody>
              <tr v-for="log in chatLogs" :key="log.id"><td><button class="document-title" @click="selectedChatLog = log"><b>{{ log.question }}</b><small>{{ log.supersededAt ? '[已重新生成] ' : '' }}{{ log.answer }}</small></button></td><td>{{ log.sources.length ? log.sources.map((source) => source.title).join('、') : '无引用' }}</td><td><span :class="['status-pill', log.rating === 'positive' ? 'on' : 'off']"><i></i>{{ log.rating === 'positive' ? '有帮助' : log.rating === 'negative' ? '需改进' : '未评价' }}</span></td><td>{{ new Date(log.createdAt).toLocaleString() }}</td><td><div class="row-actions"><button title="查看详情" aria-label="查看详情" @click="selectedChatLog = log">↗</button></div></td></tr>
            </tbody></table></div>
            <div v-if="chatLogsLoading" class="empty-state">正在加载问答记录…</div><div v-else-if="chatLogs.length === 0" class="empty-state">没有符合条件的问答记录</div>
            <div class="pagination"><span>共 {{ chatLogTotal }} 条</span><button aria-label="上一页" :disabled="chatLogPage <= 1 || chatLogsLoading" @click="chatLogPage -= 1; loadChatLogs()">←</button><span>{{ chatLogPage }} / {{ chatLogPages }}</span><button aria-label="下一页" :disabled="chatLogPage >= chatLogPages || chatLogsLoading" @click="chatLogPage += 1; loadChatLogs()">→</button></div>
          </section>
        </template>
        <template v-else-if="activeModule === '模型配置'">
          <div class="page-heading"><div><p class="eyebrow">MODEL PROVIDERS</p><h1>模型配置</h1><p class="subtitle">管理 Chat、Embedding 与 Rerank 模型供应商</p></div><button class="primary-button" @click="editModelProvider()"><span>＋</span> 添加供应商</button></div>
          <div v-if="notice" class="notice" role="status"><span>{{ notice }}</span><button aria-label="关闭提示" @click="notice = ''">×</button></div>
          <section class="section-block model-provider-section"><div class="section-heading"><div><h2>供应商</h2><p>{{ modelProviders.length }} 个配置</p></div></div><div v-if="modelProviders.length" class="model-provider-list"><article v-for="provider in modelProviders" :key="provider.id" class="model-provider-row"><div class="model-provider-main"><div class="knowledge-base-title"><h3>{{ provider.name }}</h3><span class="status-pill" :class="provider.enabled ? 'on' : 'off'"><i></i>{{ provider.enabled ? '已启用' : '已停用' }}</span><span v-if="provider.isDefault" class="default-tag">默认</span></div><p>{{ provider.provider }}<span v-if="provider.baseUrl"> · {{ provider.baseUrl }}</span></p><dl><div><dt>Chat</dt><dd>{{ provider.chatModel }}</dd></div><div><dt>Embedding</dt><dd>{{ provider.embeddingModel || '未配置' }}</dd></div><div><dt>Rerank</dt><dd>{{ provider.rerankModel || '未配置' }}</dd></div><div><dt>温度 / 最大 Token</dt><dd>{{ provider.temperature }} / {{ provider.maxTokens }}</dd></div><div><dt>密钥环境变量</dt><dd>{{ provider.credentialEnv }}</dd></div></dl></div><div class="model-provider-actions"><button class="secondary-button" @click="editModelProvider(provider)">编辑</button><button class="secondary-button" @click="toggleModelProvider(provider)">{{ provider.enabled ? '停用' : '启用' }}</button><button class="danger-button" @click="deleteModelProvider(provider)">删除</button></div></article></div><div v-else class="empty-state">尚未配置模型供应商 <button class="text-button" @click="editModelProvider()">添加第一个供应商</button></div><p class="model-provider-note">启用默认供应商并填写 Embedding 模型后，新文档会在切片后自动向量化，已收录文档可在文档管理中手动向量化或重试。问答使用默认供应商的 Chat 模型生成回答（未配置或调用失败时摘录原文片段）；知识库开启重排序且填写 Rerank 模型时，召回结果会经过重排序。</p></section>
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
           <div class="task-list"><div v-for="task in tasks" :key="task.id" class="task-row"><span class="task-state" :class="task.status === '运行中' ? 'working' : task.status === '已完成' ? 'done' : task.status === '失败' ? 'failed' : 'waiting'">{{ task.status === '已完成' ? '✓' : task.status === '运行中' ? '↻' : task.status === '失败' ? '!' : '·' }}</span><div class="task-info"><b>{{ task.source }} <span>{{ task.id }}</span></b><small>{{ task.error || task.started }}</small></div><div class="progress-wrap"><div class="progress-track"><i :style="{ width: `${task.progress}%` }"></i></div><small>{{ task.status === '运行中' ? `${task.progress}%` : task.status === '已完成' ? '完成' : task.status === '失败' ? '失败' : '排队中' }}</small></div><span class="task-result">{{ task.status === '已完成' ? '采集完成' : task.status === '运行中' ? '正在采集页面' : task.status === '失败' ? '采集失败' : '等待 Worker' }}</span><button class="row-more" aria-label="任务选项">···</button></div></div>
        </section>
         <footer class="disclaimer"><span>i</span>网页站点按 robots.txt 与请求间隔限制采集；文章 API 来源按 updateTime 增量同步，token 由 Worker 环境变量提供。</footer>
        </template>
      </div>
    </main>

    <div v-if="dialogOpen" class="modal-backdrop" @click.self="dialogOpen = false"><section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><p class="eyebrow">NEW CONNECTION</p><h2 id="dialog-title">添加数据源</h2></div><button class="close-button" aria-label="关闭" @click="dialogOpen = false">×</button></header><form @submit.prevent="addSource"><label>数据源名称<input v-model="form.name" autofocus placeholder="例如：产品帮助中心" required /></label><label>来源地址<input v-model="form.url" type="url" :placeholder="form.kind === '文章 API' ? 'https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=…' : 'https://example.com'" required /></label><div class="form-grid"><label>来源类型<select v-model="form.kind"><option>文章 API</option><option>网页站点</option></select></label><label>同步频率<select v-model="form.frequency"><option>每小时</option><option>每 6 小时</option><option>每天</option><option>手动</option></select></label></div><div class="dialog-note">新增来源默认暂停，确认授权和抓取规则后再启动。文章 API 填写文章列表接口地址（不含 token），token 在 Worker 环境变量 NYZ_ARTICLE_TOKEN 中配置。</div><footer><button type="button" class="secondary-button" @click="dialogOpen = false">取消</button><button type="submit" class="primary-button">添加来源</button></footer></form></section></div>
    <div v-if="selectedDocument" class="modal-backdrop" @click.self="selectedDocument = null"><section class="dialog document-dialog" role="dialog" aria-modal="true" aria-labelledby="document-title"><header><div><p class="eyebrow">DOCUMENT DETAIL</p><h2 id="document-title">{{ selectedDocument.title }}</h2></div><button class="close-button" aria-label="关闭" @click="selectedDocument = null">×</button></header><div class="document-detail-meta"><span>{{ sources.find((source) => source.id === selectedDocument?.sourceId)?.name ?? '未知数据源' }}</span><span>{{ documentStatuses[selectedDocument.status] }}</span><span>{{ selectedDocument.chunkCount }} 个切片</span><a :href="selectedDocument.url" target="_blank" rel="noreferrer">打开原文 ↗</a></div><div class="document-detail-meta"><span>{{ embeddingStatuses[selectedDocument.embedding?.status ?? 'pending'] }}</span><span v-if="selectedDocument.embedding?.model">{{ selectedDocument.embedding.model }}</span><span v-if="selectedDocument.embedding?.dimensions">{{ selectedDocument.embedding.dimensions }} 维 / {{ selectedDocument.embedding.chunkCount }} 个向量</span></div><div v-if="selectedDocument.externalId" class="document-detail-meta"><span v-if="selectedDocument.author">作者 {{ selectedDocument.author }}</span><span v-if="selectedDocument.category">{{ selectedDocument.category }}</span><span v-if="selectedDocument.publishedAt">发布于 {{ new Date(selectedDocument.publishedAt).toLocaleDateString() }}</span><span v-if="selectedDocument.metadata?.sourceMeta?.repostSource">转载源 {{ selectedDocument.metadata.sourceMeta.repostSource }}</span><span v-if="selectedDocument.metadata?.doi">DOI {{ selectedDocument.metadata.doi }}</span><span v-if="selectedDocument.tags.length">标签 {{ selectedDocument.tags.join('、') }}</span><span v-if="selectedDocument.metadata?.sourceMeta?.keywords.length">关键词 {{ selectedDocument.metadata.sourceMeta.keywords.join('、') }}</span><span v-if="selectedDocument.metadata?.sourceMeta?.scenarios.length">场景 {{ selectedDocument.metadata.sourceMeta.scenarios.join('、') }}</span><span v-if="selectedDocument.parserVersion">解析器 v{{ selectedDocument.parserVersion }}</span></div><p v-if="selectedDocument.embedding?.error" class="notice">{{ selectedDocument.embedding.error }}</p><p v-if="selectedDocument.processingError" class="notice">{{ selectedDocument.processingError }}</p><p class="document-content">{{ selectedDocument.content || '暂无正文内容' }}</p><details v-if="selectedDocument.chunks.length"><summary>查看切片（{{ selectedDocument.chunks.length }}）</summary><div class="document-chunks"><article v-for="chunk in selectedDocument.chunks" :key="chunk.id"><small>#{{ chunk.index + 1 }} · {{ chunk.sectionPath?.length ? chunk.sectionPath.join(' > ') : '无章节' }} · 约 {{ chunk.tokenEstimate }} tokens{{ chunk.contentType === 'table' ? ' · 表格' : '' }}</small><p>{{ chunk.content }}</p></article></div></details><details v-if="selectedDocument.metadata?.followUpQuestions.length"><summary>推荐追问（{{ selectedDocument.metadata.followUpQuestions.length }}）</summary><ul class="document-questions"><li v-for="question in selectedDocument.metadata.followUpQuestions" :key="question">{{ question }}</li></ul></details><details v-if="selectedDocument.markdown"><summary>查看完整 Markdown</summary><pre class="document-content">{{ selectedDocument.markdown }}</pre></details><details v-if="selectedDocument.rawHtml"><summary>查看原始 HTML</summary><pre class="document-content">{{ selectedDocument.rawHtml }}</pre></details><footer><button class="secondary-button" @click="selectedDocument = null">关闭</button><button class="secondary-button" :disabled="documentBusy(selectedDocument) || !selectedDocument.chunkCount" @click="embedDocument(selectedDocument)">向量化 / 重试</button><button class="secondary-button" :disabled="documentBusy(selectedDocument)" @click="reprocessDocument(selectedDocument)">重新处理</button><button class="danger-button" :disabled="documentBusy(selectedDocument)" @click="deleteDocument(selectedDocument)">删除文档</button></footer></section></div>
    <div v-if="selectedChatLog" class="modal-backdrop" @click.self="selectedChatLog = null"><section class="dialog document-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-log-title"><header><div><p class="eyebrow">CONVERSATION DETAIL</p><h2 id="chat-log-title">问答详情</h2></div><button class="close-button" aria-label="关闭" @click="selectedChatLog = null">×</button></header><div class="document-detail-meta"><span>{{ new Date(selectedChatLog.createdAt).toLocaleString() }}</span><span>{{ selectedChatLog.rating === 'positive' ? '有帮助' : selectedChatLog.rating === 'negative' ? '需改进' : '未评价' }}</span><span>{{ selectedChatLog.answerMode === 'generated' ? `模型生成 · ${selectedChatLog.model}` : '原文摘录' }}</span><span :title="selectedChatLog.sessionId">{{ selectedChatLog.sessionId ? `会话 ${selectedChatLog.sessionId.slice(0, 8)}` : '单次问答' }}</span><span v-if="selectedChatLog.supersededAt">已被重新生成替换（{{ new Date(selectedChatLog.supersededAt).toLocaleString() }}）</span></div><div v-if="selectedChatLog.totalMs !== undefined" class="document-detail-meta"><span>检索 {{ selectedChatLog.retrievalMs }} ms</span><span v-if="selectedChatLog.firstTokenMs !== undefined">首 Token {{ selectedChatLog.firstTokenMs }} ms</span><span>总耗时 {{ selectedChatLog.totalMs }} ms</span><span v-if="selectedChatLog.promptTokens !== undefined">Token {{ selectedChatLog.promptTokens }} + {{ selectedChatLog.completionTokens }}</span></div><h3>用户提问</h3><p class="document-content">{{ selectedChatLog.question }}</p><h3>回答</h3><p class="document-content">{{ selectedChatLog.answer }}</p><h3>引用来源</h3><div class="chat-log-sources"><a v-for="(source, index) in selectedChatLog.sources" :key="source.documentId" :href="source.url" target="_blank" rel="noreferrer">[{{ index + 1 }}] {{ source.title }}{{ source.repostSource ? `（转载自 ${source.repostSource}）` : '' }} ↗</a><span v-if="!selectedChatLog.sources.length">无引用来源</span></div><details v-if="selectedChatLog.chunks.length"><summary>召回片段（{{ selectedChatLog.chunks.length }}）</summary><div class="document-chunks"><article v-for="chunk in selectedChatLog.chunks" :key="chunk.chunkId"><small>[{{ chunk.citation }}] {{ chunk.title }}{{ chunk.sectionPath.length ? ` · ${chunk.sectionPath.join(' > ')}` : '' }} · 合并 {{ chunk.score.toFixed(4) }}<template v-if="chunk.vectorScore !== undefined"> · 向量 {{ chunk.vectorScore.toFixed(3) }}</template><template v-if="chunk.keywordScore !== undefined"> · 关键词 {{ chunk.keywordScore.toFixed(2) }}</template><template v-if="chunk.rerankScore !== undefined"> · 重排 {{ chunk.rerankScore.toFixed(3) }}</template></small><p>{{ chunk.excerpt }}</p></article></div></details><footer><button class="secondary-button" @click="selectedChatLog = null">关闭</button></footer></section></div>
    <div v-if="knowledgeBaseDialogOpen" class="modal-backdrop" @click.self="knowledgeBaseDialogOpen = false"><section class="dialog knowledge-base-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-base-dialog-title"><header><div><p class="eyebrow">KNOWLEDGE BASE</p><h2 id="knowledge-base-dialog-title">{{ editingKnowledgeBaseId ? '编辑知识库' : '新建知识库' }}</h2></div><button class="close-button" aria-label="关闭" @click="knowledgeBaseDialogOpen = false">×</button></header><form @submit.prevent="saveKnowledgeBase"><label>名称<input v-model="knowledgeBaseForm.name" required maxlength="100" placeholder="例如：产品帮助中心" /></label><label>描述<input v-model="knowledgeBaseForm.description" maxlength="500" placeholder="知识库的内容范围" /></label><div class="form-grid"><label>召回数量<input v-model.number="knowledgeBaseForm.topK" type="number" min="1" max="100" required /></label><label>相似度阈值<input v-model.number="knowledgeBaseForm.similarityThreshold" type="number" min="0" max="1" step="0.01" required /></label><label>最大上下文长度<input v-model.number="knowledgeBaseForm.maxContextLength" type="number" min="256" step="256" required /></label><label>模型<input v-model="knowledgeBaseForm.model" required maxlength="100" /></label></div><label class="toggle-field"><input v-model="knowledgeBaseForm.rerankEnabled" type="checkbox" />启用重排序</label><label>回答提示词<textarea v-model="knowledgeBaseForm.prompt" rows="5" maxlength="10000" /></label><footer><button type="button" class="secondary-button" @click="knowledgeBaseDialogOpen = false">取消</button><button type="submit" class="primary-button">保存配置</button></footer></form></section></div>
    <div v-if="modelProviderDialogOpen" class="modal-backdrop" @click.self="modelProviderDialogOpen = false"><section class="dialog model-provider-dialog" role="dialog" aria-modal="true" aria-labelledby="model-provider-dialog-title"><header><div><p class="eyebrow">MODEL PROVIDER</p><h2 id="model-provider-dialog-title">{{ editingModelProviderId ? '编辑供应商' : '添加供应商' }}</h2></div><button class="close-button" aria-label="关闭" @click="modelProviderDialogOpen = false">×</button></header><form @submit.prevent="saveModelProvider"><label>配置名称<input v-model="modelProviderForm.name" required maxlength="100" placeholder="例如：生产 Chat 模型" /></label><div class="form-grid"><label>供应商<input v-model="modelProviderForm.provider" required maxlength="100" placeholder="OpenAI 兼容" /></label><label>API 地址<input v-model="modelProviderForm.baseUrl" type="url" placeholder="例如 https://api.openai.com/v1" /></label><label>Chat 模型<input v-model="modelProviderForm.chatModel" required maxlength="150" placeholder="模型标识" /></label><label>Embedding 模型<input v-model="modelProviderForm.embeddingModel" maxlength="150" placeholder="向量化时必填" /></label><label>Rerank 模型<input v-model="modelProviderForm.rerankModel" maxlength="150" placeholder="可选" /></label><label>温度<input v-model.number="modelProviderForm.temperature" type="number" min="0" max="2" step="0.1" required /></label><label>最大 Token<input v-model.number="modelProviderForm.maxTokens" type="number" min="1" max="32768" step="1" required /></label><label>密钥环境变量<input v-model="modelProviderForm.credentialEnv" required pattern="[A-Z][A-Z0-9_]*" placeholder="例如 OPENAI_API_KEY" /></label></div><label class="toggle-field"><input v-model="modelProviderForm.enabled" type="checkbox" />启用此配置</label><label class="toggle-field"><input v-model="modelProviderForm.isDefault" type="checkbox" />设为默认供应商</label><p class="model-provider-note">请在 API 和 Worker 环境中设置对应密钥及 DATABASE_URL；密钥值不会保存在此处。API 地址填写 OpenAI 兼容的基础路径，系统会追加 /embeddings、/chat/completions 或 /rerank。</p><footer><button type="button" class="secondary-button" @click="modelProviderDialogOpen = false">取消</button><button type="submit" class="primary-button">保存配置</button></footer></form></section></div>
  </div>
</template>
