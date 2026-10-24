<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { KeyRound } from "@lucide/vue";
import type { SecretSettingStatus } from "@nyz-rag/types";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { toast } from "@nyz-rag/ui/lib/toast";
import { can, client, errorMessage } from "../workspace";

// nyzdata 接口 token：全局一个，只能设置或清除，后台不显示已保存的值。
const tokenStatus = ref<SecretSettingStatus | null>(null);
const tokenDialogOpen = ref(false);
const tokenValue = ref("");
const tokenPath = "/api/admin/settings/article-token";
const saving = ref(false);
// 提交期间不能关闭弹窗。
const dialogOpen = computed({ get: () => tokenDialogOpen.value, set: (value) => { if (!saving.value) tokenDialogOpen.value = value; } });

async function loadTokenStatus() {
  try {
    tokenStatus.value = await client.request<SecretSettingStatus>(tokenPath);
  } catch {
    tokenStatus.value = null;
  }
}
onMounted(loadTokenStatus);

async function saveToken() {
  if (saving.value) return;
  saving.value = true;
  try {
    tokenStatus.value = await client.request<SecretSettingStatus>(tokenPath, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: tokenValue.value.trim() }) });
    tokenValue.value = "";
    tokenDialogOpen.value = false;
    toast.success("接口 Token 已保存，下次同步生效");
  } catch (err) {
    toast.error(errorMessage(err, "接口 Token 保存失败"));
  } finally {
    saving.value = false;
  }
}

async function clearToken() {
  if (saving.value || !await confirm({ title: "清除接口 Token", description: "清除后数据源将无法同步，直到重新填写。确定清除？", confirmText: "清除", destructive: true })) return;
  if (saving.value) return;
  saving.value = true;
  try {
    await client.request(tokenPath, { method: "DELETE" });
  } catch {
    toast.error("接口 Token 清除失败");
    return;
  } finally {
    saving.value = false;
  }
  if (tokenStatus.value) tokenStatus.value = { ...tokenStatus.value, configured: false, updatedAt: null };
  toast.success("接口 Token 已清除");
}
</script>

<template>
  <Card class="mb-7 flex-row flex-wrap items-center gap-3 px-5 py-4">
    <KeyRound class="size-4 flex-none text-link" aria-hidden="true" />
    <div class="grid min-w-0 flex-1 gap-1">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="text-sm font-semibold">nyzdata 接口 Token</h2>
        <Badge v-if="tokenStatus" :variant="tokenStatus.configured ? 'success' : 'muted'">{{ tokenStatus.configured ? '已配置' : '未配置' }}</Badge>
      </div>
      <p class="text-xs text-muted-foreground">
        <template v-if="tokenStatus && !tokenStatus.encryptionReady">服务端未配置 NYZ_SECRET_KEY（至少 32 个字符），无法保存或使用 Token。</template>
        <template v-else-if="tokenStatus?.configured">所有文章来源共用，更新于 {{ new Date(tokenStatus.updatedAt!).toLocaleString() }}；修改后下次同步生效。</template>
        <template v-else>所有文章来源共用；未配置时同步会失败。</template>
      </p>
    </div>
    <div v-if="can('sources:manage')" class="flex gap-1.5">
      <Button variant="outline" size="sm" :disabled="tokenStatus?.encryptionReady === false" @click="tokenDialogOpen = true">{{ tokenStatus?.configured ? '更换' : '设置' }}</Button>
      <Button v-if="tokenStatus?.configured" variant="outline" size="sm" class="text-destructive hover:text-destructive" :disabled="saving" @click="clearToken">清除</Button>
    </div>
  </Card>

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[10px] font-medium tracking-wider text-link">ARTICLE API TOKEN</p>
        <DialogTitle>{{ tokenStatus?.configured ? '更换接口 Token' : '设置接口 Token' }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="saveToken">
        <div class="grid gap-2"><Label for="article-token">Token</Label><Input id="article-token" v-model="tokenValue" type="password" autocomplete="new-password" required maxlength="4096" pattern="\S+" placeholder="nyzdata 文章接口 token" /></div>
        <p class="rounded-md bg-secondary p-2.5 text-[11px] leading-relaxed text-secondary-foreground">Token 加密保存在数据库中，保存后不再显示；Worker 在每次同步时读取，无需重启。</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="dialogOpen = false">取消</Button>
          <Button type="submit" :disabled="saving" :aria-busy="saving">{{ saving ? '保存中…' : '保存' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
