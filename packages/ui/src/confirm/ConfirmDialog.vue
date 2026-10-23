<script setup lang="ts">
import { Button } from "../components/ui/button";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { confirmState, settleConfirm } from "./state";
</script>

<template>
  <!-- 取消、Esc 都经 update:open 关闭；确认用普通按钮，避免 AlertDialogAction 先触发关闭而被记为取消。 -->
  <AlertDialog :open="confirmState.open" @update:open="(open) => { if (!open) settleConfirm(false); }">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ confirmState.options.title }}</AlertDialogTitle>
        <AlertDialogDescription :class="!confirmState.options.description && 'sr-only'">{{ confirmState.options.description ?? confirmState.options.title }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ confirmState.options.cancelText ?? "取消" }}</AlertDialogCancel>
        <Button :variant="confirmState.options.destructive ? 'destructive' : 'default'" @click="settleConfirm(true)">{{ confirmState.options.confirmText ?? "确定" }}</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
