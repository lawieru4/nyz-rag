<script setup lang="ts">
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";

// reka-ui 的 SelectItem 不接受空字符串，“全部”用哨兵值表示，对外仍以空字符串表示未筛选。
const ALL = "__all__";

defineProps<{ modelValue: string; allLabel: string; options: Array<{ value: string; label: string }>; label: string }>();
const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
</script>

<template>
  <Select :model-value="modelValue || ALL" @update:model-value="(value) => emit('update:modelValue', value === ALL ? '' : String(value))">
    <SelectTrigger :aria-label="label" class="min-w-36 flex-1 bg-card sm:flex-none"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem :value="ALL">{{ allLabel }}</SelectItem>
      <SelectItem v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
    </SelectContent>
  </Select>
</template>
