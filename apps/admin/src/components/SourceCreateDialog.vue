<script setup lang="ts">
import { computed, ref } from "vue";
import type { CreateSourceRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { toast } from "@nyz-rag/ui/lib/toast";
import { client, errorMessage, refreshAfterWrite } from "../workspace";

const props = defineProps<{ refreshSources: () => Promise<void> }>();
const dialogOpen = defineModel<boolean>("open", { required: true });
const saving = ref(false);
// 提交期间不能关闭弹窗，避免旧提交的结果作用到新一轮编辑上。
const open = computed({ get: () => dialogOpen.value, set: (value) => { if (!saving.value) dialogOpen.value = value; } });
const emptyForm = () => ({ name: "", url: "", frequency: "每天" });
// 组件始终挂载，取消时保留已填写的内容，添加并刷新成功后才清空。
const form = ref(emptyForm());

async function addSource() {
  if (saving.value) return;
  const name = form.value.name.trim();
  const url = form.value.url.trim();
  try {
    const parsed = new URL(url);
    if (!name || !["http:", "https:"].includes(parsed.protocol)) throw new Error();
  } catch {
    toast.error("请填写名称和有效的 http(s) 地址");
    return;
  }
  saving.value = true;
  try {
    await client.request("/api/admin/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form.value, name, url, kind: "文章 API" } satisfies CreateSourceRequest) });
  } catch (err) {
    toast.error(errorMessage(err, "数据源添加失败"));
    return;
  } finally {
    saving.value = false;
  }
  form.value = emptyForm();
  dialogOpen.value = false;
  toast.success("数据源已添加");
  await refreshAfterWrite(props.refreshSources);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-md" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[11px] font-medium tracking-wider text-link">NEW CONNECTION</p>
        <DialogTitle>添加数据源</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="addSource">
        <div class="grid gap-2"><Label for="source-name">数据源名称</Label><Input id="source-name" v-model="form.name" autofocus placeholder="例如：能知储能文章" required /></div>
        <div class="grid gap-2"><Label for="source-url">来源地址</Label><Input id="source-url" v-model="form.url" type="url" placeholder="https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=…" required /></div>
        <div class="grid gap-2">
          <Label for="source-frequency">同步频率</Label>
          <Select v-model="form.frequency"><SelectTrigger id="source-frequency" class="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem v-for="frequency in ['每小时', '每 6 小时', '每天', '手动']" :key="frequency" :value="frequency">{{ frequency }}</SelectItem></SelectContent></Select>
        </div>
        <p class="rounded-md bg-secondary p-2.5 text-xs leading-relaxed text-secondary-foreground">新增来源默认暂停，确认授权后再启动。来源地址填写 nyzdata 文章列表接口（不含 token），token 在本页「nyzdata 接口 Token」中配置。</p>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="open = false">取消</Button>
          <Button type="submit" :disabled="saving" :aria-busy="saving">{{ saving ? '添加中…' : '添加来源' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
