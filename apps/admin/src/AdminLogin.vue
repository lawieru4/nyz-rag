<script setup lang="ts">
import { ref } from "vue";
import { LoaderCircle } from "@lucide/vue";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";

const props = defineProps<{
  error?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (e: "submit", username: string, password: string): void;
}>();

const username = ref("");
const password = ref("");

function handleSubmit() {
  if (props.busy) return;
  emit("submit", username.value.trim(), password.value);
}
</script>

<template>
  <div class="flex min-h-dvh items-center justify-center p-4">
    <Card class="w-full max-w-100 gap-0 px-9 pt-10 pb-9 max-sm:px-6 max-sm:pt-8 max-sm:pb-7">
      <div class="mb-9 flex items-center gap-3">
        <img src="/logo.png" alt="能知" class="h-12 w-36 flex-none object-contain" />
        <div>
          <span class="block text-xs font-medium text-muted-foreground">新能源知识助手</span>
          <span class="block text-xs text-muted-foreground">管理后台</span>
        </div>
      </div>

      <form class="grid gap-4" novalidate @submit.prevent="handleSubmit">
        <h1 class="text-xl font-semibold">登录</h1>
        <Alert v-if="error" variant="destructive" role="alert" aria-live="assertive"><AlertDescription>{{ error }}</AlertDescription></Alert>
        <div class="grid gap-2">
          <Label for="login-username">邮箱 / 初始账号</Label>
          <Input id="login-username" v-model="username" type="text" name="username" autocomplete="username" required :disabled="busy" placeholder="请输入邮箱或初始账号" aria-required="true" />
        </div>
        <div class="grid gap-2">
          <Label for="login-password">密码</Label>
          <Input id="login-password" v-model="password" type="password" name="password" autocomplete="current-password" required :disabled="busy" placeholder="请输入密码" aria-required="true" />
        </div>
        <Button type="submit" class="mt-1 h-10" :disabled="busy" :aria-busy="busy">
          <LoaderCircle v-if="busy" class="animate-spin" aria-hidden="true" />
          {{ busy ? "验证中…" : "登录" }}
        </Button>
      </form>
    </Card>
  </div>
</template>
