<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Plus } from "@lucide/vue";
import type { ModelProviderRecord, ModelSettingsResponse, SaveModelProviderRequest } from "@nyz-rag/types";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import ModelProviderDialog from "../components/model-providers/ModelProviderDialog.vue";
import ModelSettingDialog from "../components/model-providers/ModelSettingDialog.vue";
import { capabilities, type Capability } from "../components/model-providers/capabilities";
import { usePending } from "../composables/usePending";
import { can, client, errorMessage, refreshAfterWrite } from "../workspace";

type ModelProvider = ModelProviderRecord;
const json = { "content-type": "application/json" };

const providers = ref<ModelProvider[]>([]);
const settings = ref<ModelSettingsResponse>({ chat: null, embedding: null, rerank: null, review: null, rewrite: null });

// 只采用最近一次读取的结果（写入后的刷新可能与上一次刷新交错）。
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const data = await Promise.all([
    client.request<ModelProvider[]>("/api/admin/model-providers"),
    client.request<ModelSettingsResponse>("/api/admin/model-settings"),
  ]);
  if (seq === loadSeq) [providers.value, settings.value] = data;
}
onMounted(() => load().catch(() => { toast.error("模型配置加载失败，请检查 API 服务"); }));
const refresh = () => refreshAfterWrite(load);
// 同一供应商或业务模型的写操作完成前不再重复提交。
const { isPending, run } = usePending();

const providerById = (id: string) => providers.value.find((provider) => provider.id === id);
const usedBy = (provider: ModelProvider) => capabilities.filter((capability) => settings.value[capability.id]?.providerId === provider.id).map((capability) => capability.label);

// ---- 业务模型 ----

const settingOpen = ref(false);
const settingCapability = ref<Capability>(capabilities[0]);
const enabledProviders = computed(() => providers.value.filter((provider) => provider.enabled));

function editSetting(capability: Capability) {
  settingCapability.value = capability;
  settingOpen.value = true;
}

async function clearSetting(capability: Capability) {
  const key = `setting:${capability.id}`;
  if (isPending(key) || !await confirm({ title: `清除 ${capability.label} 模型`, description: `清除后将不再使用 ${capability.label} 模型（${capability.description}）。确定清除？`, confirmText: "清除", destructive: true })) return;
  await run(key, async () => {
    try {
      await client.request(`/api/admin/model-settings/${capability.id}`, { method: "DELETE" });
    } catch (err) {
      toast.error(errorMessage(err, "清除失败"));
      return;
    }
    toast.success(`${capability.label} 模型已清除`);
    await refresh();
  });
}

// ---- 供应商 ----

const providerOpen = ref(false);
const editing = ref<ModelProvider | null>(null);

function editProvider(provider?: ModelProvider) {
  editing.value = provider ?? null;
  providerOpen.value = true;
}

async function toggle(provider: ModelProvider) {
  if (isPending(provider.id)) return;
  const used = usedBy(provider);
  if (provider.enabled && used.length
    && !await confirm({ title: "停用供应商", description: `该供应商正用于 ${used.join("、")} 模型，停用后这些用途将不可用。确定停用？`, confirmText: "停用", destructive: true })) return;
  const { name, provider: kind, baseUrl, credentialEnv } = provider;
  await run(provider.id, async () => {
    try {
      await client.request(`/api/admin/model-providers/${provider.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ name, provider: kind, baseUrl, credentialEnv, enabled: !provider.enabled } satisfies SaveModelProviderRequest) });
    } catch (err) {
      toast.error(errorMessage(err, "供应商状态更新失败"));
      return;
    }
    toast.success(provider.enabled ? "供应商已停用" : "供应商已启用");
    await refresh();
  });
}

async function remove(provider: ModelProvider) {
  if (isPending(provider.id) || !await confirm({ title: "删除供应商", description: `确定删除供应商“${provider.name}”？`, confirmText: "删除", destructive: true })) return;
  await run(provider.id, async () => {
    try {
      await client.request(`/api/admin/model-providers/${provider.id}`, { method: "DELETE" });
    } catch (err) {
      toast.error(errorMessage(err, "供应商删除失败"));
      return;
    }
    toast.success("供应商已删除");
    await refresh();
  });
}

const credentialLabel = (provider: ModelProvider) => provider.hasApiKey ? "已保存" : provider.credentialEnv ? `环境变量 ${provider.credentialEnv}` : "无需密钥";
</script>

<template>
  <PageHeading eyebrow="MODEL PROVIDERS" title="模型配置" subtitle="供应商提供连接，业务模型选择各用途使用的模型">
    <Button v-if="can('models:manage')" @click="editProvider()"><Plus /> 添加供应商</Button>
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
            <span v-if="capability.generative" class="text-xs text-muted-foreground">温度 {{ settings[capability.id]!.temperature }} · 最大输出 {{ settings[capability.id]!.maxTokens }} Token</span>
          </template>
          <Badge v-else variant="muted">未配置</Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">{{ capability.description }}</p>
      </div>
      <div v-if="can('models:manage')" class="flex flex-wrap gap-1.5">
        <Button variant="outline" :disabled="!enabledProviders.length" @click="editSetting(capability)">{{ settings[capability.id] ? '更换' : '设置' }}</Button>
        <Button v-if="settings[capability.id]" variant="outline" class="text-destructive hover:text-destructive" :disabled="isPending(`setting:${capability.id}`)" @click="clearSetting(capability)">清除</Button>
      </div>
    </article>
    <p v-if="!enabledProviders.length && can('models:manage')" class="border-t px-5 py-3 text-xs text-muted-foreground">请先在下方添加并启用供应商。</p>
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
          <div class="grid min-w-22 gap-1"><dt class="text-xs text-muted-foreground">API 密钥</dt><dd class="font-mono text-xs break-words">{{ credentialLabel(provider) }}</dd></div>
        </dl>
      </div>
      <div v-if="can('models:manage')" class="flex flex-wrap gap-1.5">
        <Button variant="outline" :disabled="isPending(provider.id)" @click="editProvider(provider)">编辑</Button>
        <Button variant="outline" :disabled="isPending(provider.id)" @click="toggle(provider)">{{ provider.enabled ? '停用' : '启用' }}</Button>
        <Button variant="outline" class="text-destructive hover:text-destructive" :disabled="usedBy(provider).length > 0 || isPending(provider.id)" :title="usedBy(provider).length ? '正在被业务模型使用，请先更换' : undefined" @click="remove(provider)">删除</Button>
      </div>
    </article>
    <EmptyState v-if="!providers.length" class="border-t">尚未配置模型供应商 <Button v-if="can('models:manage')" variant="link" size="sm" class="text-link" @click="editProvider()">添加第一个供应商</Button></EmptyState>
    <p class="border-t px-5 py-4 text-xs leading-relaxed text-muted-foreground">供应商只保存服务地址和 API Key（加密保存，需在 API 与 Worker 环境配置 NYZ_SECRET_KEY）。系统会在 API 地址后追加 /embeddings、/chat/completions、/rerank 或 /models。</p>
  </Card>

  <ModelSettingDialog v-model:open="settingOpen" :capability="settingCapability" :setting="settings[settingCapability.id]" :providers="providers" :refresh="refresh" />
  <ModelProviderDialog v-model:open="providerOpen" :provider="editing" :refresh="refresh" />
</template>
