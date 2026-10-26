<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { ChatFeedbackReason, ChatReviewInput, ChatReviewRecord, EvaluationCandidate } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Checkbox } from "@nyz-rag/ui/components/checkbox";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Textarea } from "@nyz-rag/ui/components/textarea";
import { toast } from "@nyz-rag/ui/lib/toast";
import DetailSection from "../components/DetailSection.vue";
import { can, client, errorMessage } from "../workspace";

const props = defineProps<{ id: string }>();
const emit = defineEmits<{ saved: [] }>();
const panelId = useId();
const record = ref<ChatReviewRecord | null>(null);
const status = ref<ChatReviewInput["status"]>("new");
const reasons = ref<ChatFeedbackReason[]>([]);
const notes = ref("");
const correctedAnswer = ref("");
const candidateText = ref("null");
const baseline = ref("");
const confirmed = ref(false);
const busy = ref(false);
const disabled = computed(() => busy.value || !can('chat-logs:manage'));
const error = ref("");
const fields = computed(() => JSON.stringify([status.value, reasons.value, notes.value, correctedAnswer.value, candidateText.value]));
const dirty = computed(() => fields.value !== baseline.value);
const reasonOptions: Array<{ value: ChatFeedbackReason; label: string }> = [
  { value: "missing-evidence", label: "资料未召回" }, { value: "incorrect-answer", label: "答案错误" },
  { value: "citation-mismatch", label: "引用不符" }, { value: "outdated", label: "内容过时" }, { value: "other", label: "其他" },
];
let loadVersion = 0;
async function load() {
  const version = ++loadVersion;
  record.value = null;
  error.value = "";
  confirmed.value = false;
  try {
    const value = await client.request<ChatReviewRecord>(`/api/admin/chat-logs/${props.id}/review`);
    if (version !== loadVersion) return;
    record.value = value;
    status.value = value.status; reasons.value = value.reasons; notes.value = value.notes; correctedAnswer.value = value.correctedAnswer;
    candidateText.value = JSON.stringify(value.candidate, null, 2);
    baseline.value = fields.value;
  } catch (err) { if (version === loadVersion) error.value = errorMessage(err, "处理记录加载失败"); }
}
watch(() => props.id, load, { immediate: true });
watch(fields, () => { confirmed.value = false; });

function createCandidate() {
  const candidate: EvaluationCandidate = { question: "", answer: "", history: [], filters: null, type: "fact", split: "dev", answerable: true, labels: [{ articleKey: "", relevance: 2, evidence: [""] }] };
  candidateText.value = JSON.stringify(candidate, null, 2);
}
async function act(action: "save" | "approve" | "export") {
  if (!record.value || busy.value) return;
  busy.value = true;
  error.value = "";
  const id = props.id;
  try {
    const revision = record.value.revision;
    if (action === "save") {
      const review: ChatReviewInput = { status: status.value, reasons: reasons.value, notes: notes.value, correctedAnswer: correctedAnswer.value, candidate: JSON.parse(candidateText.value) };
      await client.request(`/api/admin/chat-logs/${id}/review`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, review }) });
    } else if (action === "approve") {
      await client.request(`/api/admin/chat-logs/${id}/review/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, confirmSanitized: confirmed.value }) });
    } else {
      const dataset = await client.request(`/api/admin/chat-logs/${id}/review/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision }) });
      const url = URL.createObjectURL(new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "reviewed-feedback-v2.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    if (id !== props.id) return;
    if (action !== "export") { await load(); emit("saved"); }
    toast.success(action === "save" ? "已保存，旧批准已失效" : action === "approve" ? "当前版本已人工批准" : "已导出审核题目");
  } catch (err) { if (id === props.id) error.value = errorMessage(err, "操作失败；如版本冲突请重新加载后核对"); }
  finally { busy.value = false; }
}
</script>

<template>
  <DetailSection title="反馈处理与回归标注">
    <p v-if="!record && !error" class="text-xs text-muted-foreground">正在加载处理记录…</p>
    <p v-if="error" role="alert" class="mb-3 break-words text-xs text-destructive">{{ error }}</p>
    <Button v-if="!record || error" variant="outline" size="sm" :disabled="busy" @click="load">重新加载（丢弃未保存修改）</Button>
    <div v-if="record" class="grid gap-3 text-xs">
      <p class="text-muted-foreground">版本 {{ record.revision }} · {{ record.approvedRevision === record.revision ? `已批准 ${record.approvedAt}` : '未批准' }}{{ dirty ? ' · 有未保存修改' : '' }}</p>
      <fieldset class="grid min-w-0 gap-3" :disabled="disabled">
        <Label :for="`${panelId}-status`" class="grid gap-1.5 text-xs leading-normal font-normal">处理状态
          <Select v-model="status" :disabled="disabled">
            <SelectTrigger :id="`${panelId}-status`" class="w-full" aria-label="处理状态"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="new">待处理</SelectItem>
              <SelectItem value="investigating">核查中</SelectItem>
              <SelectItem value="resolved">已解决</SelectItem>
              <SelectItem value="dismissed">不处理</SelectItem>
            </SelectContent>
          </Select>
        </Label>
        <div class="flex flex-wrap gap-3" role="group" aria-label="问题分类"><Label v-for="reason in reasonOptions" :key="reason.value" :for="`${panelId}-reason-${reason.value}`" class="flex items-center gap-1.5 text-xs leading-normal font-normal"><Checkbox :id="`${panelId}-reason-${reason.value}`" :model-value="reasons.includes(reason.value)" :disabled="disabled" @update:model-value="checked => reasons = checked === true ? [...reasons.filter(value => value !== reason.value), reason.value] : reasons.filter(value => value !== reason.value)" />{{ reason.label }}</Label></div>
        <Label :for="`${panelId}-notes`" class="grid gap-1.5 text-xs leading-normal font-normal">处理记录（内部，不导出）<Textarea :id="`${panelId}-notes`" v-model="notes" rows="3" maxlength="20000" /></Label>
        <Label :for="`${panelId}-corrected-answer`" class="grid gap-1.5 text-xs leading-normal font-normal">修正答案（内部，不自动复制到候选题）<Textarea :id="`${panelId}-corrected-answer`" v-model="correctedAnswer" rows="3" maxlength="20000" /></Label>
        <div class="rounded-md border bg-muted/40 p-3 leading-relaxed text-muted-foreground">
          候选题必须人工脱敏填写，不自动复制日志。原日志未保存精确历史和过滤条件，不能推断为精确重放。移除姓名、邮箱、私有信息、密钥及内部链接，包括问题、答案、历史与证据文本。
          <br>type 支持 fact / mechanism / compare / metadata / term / followup / unanswerable；split 为 dev 或 test。followup 必须标注 history；不可回答题使用 unanswerable、answerable=false，且标签相关度不能大于 1。articleKey 为数字文章外部 ID，相关度至少 1 时必须填写原文证据，可回答题至少一篇相关度 2。
          <br>history 为 question/answer 数组；filters 支持 sourceId、publishedFrom/To、categories、tags、scenarios。当前评测运行器会明确拒绝非空 history 或 filters，尚不能执行此类重放。审核只确认人工标注及摘录有效性，不证明真实模型质量。
        </div>
        <div class="flex flex-wrap gap-2"><Button variant="outline" size="sm" @click="createCandidate">新建空白候选题</Button><Button variant="ghost" size="sm" @click="candidateText = 'null'">移除候选题</Button></div>
        <Label :for="`${panelId}-candidate`" class="grid min-w-0 gap-1.5 text-xs leading-normal font-normal">脱敏候选题 JSON（null 表示没有候选题）<Textarea :id="`${panelId}-candidate`" v-model="candidateText" rows="16" spellcheck="false" class="font-mono text-xs md:text-xs" /></Label>
        <Button size="sm" :disabled="!dirty" @click="act('save')">保存处理与标注（使批准失效）</Button>
        <Label :for="`${panelId}-confirmed`" class="flex items-start gap-2 text-xs leading-relaxed font-normal"><Checkbox :id="`${panelId}-confirmed`" v-model="confirmed" class="mt-0.5" :disabled="disabled || dirty || !record.candidate" />我已人工核查当前已保存版本，确认问题、答案、历史、过滤条件和全部证据均已脱敏，标注及不可回答性判断正确，可导出为回归候选题。</Label>
        <div class="flex flex-wrap gap-2"><Button variant="outline" size="sm" :disabled="dirty || !confirmed || !record.candidate" @click="act('approve')">人工批准当前版本</Button><Button variant="outline" size="sm" :disabled="dirty || record.approvedRevision !== record.revision" @click="act('export')">导出已批准 v2 题集</Button></div>
      </fieldset>
      <p v-if="!can('chat-logs:manage')" class="text-muted-foreground">只读权限；处理、批准和导出需要问答记录管理权限。</p>
    </div>
  </DetailSection>
</template>
