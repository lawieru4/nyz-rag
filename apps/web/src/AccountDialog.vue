<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { UserAccount, UserSessionResponse } from "@nyz-rag/types";
import { errorMessage } from "@nyz-rag/api-client";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Button } from "@nyz-rag/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { client } from "./webClient";

export type AccountMode = "login" | "register" | "forgot" | "password";

const props = defineProps<{ mode: AccountMode }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "authenticated", user: UserAccount): void;
  (e: "update:mode", mode: AccountMode): void;
  (e: "password-changed"): void;
}>();

const email = ref("");
const code = ref("");
const password = ref("");
const confirmPassword = ref("");
const currentPassword = ref("");
const busy = ref(false);
const sending = ref(false);
const error = ref("");
const info = ref("");
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | undefined;

const titles: Record<AccountMode, string> = { login: "登录", register: "注册账号", forgot: "找回密码", password: "修改密码" };
const needsCode = computed(() => props.mode === "register" || props.mode === "forgot");
const newPasswordLabel = computed(() => props.mode === "register" ? "设置密码" : "新密码");

watch(() => props.mode, () => {
  code.value = password.value = confirmPassword.value = currentPassword.value = "";
  error.value = info.value = "";
});
onUnmounted(() => clearInterval(cooldownTimer));

function startCooldown() {
  cooldown.value = 60;
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => { if (--cooldown.value <= 0) clearInterval(cooldownTimer); }, 1000);
}

function validEmail() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) { error.value = "请输入有效的邮箱地址"; return false; }
  return true;
}

function validNewPassword() {
  if (password.value.length < 8 || password.value.length > 128 || !password.value.trim()) { error.value = "密码需为 8～128 个字符"; return false; }
  if (password.value !== confirmPassword.value) { error.value = "两次输入的密码不一致"; return false; }
  return true;
}

async function sendCode() {
  error.value = info.value = "";
  if (!validEmail() || sending.value || cooldown.value) return;
  sending.value = true;
  try {
    await client.request(props.mode === "register" ? "/api/auth/register/code" : "/api/auth/password-reset/code", {
      method: "POST", body: JSON.stringify({ email: email.value.trim() }),
    });
    info.value = props.mode === "register" ? "邮件已发送，请查收验证码（10 分钟内有效）。" : "如果该邮箱已注册，验证码将发送到该邮箱（10 分钟内有效）。";
    startCooldown();
  } catch (err) {
    error.value = errorMessage(err, "验证码发送失败，请稍后重试");
  } finally {
    sending.value = false;
  }
}

async function submit() {
  if (busy.value) return;
  error.value = info.value = "";
  if (props.mode !== "password" && !validEmail()) return;
  if (needsCode.value && !/^\d{6}$/.test(code.value.trim())) { error.value = "请输入 6 位数字验证码"; return; }
  if (props.mode === "login" && !password.value) { error.value = "请输入密码"; return; }
  if (props.mode === "password" && !currentPassword.value) { error.value = "请输入当前密码"; return; }
  if (props.mode !== "login" && !validNewPassword()) return;
  busy.value = true;
  try {
    if (props.mode === "password") {
      await client.request("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: currentPassword.value, password: password.value }) });
      emit("password-changed");
      return;
    }
    const body = props.mode === "login"
      ? { email: email.value.trim(), password: password.value }
      : { email: email.value.trim(), code: code.value.trim(), password: password.value };
    const path = { login: "/api/auth/login", register: "/api/auth/register", forgot: "/api/auth/password-reset" }[props.mode];
    const { user } = await client.request<UserSessionResponse>(path, { method: "POST", body: JSON.stringify(body) });
    emit("authenticated", user!);
  } catch (err) {
    error.value = errorMessage(err, "请求失败，请检查网络后重试");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(open) => { if (!open) emit('close'); }">
    <DialogContent class="max-h-[calc(100vh-2.5rem)] overflow-y-auto sm:max-w-100">
      <DialogHeader>
        <p class="eyebrow mb-1">能知账号</p>
        <DialogTitle>{{ titles[mode] }}</DialogTitle>
        <DialogDescription v-if="mode === 'login' || mode === 'register'" class="text-xs leading-relaxed">不登录也可以提问，会话仅保存在当前浏览器；登录后当前浏览器中的会话会归入账号，可在其他设备查看。</DialogDescription>
        <DialogDescription v-else-if="mode === 'forgot'" class="text-xs leading-relaxed">重置密码后，其他设备上的登录将失效。</DialogDescription>
        <DialogDescription v-else class="sr-only">修改当前账号的登录密码</DialogDescription>
      </DialogHeader>

      <form class="grid gap-3.5" novalidate @submit.prevent="submit">
        <Alert v-if="error" variant="destructive" role="alert" class="bg-destructive/5 py-2"><AlertDescription>{{ error }}</AlertDescription></Alert>
        <Alert v-else-if="info" role="status" class="border-transparent bg-secondary py-2 text-secondary-foreground"><AlertDescription class="text-secondary-foreground">{{ info }}</AlertDescription></Alert>

        <div v-if="mode !== 'password'" class="grid gap-1.5">
          <Label for="account-email">邮箱</Label>
          <Input id="account-email" v-model="email" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com" :disabled="busy" />
        </div>
        <div v-if="needsCode" class="grid gap-1.5">
          <Label for="account-code">验证码</Label>
          <div class="flex gap-2">
            <Input id="account-code" v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字" :disabled="busy" />
            <Button type="button" variant="secondary" class="flex-none" :disabled="sending || cooldown > 0 || busy" @click="sendCode">{{ sending ? '发送中…' : cooldown ? `${cooldown} 秒后重发` : '发送验证码' }}</Button>
          </div>
        </div>
        <div v-if="mode === 'login'" class="grid gap-1.5">
          <Label for="account-password">密码</Label>
          <Input id="account-password" v-model="password" type="password" autocomplete="current-password" maxlength="1024" :disabled="busy" />
        </div>
        <div v-if="mode === 'password'" class="grid gap-1.5">
          <Label for="account-current-password">当前密码</Label>
          <Input id="account-current-password" v-model="currentPassword" type="password" autocomplete="current-password" maxlength="1024" :disabled="busy" />
        </div>
        <template v-if="mode !== 'login'">
          <div class="grid gap-1.5">
            <Label for="account-new-password">{{ newPasswordLabel }}</Label>
            <Input id="account-new-password" v-model="password" type="password" autocomplete="new-password" maxlength="128" placeholder="8～128 个字符" :disabled="busy" />
          </div>
          <div class="grid gap-1.5">
            <Label for="account-confirm-password">确认密码</Label>
            <Input id="account-confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" maxlength="128" :disabled="busy" />
          </div>
        </template>

        <Button type="submit" class="mt-1 h-10" :disabled="busy">{{ busy ? '请稍候…' : { login: '登录', register: '注册并登录', forgot: '重置密码并登录', password: '保存新密码' }[mode] }}</Button>
      </form>

      <footer v-if="mode !== 'password'" class="flex justify-between gap-2.5 border-t pt-3">
        <template v-if="mode === 'login'">
          <Button type="button" variant="link" size="sm" class="h-auto px-0 text-link" @click="emit('update:mode', 'forgot')">忘记密码？</Button>
          <Button type="button" variant="link" size="sm" class="h-auto px-0 text-link" @click="emit('update:mode', 'register')">没有账号？注册</Button>
        </template>
        <Button v-else type="button" variant="link" size="sm" class="h-auto px-0 text-link" @click="emit('update:mode', 'login')">← 返回登录</Button>
      </footer>
    </DialogContent>
  </Dialog>
</template>
