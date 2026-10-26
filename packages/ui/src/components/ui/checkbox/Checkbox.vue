<script setup lang="ts">
import type { CheckboxRootEmits, CheckboxRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { Check } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import { CheckboxIndicator, CheckboxRoot, useForwardPropsEmits } from "reka-ui"
import { cn } from "../../../lib/utils"

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<CheckboxRootEmits>()
const forwarded = useForwardPropsEmits(reactiveOmit(props, "class"), emits)
</script>

<template>
  <CheckboxRoot
    data-slot="checkbox"
    v-bind="forwarded"
    :class="cn('peer inline-flex size-4 shrink-0 items-center justify-center rounded border border-input shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50', props.class)"
  >
    <CheckboxIndicator data-slot="checkbox-indicator" class="flex items-center justify-center">
      <slot><Check class="size-3.5" /></slot>
    </CheckboxIndicator>
  </CheckboxRoot>
</template>
