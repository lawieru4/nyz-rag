<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "../../../lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
  /** 外层滚动容器的类名，例如手机端改用摘要列表时隐藏表格。 */
  containerClass?: HTMLAttributes["class"]
}>()
</script>

<template>
  <div data-slot="table-container" :class="cn('relative w-full overflow-auto', props.containerClass)">
    <table data-slot="table" :class="cn('w-full caption-bottom text-sm', props.class)">
      <slot />
    </table>
  </div>
</template>
