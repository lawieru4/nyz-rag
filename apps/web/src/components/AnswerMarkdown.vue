<script setup lang="ts">
import { computed } from "vue";
import { parseMarkdown } from "../markdown";
import { useSmoothText } from "../smoothText";
import AnswerInline from "./AnswerInline.vue";
import MarkdownBlocks from "./MarkdownBlocks.vue";

const props = defineProps<{
  text: string;
  /** 本轮引用来源数量；超出范围的 [n] 按普通文本显示。 */
  sourceCount: number;
  activeCitation?: number | null;
  streaming?: boolean;
}>();
const emit = defineEmits<{ cite: [citation: number] }>();

// 流式生成时逐帧释放已收到的文字，每帧重新解析（数千字的回答解析一次不到 1ms）。
const shown = useSmoothText(() => props.text, () => !!props.streaming);
const blocks = computed(() => parseMarkdown(shown.value));
const inline = computed(() => ({ sourceCount: props.sourceCount, activeCitation: props.activeCitation }));
const cite = (citation: number) => emit("cite", citation);
</script>

<template>
  <div :class="['my-4 text-base leading-[1.85] text-pretty text-body max-sm:text-[15px]', streaming && 'answer-streaming']">
    <MarkdownBlocks v-slot="{ text }" :blocks="blocks" variant="answer">
      <AnswerInline :text="text" v-bind="inline" @cite="cite" />
    </MarkdownBlocks>
  </div>
</template>
