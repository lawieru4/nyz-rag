<script setup lang="ts">
import { ref, watch } from "vue";
import { LoaderCircle, RefreshCw } from "@lucide/vue";
import type { ListProviderModelsRequest, ListProviderModelsResponse, ModelProviderRecord, SaveModelProviderRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Switch } from "@nyz-rag/ui/components/switch";
import { toast } from "@nyz-rag/ui/lib/toast";
import { client, errorMessage } from "../../workspace";

const props = defineProps<{ provider: ModelProviderRecord | null; refresh: () => Promise<void> }>();
const open = defineModel<boolean>("open", { required: true });
const json = { "content-type": "application/json" };

// Worker/API 在容器中运行时，本机 Ollama 地址需改为 host.docker.internal。
const presets = [
  { id: "siliconflow", label: "硅基流动", provider: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openai", label: "OpenAI", provider: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "ollama", label: "本地 Ollama", provider: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "custom", label: "其他 OpenAI 兼容服务", provider: "OpenAI 兼容", baseUrl: "" },
];
const emptyForm = () => ({ name: "", provider: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", credentialEnv: "", apiKey: "", clearApiKey: false, enabled: true });
const form = ref(emptyForm());
const preset = ref("siliconflow");
const testing = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  const provider = props.provider;
  form.value = provider
    ? { name: provider.name, provider: provider.provider, baseUrl: provider.baseUrl, credentialEnv: provider.credentialEnv, apiKey: "", clearApiKey: false, enabled: provider.enabled }
    : emptyForm();
  preset.value = presets.find((item) => item.baseUrl && item.baseUrl === form.value.baseUrl)?.id ?? "custom";
});

function applyPreset(id: unknown) {
  const item = presets.find((entry) => entry.id === id);
  if (!item) return;
  preset.value = item.id;
  form.value.provider = item.provider;
  form.value.baseUrl = item.baseUrl;
}

// 未填写新 Key 时使用已保存的密钥；勾选清除时不引用已保存供应商。
async function testConnection() {
  testing.value = true;
  try {
    const { name, provider, baseUrl, apiKey, credentialEnv } = form.value;
    const body: ListProviderModelsRequest = { name, provider, baseUrl, ...(apiKey.trim() ? { apiKey } : {}), ...(props.provider && !form.value.clearApiKey ? { providerId: props.provider.id } : {}), ...(credentialEnv ? { credentialEnv } : {}) };
    const { models: listed } = await client.request<ListProviderModelsResponse>("/api/admin/model-providers/models", { method: "POST", headers: json, body: JSON.stringify(body) });
    toast.success(listed.length ? `连接成功，可用模型 ${listed.length} 个` : "连接成功，但供应商没有返回模型列表");
  } catch (err) {
    toast.error(errorMessage(err, "连接失败"));
  } finally {
    testing.value = false;
  }
}

async function saveProvider() {
  const target = props.provider;
  const { apiKey, clearApiKey, ...rest } = form.value;
  const body: SaveModelProviderRequest = { ...rest, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : clearApiKey ? { clearApiKey: true } : {}) };
  try {
    await client.request(`/api/admin/model-providers${target ? `/${target.id}` : ""}`, { method: target ? "PATCH" : "POST", headers: json, body: JSON.stringify(body) });
    await props.refresh();
    open.value = false;
    toast.success(target ? "供应商已更新" : "供应商已添加");
  } catch (err) {
    toast.error(errorMessage(err, "供应商保存失败，请检查 API 服务"));
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">MODEL PROVIDER</p>
        <DialogTitle>{{ provider ? '编辑供应商' : '添加供应商' }}</DialogTitle>
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
            <Input id="mp-api-key" v-model="form.apiKey" type="password" autocomplete="new-password" maxlength="4096" :placeholder="provider?.hasApiKey ? '已保存，留空保持不变' : '本地模型可不填'" />
            <Label v-if="provider?.hasApiKey" class="text-xs font-normal text-muted-foreground"><Switch v-model="form.clearApiKey" :disabled="Boolean(form.apiKey)" />清除已保存的密钥</Label>
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
            <p>只能使用服务端 NYZ_MODEL_CREDENTIAL_ENVS 中列出的变量。</p>
          </div>
        </details>
        <DialogFooter>
          <Button type="button" variant="outline" @click="open = false">取消</Button>
          <Button type="submit">保存供应商</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
