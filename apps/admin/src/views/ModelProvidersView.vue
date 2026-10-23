<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { LoaderCircle, Plus, RefreshCw } from "@lucide/vue";
import type { ListProviderModelsResponse, ModelCapability, ModelProviderRecord, ModelSettingRecord, ModelSettingsResponse } from "@nyz-rag/types";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Switch } from "@nyz-rag/ui/components/switch";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { client, errorMessage } from "../workspace";

type ModelProvider = ModelProviderRecord;
const json = { "content-type": "application/json" };

// 常用 OpenAI 兼容服务：选择后填入供应商名称与基础地址。Worker/API 在容器中运行时，本机 Ollama 地址需改为 host.docker.internal。
const presets = [
  { id: "siliconflow", label: "硅基流动", provider: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openai", label: "OpenAI", provider: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "ollama", label: "本地 Ollama", provider: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "custom", label: "其他 OpenAI 兼容服务", provider: "OpenAI 兼容", baseUrl: "" },
];

// 业务模型的用途；按模型名称粗分候选，分不出时给出全部，仍可手动输入任意模型名。
const capabilities: Array<{ id: ModelCapability; label: string; description: string; placeholder: string; pattern: RegExp; exclude?: RegExp }> = [
  { id: "chat", label: "Chat", description: "问答生成；未配置或调用失败时摘录原文片段", placeholder: "例如 deepseek-ai/DeepSeek-V3", pattern: /./, exclude: /embed|bge|m3e|bce|rerank/i },
  { id: "embedding", label: "Embedding", description: "文档向量化与向量检索；配置后新文档切片完成即自动向量化", placeholder: "例如 BAAI/bge-m3", pattern: /embed|bge|m3e|bce/i, exclude: /rerank/i },
  { id: "rerank", label: "Rerank", description: "重排序；知识库开启重排序时使用", placeholder: "例如 BAAI/bge-reranker-v2-m3", pattern: /rerank/i },
];
type Capability = (typeof capabilities)[number];

const providers = ref<ModelProvider[]>([]);
const settings = ref<ModelSettingsResponse>({ chat: null, embedding: null, rerank: null });

async function load() {
  try {
    [providers.value, settings.value] = await Promise.all([
      client.request<ModelProvider[]>("/api/admin/model-providers"),
      client.request<ModelSettingsResponse>("/api/admin/model-settings"),
    ]);
  } catch {
    toast.error("模型配置加载失败，请检查 API 服务");
  }
}
onMounted(load);

const providerById = (id: string) => providers.value.find((provider) => provider.id === id);
const usedBy = (provider: ModelProvider) => capabilities.filter((capability) => settings.value[capability.id]?.providerId === provider.id).map((capability) => capability.label);

// ---- 业务模型 ----

const settingOpen = ref(false);
const settingCapability = ref<Capability>(capabilities[0]);
const settingForm = ref({ providerId: "", model: "", temperature: 0.3, maxTokens: 1024 });
const models = ref<string[]>([]);
const loadingModels = ref(false);
const enabledProviders = computed(() => providers.value.filter((provider) => provider.enabled));
const modelCandidates = computed(() => {
  const { pattern, exclude } = settingCapability.value;
  const matched = models.value.filter((model) => pattern.test(model) && !exclude?.test(model));
  return matched.length ? matched : models.value;
});
// 输入内容筛选候选；输入恰好是某个候选（如打开已有配置）时列出全部，便于更换。
const visibleModels = computed(() => {
  const query = settingForm.value.model.trim().toLowerCase();
  if (!query || modelCandidates.value.some((model) => model.toLowerCase() === query)) return modelCandidates.value;
  return modelCandidates.value.filter((model) => model.toLowerCase().includes(query));
});

async function loadModels() {
  const { providerId } = settingForm.value;
  models.value = [];
  if (!providerId) return;
  loadingModels.value = true;
  try {
    const listed = (await client.request<ListProviderModelsResponse>(`/api/admin/model-providers/${providerId}/models`)).models;
    // 加载期间切换了供应商时丢弃旧结果。
    if (settingForm.value.providerId !== providerId) return;
    models.value = listed;
    if (!listed.length) toast.info("供应商没有返回可用模型，可以直接输入模型名");
  } catch (err) {
    toast.error(errorMessage(err, "获取模型列表失败，可以直接输入模型名"));
  } finally {
    loadingModels.value = false;
  }
}

function editSetting(capability: Capability) {
  const current = settings.value[capability.id];
  settingCapability.value = capability;
  const providerId = current && providerById(current.providerId)?.enabled ? current.providerId : enabledProviders.value[0]?.id ?? "";
  settingForm.value = { providerId, model: current?.model ?? "", temperature: current?.temperature ?? 0.3, maxTokens: current?.maxTokens ?? 1024 };
  settingOpen.value = true;
  void loadModels();
}

function selectProvider(id: unknown) {
  settingForm.value.providerId = String(id);
  void loadModels();
}

async function saveSetting() {
  const capability = settingCapability.value;
  const { providerId, model, temperature, maxTokens } = settingForm.value;
  const previous = settings.value[capability.id];
  if (capability.id === "embedding" && previous && previous.model !== model.trim()
    && !await confirm({ title: "更换 Embedding 模型", description: "更换后，已向量化的文档需要重新向量化；在此之前向量检索只会使用同一模型的文档。确定更换？", confirmText: "更换" })) return;
  const body = { providerId, model: model.trim(), ...(capability.id === "chat" ? { temperature, maxTokens } : {}) };
  try {
    await client.request<ModelSettingRecord>(`/api/admin/model-settings/${capability.id}`, { method: "PUT", headers: json, body: JSON.stringify(body) });
    await load();
    settingOpen.value = false;
    toast.success(`${capability.label} 模型已保存`);
  } catch (err) {
    toast.error(errorMessage(err, "模型保存失败"));
  }
}

async function clearSetting(capability: Capability) {
  if (!await confirm({ title: `清除 ${capability.label} 模型`, description: `清除后将不再使用 ${capability.label} 模型（${capability.description}）。确定清除？`, confirmText: "清除", destructive: true })) return;
  try {
    await client.request(`/api/admin/model-settings/${capability.id}`, { method: "DELETE" });
    await load();
    toast.success(`${capability.label} 模型已清除`);
  } catch (err) {
    toast.error(errorMessage(err, "清除失败"));
  }
}

// ---- 供应商 ----

const emptyForm = () => ({ name: "", provider: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", credentialEnv: "", apiKey: "", clearApiKey: false, enabled: true });
const providerOpen = ref(false);
const editing = ref<ModelProvider | null>(null);
const form = ref(emptyForm());
const preset = ref("siliconflow");
const testing = ref(false);

function editProvider(provider?: ModelProvider) {
  editing.value = provider ?? null;
  form.value = provider
    ? { name: provider.name, provider: provider.provider, baseUrl: provider.baseUrl, credentialEnv: provider.credentialEnv, apiKey: "", clearApiKey: false, enabled: provider.enabled }
    : emptyForm();
  preset.value = presets.find((item) => item.baseUrl && item.baseUrl === form.value.baseUrl)?.id ?? "custom";
  providerOpen.value = true;
}

function applyPreset(id: unknown) {
  const item = presets.find((entry) => entry.id === id);
  if (!item) return;
  preset.value = item.id;
  form.value.provider = item.provider;
  form.value.baseUrl = item.baseUrl;
}

// 测试连接：用表单中的地址与密钥读取模型列表（未填写新 Key 时使用已保存的密钥）。
async function testConnection() {
  testing.value = true;
  try {
    const { name, provider, baseUrl, apiKey, credentialEnv } = form.value;
    const body = { name, provider, baseUrl, ...(apiKey.trim() ? { apiKey } : {}), ...(editing.value && !form.value.clearApiKey ? { providerId: editing.value.id } : {}), ...(credentialEnv ? { credentialEnv } : {}) };
    const { models: listed } = await client.request<ListProviderModelsResponse>("/api/admin/model-providers/models", { method: "POST", headers: json, body: JSON.stringify(body) });
    toast.success(listed.length ? `连接成功，可用模型 ${listed.length} 个` : "连接成功，但供应商没有返回模型列表");
  } catch (err) {
    toast.error(errorMessage(err, "连接失败"));
  } finally {
    testing.value = false;
  }
}

async function saveProvider() {
  const target = editing.value;
  const { apiKey, clearApiKey, ...rest } = form.value;
  const body = { ...rest, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : clearApiKey ? { clearApiKey: true } : {}) };
  try {
    await client.request(`/api/admin/model-providers${target ? `/${target.id}` : ""}`, { method: target ? "PATCH" : "POST", headers: json, body: JSON.stringify(body) });
    await load();
    providerOpen.value = false;
    toast.success(target ? "供应商已更新" : "供应商已添加");
  } catch (err) {
    toast.error(errorMessage(err, "供应商保存失败，请检查 API 服务"));
  }
}

async function toggle(provider: ModelProvider) {
  const used = usedBy(provider);
  if (provider.enabled && used.length
    && !await confirm({ title: "停用供应商", description: `该供应商正用于 ${used.join("、")} 模型，停用后这些用途将不可用。确定停用？`, confirmText: "停用", destructive: true })) return;
  const { name, provider: kind, baseUrl, credentialEnv } = provider;
  try {
    await client.request(`/api/admin/model-providers/${provider.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name, provider: kind, baseUrl, credentialEnv, enabled: !provider.enabled }) });
    await load();
    toast.success(provider.enabled ? "供应商已停用" : "供应商已启用");
  } catch (err) {
    toast.error(errorMessage(err, "供应商状态更新失败"));
  }
}

async function remove(provider: ModelProvider) {
  if (!await confirm({ title: "删除供应商", description: `确定删除供应商“${provider.name}”？`, confirmText: "删除", destructive: true })) return;
  try {
    await client.request(`/api/admin/model-providers/${provider.id}`, { method: "DELETE" });
    await load();
    toast.success("供应商已删除");
  } catch (err) {
    toast.error(errorMessage(err, "供应商删除失败"));
  }
}

const credentialLabel = (provider: ModelProvider) => provider.hasApiKey ? "已保存" : provider.credentialEnv ? `环境变量 ${provider.credentialEnv}` : "无需密钥";
</script>

<template>
  <PageHeading eyebrow="MODEL PROVIDERS" title="模型配置" subtitle="供应商提供连接，业务模型选择各用途使用的模型">
    <Button @click="editProvider()"><Plus /> 添加供应商</Button>
  </PageHeading>

  <Card class="mb-5 gap-0 py-0">
    <div class="px-5 py-4"><h2 class="text-sm font-semibold">业务模型</h2><p class="mt-1 text-xs text-muted-foreground">每项用途选择一个供应商与模型，可以来自不同供应商</p></div>
    <article v-for="capability in capabilities" :key="capability.id" class="flex flex-wrap items-center justify-between gap-4 border-t px-5 py-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-sm font-semibold">{{ capability.label }}</h3>
          <template v-if="settings[capability.id]">
            <span class="font-mono text-xs break-all">{{ settings[capability.id]!.model }}</span>
            <Badge variant="muted">{{ providerById(settings[capability.id]!.providerId)?.name ?? '未知供应商' }}</Badge>
            <Badge v-if="providerById(settings[capability.id]!.providerId)?.enabled === false" variant="destructive">供应商已停用</Badge>
            <span v-if="capability.id === 'chat'" class="text-xs text-muted-foreground">温度 {{ settings.chat!.temperature }} · 最大输出 {{ settings.chat!.maxTokens }} Token</span>
          </template>
          <Badge v-else variant="muted">未配置</Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">{{ capability.description }}</p>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <Button variant="outline" :disabled="!enabledProviders.length" @click="editSetting(capability)">{{ settings[capability.id] ? '更换' : '设置' }}</Button>
        <Button v-if="settings[capability.id]" variant="outline" class="text-destructive hover:text-destructive" @click="clearSetting(capability)">清除</Button>
      </div>
    </article>
    <p v-if="!enabledProviders.length" class="border-t px-5 py-3 text-xs text-muted-foreground">请先在下方添加并启用供应商。</p>
  </Card>

  <Card class="min-h-60 gap-0 py-0">
    <div class="px-5 py-4"><h2 class="text-sm font-semibold">供应商</h2><p class="mt-1 text-xs text-muted-foreground">{{ providers.length }} 个配置</p></div>
    <article v-for="provider in providers" :key="provider.id" class="flex flex-wrap items-start justify-between gap-5 border-t p-5">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="text-sm font-semibold">{{ provider.name }}</h3>
          <StatusBadge :on="provider.enabled">{{ provider.enabled ? '已启用' : '已停用' }}</StatusBadge>
          <Badge v-for="label in usedBy(provider)" :key="label" variant="brand">用于 {{ label }}</Badge>
        </div>
        <p class="mt-1.5 mb-4 text-xs break-words text-muted-foreground">{{ provider.provider }}<span v-if="provider.baseUrl"> · {{ provider.baseUrl }}</span></p>
        <dl class="flex flex-wrap gap-5">
          <div class="grid min-w-22 gap-1"><dt class="text-[11px] text-muted-foreground">API 密钥</dt><dd class="font-mono text-xs break-words">{{ credentialLabel(provider) }}</dd></div>
        </dl>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <Button variant="outline" @click="editProvider(provider)">编辑</Button>
        <Button variant="outline" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</Button>
        <Button variant="outline" class="text-destructive hover:text-destructive" :disabled="usedBy(provider).length > 0" :title="usedBy(provider).length ? '正在被业务模型使用，请先更换' : undefined" @click="remove(provider)">删除</Button>
      </div>
    </article>
    <EmptyState v-if="!providers.length" class="border-t">尚未配置模型供应商 <Button variant="link" size="sm" class="text-link" @click="editProvider()">添加第一个供应商</Button></EmptyState>
    <p class="border-t px-5 py-4 text-xs leading-relaxed text-muted-foreground">供应商只保存服务地址和 API Key（加密保存，需在 API 与 Worker 环境配置 NYZ_SECRET_KEY）。系统会在 API 地址后追加 /embeddings、/chat/completions、/rerank 或 /models。</p>
  </Card>

  <Dialog v-model:open="settingOpen">
    <DialogContent class="sm:max-w-lg" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">MODEL SETTING</p>
        <DialogTitle>{{ settingCapability.label }} 模型</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="saveSetting">
        <p class="text-xs text-muted-foreground">{{ settingCapability.description }}</p>
        <div class="grid gap-2">
          <Label for="ms-provider">供应商</Label>
          <Select :model-value="settingForm.providerId" @update:model-value="selectProvider">
            <SelectTrigger id="ms-provider" class="w-full"><SelectValue placeholder="选择供应商" /></SelectTrigger>
            <SelectContent><SelectItem v-for="provider in enabledProviders" :key="provider.id" :value="provider.id">{{ provider.name }}</SelectItem></SelectContent>
          </Select>
        </div>
        <div class="grid gap-2">
          <div class="flex items-center justify-between gap-2">
            <Label for="ms-model">模型</Label>
            <Button type="button" variant="ghost" size="sm" :disabled="loadingModels || !settingForm.providerId" @click="loadModels"><LoaderCircle v-if="loadingModels" class="animate-spin" /><RefreshCw v-else />刷新列表</Button>
          </div>
          <Input id="ms-model" v-model="settingForm.model" required maxlength="200" autocomplete="off" :placeholder="settingCapability.placeholder" />
          <p class="text-xs text-muted-foreground">{{ loadingModels ? '正在获取模型列表…' : models.length ? `直接输入模型名，或从供应商的 ${modelCandidates.length} 个模型中选择（输入可筛选）` : '直接输入模型名' }}</p>
          <div v-if="visibleModels.length" role="listbox" aria-label="供应商模型" class="max-h-48 overflow-y-auto rounded-md border p-1">
            <button v-for="model in visibleModels" :key="model" type="button" role="option" :aria-selected="model === settingForm.model.trim()"
              class="block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
              :class="model === settingForm.model.trim() ? 'bg-accent font-medium text-accent-foreground' : ''" :title="model" @click="settingForm.model = model">{{ model }}</button>
          </div>
          <p v-else-if="modelCandidates.length" class="text-xs text-muted-foreground">没有匹配的模型，将使用输入的模型名</p>
        </div>
        <div v-if="settingCapability.id === 'chat'" class="grid grid-cols-2 gap-3">
          <div class="grid gap-2"><Label for="ms-temperature">温度</Label><Input id="ms-temperature" v-model.number="settingForm.temperature" type="number" min="0" max="2" step="0.1" required /></div>
          <div class="grid gap-2"><Label for="ms-max-tokens">最大输出 Token</Label><Input id="ms-max-tokens" v-model.number="settingForm.maxTokens" type="number" min="1" max="1048576" step="1" required /></div>
          <p class="col-span-2 text-xs leading-relaxed text-muted-foreground">最大输出 Token 是单次回答的长度上限（max_tokens），不是上下文窗口；不要超过模型的最大输出长度，否则调用会失败并退回原文摘录。问答回答一般 1024～4096 足够。</p>
        </div>
        <p v-if="settingCapability.id === 'embedding'" class="text-xs leading-relaxed text-muted-foreground">更换 Embedding 模型后，已向量化的文档需要重新向量化。</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="settingOpen = false">取消</Button>
          <Button type="submit" :disabled="!settingForm.providerId || !settingForm.model.trim()">保存</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="providerOpen">
    <DialogContent class="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">MODEL PROVIDER</p>
        <DialogTitle>{{ editing ? '编辑供应商' : '添加供应商' }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="saveProvider">
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-2"><Label for="mp-name">配置名称</Label><Input id="mp-name" v-model="form.name" required maxlength="100" placeholder="例如：硅基流动" /></div>
          <div class="grid gap-2">
            <Label for="mp-preset">服务类型</Label>
            <Select :model-value="preset" @update:model-value="applyPreset"><SelectTrigger id="mp-preset" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="item in presets" :key="item.id" :value="item.id">{{ item.label }}</SelectItem></SelectContent></Select>
          </div>
          <div class="grid gap-2 sm:col-span-2"><Label for="mp-base-url">API 地址</Label><Input id="mp-base-url" v-model="form.baseUrl" type="url" placeholder="OpenAI 兼容的基础路径，例如 https://api.siliconflow.cn/v1" /></div>
          <div class="grid gap-2 sm:col-span-2">
            <Label for="mp-api-key">API Key</Label>
            <Input id="mp-api-key" v-model="form.apiKey" type="password" autocomplete="new-password" maxlength="4096" :placeholder="editing?.hasApiKey ? '已保存，留空保持不变' : '本地模型可不填'" />
            <Label v-if="editing?.hasApiKey" class="text-xs font-normal text-muted-foreground"><Switch v-model="form.clearApiKey" :disabled="Boolean(form.apiKey)" />清除已保存的密钥</Label>
          </div>
        </div>
        <div class="flex items-center justify-between gap-3 rounded-md bg-secondary px-3 py-2">
          <p class="text-xs text-secondary-foreground">填写地址和 Key 后可以测试连接；具体模型在「业务模型」中选择</p>
          <Button type="button" variant="outline" size="sm" :disabled="testing" @click="testConnection"><LoaderCircle v-if="testing" class="animate-spin" /><RefreshCw v-else />测试连接</Button>
        </div>
        <Label class="font-normal"><Switch v-model="form.enabled" />启用此供应商</Label>
        <details class="text-xs text-muted-foreground">
          <summary class="cursor-pointer select-none">高级：从环境变量读取密钥</summary>
          <div class="mt-2 grid gap-2">
            <Label for="mp-credential" class="text-xs">密钥环境变量</Label>
            <Input id="mp-credential" v-model="form.credentialEnv" pattern="[A-Z][A-Z0-9_]*" placeholder="例如 OPENAI_API_KEY，未保存 API Key 时使用" />
          </div>
        </details>
        <DialogFooter>
          <Button type="button" variant="outline" @click="providerOpen = false">取消</Button>
          <Button type="submit">保存供应商</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
