<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import type { ListProviderModelsResponse, ModelProviderRecord, ModelSettingRecord, SaveModelSettingRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { toast } from "@nyz-rag/ui/lib/toast";
import { client, errorMessage } from "../../workspace";
import type { Capability } from "./capabilities";

const props = defineProps<{
  capability: Capability;
  setting: ModelSettingRecord | null;
  providers: ModelProviderRecord[];
  refresh: () => Promise<void>;
}>();
const open = defineModel<boolean>("open", { required: true });
const json = { "content-type": "application/json" };
const settingForm = ref({ providerId: "", model: "", temperature: 0.3, maxTokens: 1024 });
const models = ref<string[]>([]);
const loadingModels = ref(false);
const saving = ref(false);
// 提交期间不能关闭弹窗，避免旧提交的结果作用到新一轮编辑上。
const dialogOpen = computed({ get: () => open.value, set: (value) => { if (!saving.value) open.value = value; } });
const enabledProviders = computed(() => props.providers.filter((provider) => provider.enabled));
const modelCandidates = computed(() => {
  const { pattern, exclude } = props.capability;
  const matched = models.value.filter((model) => pattern.test(model) && !exclude?.test(model));
  return matched.length ? matched : models.value;
});
// 输入恰好是某个候选时列出全部，便于更换。
const visibleModels = computed(() => {
  const query = settingForm.value.model.trim().toLowerCase();
  if (!query || modelCandidates.value.some((model) => model.toLowerCase() === query)) return modelCandidates.value;
  return modelCandidates.value.filter((model) => model.toLowerCase().includes(query));
});

// 模型列表只采用最近一次请求的结果：切换供应商（含 A→B→A）、关闭弹窗都会让旧请求失效。
let modelsRequest: AbortController | undefined;

function cancelModels() {
  modelsRequest?.abort();
  modelsRequest = undefined;
  loadingModels.value = false;
}

async function loadModels() {
  cancelModels();
  const { providerId } = settingForm.value;
  models.value = [];
  if (!providerId) return;
  const request = new AbortController();
  modelsRequest = request;
  loadingModels.value = true;
  try {
    const listed = (await client.request<ListProviderModelsResponse>(`/api/admin/model-providers/${providerId}/models`, { signal: request.signal })).models;
    if (modelsRequest !== request) return;
    models.value = listed;
    if (!listed.length) toast.info("供应商没有返回可用模型，可以直接输入模型名");
  } catch (err) {
    if (modelsRequest === request) toast.error(errorMessage(err, "获取模型列表失败，可以直接输入模型名"));
  } finally {
    if (modelsRequest === request) {
      modelsRequest = undefined;
      loadingModels.value = false;
    }
  }
}

watch(open, (isOpen) => {
  if (!isOpen) {
    cancelModels();
    return;
  }
  const current = props.setting;
  const providerId = current && enabledProviders.value.some((provider) => provider.id === current.providerId) ? current.providerId : enabledProviders.value[0]?.id ?? "";
  settingForm.value = { providerId, model: current?.model ?? "", temperature: current?.temperature ?? props.capability.defaultTemperature ?? 0.3, maxTokens: current?.maxTokens ?? 1024 };
  void loadModels();
});

function selectProvider(id: unknown) {
  settingForm.value.providerId = String(id);
  void loadModels();
}

async function saveSetting() {
  if (saving.value) return;
  const capability = props.capability;
  const { providerId, model, temperature, maxTokens } = settingForm.value;
  const previous = props.setting;
  if (capability.id === "embedding" && previous && previous.model !== model.trim()
    && !await confirm({ title: "更换 Embedding 模型", description: "更换后，已向量化的文档需要重新向量化；在此之前向量检索只会使用同一模型的文档。确定更换？", confirmText: "更换" })) return;
  const body: SaveModelSettingRequest = { providerId, model: model.trim(), ...(capability.generative ? { temperature, maxTokens } : {}) };
  // 确认弹窗期间可能已提交过一次。
  if (saving.value) return;
  saving.value = true;
  try {
    await client.request<ModelSettingRecord>(`/api/admin/model-settings/${capability.id}`, { method: "PUT", headers: json, body: JSON.stringify(body) });
  } catch (err) {
    toast.error(errorMessage(err, "模型保存失败"));
    return;
  } finally {
    saving.value = false;
  }
  open.value = false;
  toast.success(`${capability.label} 模型已保存`);
  await props.refresh();
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-lg" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">MODEL SETTING</p>
        <DialogTitle>{{ capability.label }} 模型</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="saveSetting">
        <p class="text-xs text-muted-foreground">{{ capability.description }}</p>
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
          <Input id="ms-model" v-model="settingForm.model" required maxlength="200" autocomplete="off" :placeholder="capability.placeholder" />
          <p class="text-xs text-muted-foreground">{{ loadingModels ? '正在获取模型列表…' : models.length ? `直接输入模型名，或从供应商的 ${modelCandidates.length} 个模型中选择（输入可筛选）` : '直接输入模型名' }}</p>
          <div v-if="visibleModels.length" role="listbox" aria-label="供应商模型" class="max-h-48 overflow-y-auto rounded-md border p-1">
            <button v-for="model in visibleModels" :key="model" type="button" role="option" :aria-selected="model === settingForm.model.trim()"
              class="block w-full truncate rounded-sm px-2 py-1.5 text-left font-mono text-xs hover:bg-accent hover:text-accent-foreground"
              :class="model === settingForm.model.trim() ? 'bg-accent font-medium text-accent-foreground' : ''" :title="model" @click="settingForm.model = model">{{ model }}</button>
          </div>
          <p v-else-if="modelCandidates.length" class="text-xs text-muted-foreground">没有匹配的模型，将使用输入的模型名</p>
        </div>
        <div v-if="capability.generative" class="grid grid-cols-2 gap-3">
          <div class="grid gap-2"><Label for="ms-temperature">温度</Label><Input id="ms-temperature" v-model.number="settingForm.temperature" type="number" min="0" max="2" step="0.1" required /></div>
          <div class="grid gap-2"><Label for="ms-max-tokens">最大输出 Token</Label><Input id="ms-max-tokens" v-model.number="settingForm.maxTokens" type="number" min="1" max="1048576" step="1" required /></div>
          <p v-if="capability.id === 'chat'" class="col-span-2 text-xs leading-relaxed text-muted-foreground">最大输出 Token 是单次回答的长度上限（max_tokens），不是上下文窗口；不要超过模型的最大输出长度，否则调用会失败并退回原文摘录。问答回答一般 1024～4096 足够。</p>
          <p v-else class="col-span-2 text-xs leading-relaxed text-muted-foreground">审核输出逐项判断与理由，温度建议为 0 以便结果稳定；最大输出 1024～2048 一般足够，推理模型需要留出思考的长度。</p>
        </div>
        <p v-if="capability.id === 'embedding'" class="text-xs leading-relaxed text-muted-foreground">更换 Embedding 模型后，已向量化的文档需要重新向量化。</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="dialogOpen = false">取消</Button>
          <Button type="submit" :disabled="saving || !settingForm.providerId || !settingForm.model.trim()" :aria-busy="saving">{{ saving ? '保存中…' : '保存' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
