<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Plus } from "@lucide/vue";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Switch } from "@nyz-rag/ui/components/switch";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { client, errorMessage } from "../workspace";

type ModelProvider = { id: string; name: string; provider: string; baseUrl: string; chatModel: string; embeddingModel: string; rerankModel: string; temperature: number; maxTokens: number; credentialEnv: string; enabled: boolean; isDefault: boolean; createdAt: string; updatedAt: string };

const emptyForm = () => ({ name: "", provider: "OpenAI 兼容", baseUrl: "", chatModel: "", embeddingModel: "", rerankModel: "", temperature: 0.3, maxTokens: 1024, credentialEnv: "OPENAI_API_KEY", enabled: false, isDefault: false });
const providers = ref<ModelProvider[]>([]);
const dialogOpen = ref(false);
const editingId = ref("");
const form = ref(emptyForm());

async function loadModelProviders() {
  try {
    providers.value = await client.request<ModelProvider[]>("/api/admin/model-providers");
  } catch {
    toast.error("模型配置加载失败，请检查 API 服务");
  }
}
onMounted(loadModelProviders);

function edit(provider?: ModelProvider) {
  editingId.value = provider?.id ?? "";
  form.value = provider ? { name: provider.name, provider: provider.provider, baseUrl: provider.baseUrl, chatModel: provider.chatModel, embeddingModel: provider.embeddingModel, rerankModel: provider.rerankModel, temperature: provider.temperature, maxTokens: provider.maxTokens, credentialEnv: provider.credentialEnv, enabled: provider.enabled, isDefault: provider.isDefault } : emptyForm();
  dialogOpen.value = true;
}

async function save() {
  const editing = Boolean(editingId.value);
  try {
    await client.request(`/api/admin/model-providers${editing ? `/${editingId.value}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form.value) });
    await loadModelProviders();
    dialogOpen.value = false;
    toast.success(editing ? "模型配置已更新" : "模型配置已添加");
  } catch (err) {
    toast.error(errorMessage(err, "模型配置保存失败，请检查 API 服务"));
  }
}

async function toggle(provider: ModelProvider) {
  const { id, createdAt: _createdAt, updatedAt: _updatedAt, ...configuration } = provider;
  try {
    await client.request(`/api/admin/model-providers/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...configuration, enabled: !provider.enabled }) });
    await loadModelProviders();
    toast.success(provider.enabled ? "模型配置已停用" : "模型配置已启用");
  } catch {
    toast.error("模型状态更新失败");
  }
}

async function remove(provider: ModelProvider) {
  if (!await confirm({ title: "删除模型配置", description: `确定删除模型配置“${provider.name}”？`, confirmText: "删除", destructive: true })) return;
  try {
    await client.request(`/api/admin/model-providers/${provider.id}`, { method: "DELETE" });
    await loadModelProviders();
    toast.success("模型配置已删除");
  } catch {
    toast.error("模型配置删除失败");
  }
}
</script>

<template>
  <PageHeading eyebrow="MODEL PROVIDERS" title="模型配置" subtitle="管理 Chat、Embedding 与 Rerank 模型供应商">
    <Button @click="edit()"><Plus /> 添加供应商</Button>
  </PageHeading>
  <Card class="min-h-72 gap-0 py-0">
    <div class="px-5 py-4"><h2 class="text-sm font-semibold">供应商</h2><p class="mt-1 text-xs text-muted-foreground">{{ providers.length }} 个配置</p></div>
    <article v-for="provider in providers" :key="provider.id" class="flex flex-wrap items-start justify-between gap-5 border-t p-5">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-3">
          <h3 class="text-sm font-semibold">{{ provider.name }}</h3>
          <StatusBadge :on="provider.enabled">{{ provider.enabled ? '已启用' : '已停用' }}</StatusBadge>
          <Badge v-if="provider.isDefault" variant="brand">默认</Badge>
        </div>
        <p class="mt-1.5 mb-4 text-xs break-words text-muted-foreground">{{ provider.provider }}<span v-if="provider.baseUrl"> · {{ provider.baseUrl }}</span></p>
        <dl class="flex flex-wrap gap-5">
          <div v-for="[label, value] in [['Chat', provider.chatModel], ['Embedding', provider.embeddingModel || '未配置'], ['Rerank', provider.rerankModel || '未配置'], ['温度 / 最大 Token', `${provider.temperature} / ${provider.maxTokens}`], ['密钥环境变量', provider.credentialEnv]]" :key="label" class="grid min-w-22 gap-1">
            <dt class="text-[11px] text-muted-foreground">{{ label }}</dt><dd class="font-mono text-xs break-words">{{ value }}</dd>
          </div>
        </dl>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <Button variant="outline" @click="edit(provider)">编辑</Button>
        <Button variant="outline" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</Button>
        <Button variant="outline" class="text-destructive hover:text-destructive" @click="remove(provider)">删除</Button>
      </div>
    </article>
    <EmptyState v-if="!providers.length" class="border-t">尚未配置模型供应商 <Button variant="link" size="sm" class="text-link" @click="edit()">添加第一个供应商</Button></EmptyState>
    <p class="border-t px-5 py-4 text-xs leading-relaxed text-muted-foreground">启用默认供应商并填写 Embedding 模型后，新文档会在切片后自动向量化，已收录文档可在文档管理中手动向量化或重试。问答使用默认供应商的 Chat 模型生成回答（未配置或调用失败时摘录原文片段）；知识库开启重排序且填写 Rerank 模型时，召回结果会经过重排序。</p>
  </Card>

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">MODEL PROVIDER</p>
        <DialogTitle>{{ editingId ? '编辑供应商' : '添加供应商' }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <div class="grid gap-2"><Label for="mp-name">配置名称</Label><Input id="mp-name" v-model="form.name" required maxlength="100" placeholder="例如：生产 Chat 模型" /></div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="grid gap-2"><Label for="mp-provider">供应商</Label><Input id="mp-provider" v-model="form.provider" required maxlength="100" placeholder="OpenAI 兼容" /></div>
          <div class="grid gap-2"><Label for="mp-base-url">API 地址</Label><Input id="mp-base-url" v-model="form.baseUrl" type="url" placeholder="例如 https://api.openai.com/v1" /></div>
          <div class="grid gap-2"><Label for="mp-chat">Chat 模型</Label><Input id="mp-chat" v-model="form.chatModel" required maxlength="150" placeholder="模型标识" /></div>
          <div class="grid gap-2"><Label for="mp-embedding">Embedding 模型</Label><Input id="mp-embedding" v-model="form.embeddingModel" maxlength="150" placeholder="向量化时必填" /></div>
          <div class="grid gap-2"><Label for="mp-rerank">Rerank 模型</Label><Input id="mp-rerank" v-model="form.rerankModel" maxlength="150" placeholder="可选" /></div>
          <div class="grid gap-2"><Label for="mp-temperature">温度</Label><Input id="mp-temperature" v-model.number="form.temperature" type="number" min="0" max="2" step="0.1" required /></div>
          <div class="grid gap-2"><Label for="mp-max-tokens">最大 Token</Label><Input id="mp-max-tokens" v-model.number="form.maxTokens" type="number" min="1" max="32768" step="1" required /></div>
          <div class="grid gap-2"><Label for="mp-credential">密钥环境变量</Label><Input id="mp-credential" v-model="form.credentialEnv" required pattern="[A-Z][A-Z0-9_]*" placeholder="例如 OPENAI_API_KEY" /></div>
        </div>
        <Label class="font-normal"><Switch v-model="form.enabled" />启用此配置</Label>
        <Label class="font-normal"><Switch v-model="form.isDefault" />设为默认供应商</Label>
        <p class="text-xs leading-relaxed text-muted-foreground">请在 API 和 Worker 环境中设置对应密钥及 DATABASE_URL；密钥值不会保存在此处。API 地址填写 OpenAI 兼容的基础路径，系统会追加 /embeddings、/chat/completions 或 /rerank。</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="dialogOpen = false">取消</Button>
          <Button type="submit">保存配置</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
