<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Plus } from "@lucide/vue";
import type { KnowledgeBaseRecord, SaveKnowledgeBaseRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Switch } from "@nyz-rag/ui/components/switch";
import { Textarea } from "@nyz-rag/ui/components/textarea";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { can, client, errorMessage, refreshAfterWrite } from "../workspace";

const emptyForm = (): SaveKnowledgeBaseRequest => ({ name: "", description: "", topK: 5, similarityThreshold: 0.35, rerankEnabled: false, citationCheck: true, maxContextLength: 6000, prompt: "请依据提供的知识库内容回答问题；若资料不足，请明确说明。", model: "默认模型" });
const knowledgeBases = ref<KnowledgeBaseRecord[]>([]);
const dialogOpen = ref(false);
const editingId = ref("");
const form = ref(emptyForm());
const saving = ref(false);
// 提交期间不能关闭或重开弹窗，避免旧提交的结果作用到新一轮编辑上。
const open = computed({ get: () => dialogOpen.value, set: (value) => { if (!saving.value) dialogOpen.value = value; } });

async function fetchKnowledgeBases() {
  knowledgeBases.value = await client.request<KnowledgeBaseRecord[]>("/api/admin/knowledge-bases");
}
onMounted(() => fetchKnowledgeBases().catch(() => { toast.error("知识库列表加载失败，请检查 API 服务"); }));

function edit(item?: KnowledgeBaseRecord) {
  if (saving.value) return;
  editingId.value = item?.id ?? "";
  form.value = item ? { name: item.name, description: item.description, topK: item.topK, similarityThreshold: item.similarityThreshold, rerankEnabled: item.rerankEnabled, citationCheck: item.citationCheck, maxContextLength: item.maxContextLength, prompt: item.prompt, model: item.model } : emptyForm();
  dialogOpen.value = true;
}

async function save() {
  if (saving.value) return;
  const editing = Boolean(editingId.value);
  saving.value = true;
  try {
    await client.request(`/api/admin/knowledge-bases${editing ? `/${editingId.value}` : ""}`, { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form.value satisfies SaveKnowledgeBaseRequest) });
  } catch (err) {
    toast.error(errorMessage(err, "知识库保存失败，请检查配置"));
    return;
  } finally {
    saving.value = false;
  }
  dialogOpen.value = false;
  toast.success(editing ? "知识库配置已更新" : "知识库已创建");
  await refreshAfterWrite(fetchKnowledgeBases);
}
</script>

<template>
  <PageHeading eyebrow="RETRIEVAL CONFIGURATION" title="知识库" subtitle="维护召回策略、上下文和回答指令">
    <Button v-if="can('knowledge-bases:manage')" @click="edit()"><Plus /> 新建知识库</Button>
  </PageHeading>
  <Card class="min-h-72 gap-0 py-0">
    <div class="px-5 py-4"><h2 class="text-sm font-semibold">知识库配置</h2><p class="mt-1 text-xs text-muted-foreground">{{ knowledgeBases.length }} 个知识库</p></div>
    <article v-for="item in knowledgeBases" :key="item.id" class="flex items-start justify-between gap-5 border-t p-5 max-sm:flex-col max-sm:gap-4 max-sm:px-4">
      <div class="min-w-0 flex-1 max-sm:w-full">
        <div class="flex flex-wrap items-center gap-3"><h3 class="min-w-0 text-sm font-semibold break-words">{{ item.name }}</h3><StatusBadge :on="item.rerankEnabled">{{ item.rerankEnabled ? '重排序开启' : '重排序关闭' }}</StatusBadge><StatusBadge :on="item.citationCheck">{{ item.citationCheck ? '引用校验开启' : '引用校验关闭' }}</StatusBadge></div>
        <p class="mt-1.5 mb-4 text-xs break-words text-muted-foreground">{{ item.description || '未填写描述' }}</p>
        <dl class="flex flex-wrap gap-5">
          <div v-for="[label, value] in [['召回数量', item.topK], ['相似度阈值', item.similarityThreshold.toFixed(2)], ['最大上下文', `${item.maxContextLength.toLocaleString()} 字符`], ['模型', item.model]]" :key="label" class="grid gap-1">
            <dt class="text-xs text-muted-foreground">{{ label }}</dt><dd class="font-mono text-xs break-all">{{ value }}</dd>
          </div>
        </dl>
      </div>
      <Button v-if="can('knowledge-bases:manage')" variant="outline" class="flex-none" @click="edit(item)">编辑配置</Button>
    </article>
    <EmptyState v-if="!knowledgeBases.length" class="border-t">尚未创建知识库 <Button v-if="can('knowledge-bases:manage')" variant="link" size="sm" class="text-link" @click="edit()">创建第一个知识库</Button></EmptyState>
  </Card>

  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-xl" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[11px] font-medium tracking-wider text-link">KNOWLEDGE BASE</p>
        <DialogTitle>{{ editingId ? '编辑知识库' : '新建知识库' }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" @submit.prevent="save">
        <div class="grid gap-2"><Label for="kb-name">名称</Label><Input id="kb-name" v-model="form.name" required maxlength="100" placeholder="例如：产品帮助中心" /></div>
        <div class="grid gap-2"><Label for="kb-description">描述</Label><Input id="kb-description" v-model="form.description" maxlength="500" placeholder="知识库的内容范围" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2"><Label for="kb-topk">召回数量</Label><Input id="kb-topk" v-model.number="form.topK" type="number" min="1" max="100" required /></div>
          <div class="grid gap-2"><Label for="kb-threshold">相似度阈值</Label><Input id="kb-threshold" v-model.number="form.similarityThreshold" type="number" min="0" max="1" step="0.01" required /></div>
          <div class="grid gap-2"><Label for="kb-context">最大上下文长度</Label><Input id="kb-context" v-model.number="form.maxContextLength" type="number" min="256" step="256" required /></div>
          <div class="grid gap-2"><Label for="kb-model">模型</Label><Input id="kb-model" v-model="form.model" required maxlength="100" /></div>
        </div>
        <Label class="font-normal"><Switch v-model="form.rerankEnabled" />启用重排序</Label>
        <div class="grid gap-1.5">
          <Label class="font-normal"><Switch v-model="form.citationCheck" />启用引用校验</Label>
          <p class="text-xs text-muted-foreground">开启：要求每个结论标注引用，资料不足时固定拒答，没有引用或引用编号无效的回答改为展示原文片段。关闭：使用宽松的回答要求，模型回答非空即采用。</p>
        </div>
        <div class="grid gap-2"><Label for="kb-prompt">回答提示词</Label><Textarea id="kb-prompt" v-model="form.prompt" rows="5" maxlength="10000" /></div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="saving" @click="open = false">取消</Button>
          <Button type="submit" :disabled="saving" :aria-busy="saving">{{ saving ? '保存中…' : '保存配置' }}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
