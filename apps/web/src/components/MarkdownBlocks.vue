<script setup lang="ts">
import { computed } from "vue";
import type { MarkdownBlock } from "../markdown";
import MarkdownInline from "./MarkdownInline.vue";

const props = defineProps<{ blocks: MarkdownBlock[]; variant?: "article" | "answer" }>();
const answer = computed(() => props.variant === "answer");
</script>

<template>
  <template v-for="(block, index) in blocks" :key="index">
    <component :is="`h${block.level}`" v-if="block.kind === 'heading'" :class="answer ? ['mt-6 mb-2 font-semibold text-foreground first:mt-0', (block.level ?? 3) <= 2 ? 'text-lg' : 'text-base'] : 'markdown-heading'">
      <slot :text="block.text ?? ''"><MarkdownInline :text="block.text ?? ''" /></slot>
    </component>
    <p v-else-if="block.kind === 'paragraph'" :class="answer ? 'mb-3 last:mb-0' : 'markdown-paragraph'">
      <slot :text="block.text ?? ''"><MarkdownInline :text="block.text ?? ''" /></slot>
    </p>
    <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.kind === 'list'" :start="block.start" :class="[answer ? 'mb-3 grid gap-1.5 pl-5 marker:text-olive last:mb-0' : 'markdown-list', block.ordered ? 'list-decimal' : 'list-disc']">
      <li v-for="(item, itemIndex) in block.items" :key="itemIndex" :class="answer ? 'pl-1' : undefined"><slot :text="item"><MarkdownInline :text="item" /></slot></li>
    </component>
    <pre v-else-if="block.kind === 'code'" :class="answer ? 'mb-3 overflow-auto rounded-md bg-muted p-3 font-mono text-[13px] leading-relaxed last:mb-0' : 'markdown-code'"><code>{{ block.text }}</code></pre>
    <div v-else-if="block.kind === 'table'" :class="answer ? 'mb-3 max-w-full overflow-x-auto last:mb-0' : 'markdown-table-wrap'">
      <table :class="answer ? 'w-full border-collapse text-sm' : undefined">
        <tbody>
          <tr v-for="(row, rowIndex) in block.rows" :key="rowIndex">
            <component :is="rowIndex === 0 ? 'th' : 'td'" v-for="(cell, cellIndex) in row" :key="cellIndex" :class="answer ? ['border border-input px-2.5 py-1.5 text-left align-top', rowIndex === 0 && 'bg-accent font-semibold text-secondary-foreground'] : undefined">
              <!-- Article table cells stay literal; only answers parse inline formatting. -->
              <slot v-if="answer" :text="cell"><MarkdownInline :text="cell" /></slot>
              <template v-else>{{ cell }}</template>
            </component>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
