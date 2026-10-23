<script setup lang="ts">
import { computed } from "vue";
import { parseMarkdown } from "../markdown";
import AnswerInline from "./AnswerInline.vue";

const props = defineProps<{
  text: string;
  /** 本轮引用来源数量；超出范围的 [n] 按普通文本显示。 */
  sourceCount: number;
  activeCitation?: number | null;
  streaming?: boolean;
}>();
const emit = defineEmits<{ cite: [citation: number] }>();

const blocks = computed(() => parseMarkdown(props.text));
const inline = computed(() => ({ sourceCount: props.sourceCount, activeCitation: props.activeCitation }));
const cite = (citation: number) => emit("cite", citation);
</script>

<template>
  <div :class="['my-4 text-[13.5px] leading-[1.85] text-[#3f4943]', streaming && 'answer-streaming']">
    <template v-for="(block, index) in blocks" :key="index">
      <component :is="`h${block.level}`" v-if="block.kind === 'heading'" :class="['mt-5 mb-2 font-semibold text-[#29342e] first:mt-0', (block.level ?? 3) <= 2 ? 'text-[15px]' : 'text-sm']">
        <AnswerInline :text="block.text ?? ''" v-bind="inline" @cite="cite" />
      </component>
      <p v-else-if="block.kind === 'paragraph'" class="mb-3 last:mb-0">
        <AnswerInline :text="block.text ?? ''" v-bind="inline" @cite="cite" />
      </p>
      <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.start" :class="['mb-3 grid gap-1.5 pl-5 marker:text-[#8a9663] last:mb-0', block.ordered ? 'list-decimal' : 'list-disc']">
        <li v-for="(item, itemIndex) in block.items" :key="itemIndex" class="pl-1"><AnswerInline :text="item" v-bind="inline" @cite="cite" /></li>
      </component>
      <pre v-else-if="block.kind === 'code'" class="mb-3 overflow-auto rounded-md border bg-[#f0f2ef] p-3 font-mono text-xs leading-relaxed last:mb-0"><code>{{ block.text }}</code></pre>
      <div v-else-if="block.kind === 'table'" class="mb-3 max-w-full overflow-x-auto last:mb-0">
        <table class="w-full border-collapse text-xs">
          <tbody>
            <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
              <component :is="rowIndex === 0 ? 'th' : 'td'" v-for="(cell, cellIndex) in row" :key="cellIndex" :class="['border border-input px-2.5 py-1.5 text-left align-top', rowIndex === 0 && 'bg-[#eff3e9] font-semibold text-[#46533e]']">
                <AnswerInline :text="cell" v-bind="inline" @cite="cite" />
              </component>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
