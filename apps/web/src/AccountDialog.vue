<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { UserAccount, UserSessionResponse } from "@nyz-rag/types";
import { ApiError, client } from "./webClient";

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

const message = (err: unknown, fallback: string) => err instanceof ApiError ? err.message : fallback;

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
    error.value = message(err, "验证码发送失败，请稍后重试");
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
    error.value = message(err, "请求失败，请检查网络后重试");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="account-backdrop" @click.self="emit('close')">
    <section class="account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-title">
      <header>
        <div><p class="eyebrow">NYZ ACCOUNT</p><h2 id="account-title">{{ titles[mode] }}</h2></div>
        <button class="account-close" aria-label="关闭" @click="emit('close')">×</button>
      </header>
      <p v-if="mode === 'login' || mode === 'register'" class="account-hint">不登录也可以提问，会话仅保存在当前浏览器；登录后当前浏览器中的会话会归入账号，可在其他设备查看。</p>
      <p v-else-if="mode === 'forgot'" class="account-hint">重置密码后，其他设备上的登录将失效。</p>

      <form class="account-form" novalidate @submit.prevent="submit">
        <div v-if="error" class="account-error" role="alert">{{ error }}</div>
        <div v-else-if="info" class="account-info" role="status">{{ info }}</div>

        <label v-if="mode !== 'password'">邮箱
          <input v-model="email" type="email" autocomplete="email" maxlength="254" placeholder="name@example.com" :disabled="busy" />
        </label>
        <label v-if="needsCode">验证码
          <span class="code-row">
            <input v-model="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 位数字" :disabled="busy" />
            <button type="button" class="code-button" :disabled="sending || cooldown > 0 || busy" @click="sendCode">{{ sending ? '发送中…' : cooldown ? `${cooldown} 秒后重发` : '发送验证码' }}</button>
          </span>
        </label>
        <label v-if="mode === 'login'">密码
          <input v-model="password" type="password" autocomplete="current-password" maxlength="1024" :disabled="busy" />
        </label>
        <label v-if="mode === 'password'">当前密码
          <input v-model="currentPassword" type="password" autocomplete="current-password" maxlength="1024" :disabled="busy" />
        </label>
        <template v-if="mode !== 'login'">
          <label>{{ newPasswordLabel }}
            <input v-model="password" type="password" autocomplete="new-password" maxlength="128" placeholder="8～128 个字符" :disabled="busy" />
          </label>
          <label>确认密码
            <input v-model="confirmPassword" type="password" autocomplete="new-password" maxlength="128" :disabled="busy" />
          </label>
        </template>

        <button type="submit" class="account-submit" :disabled="busy">{{ busy ? '请稍候…' : { login: '登录', register: '注册并登录', forgot: '重置密码并登录', password: '保存新密码' }[mode] }}</button>
      </form>

      <footer v-if="mode !== 'password'" class="account-links">
        <template v-if="mode === 'login'">
          <button type="button" @click="emit('update:mode', 'forgot')">忘记密码？</button>
          <button type="button" @click="emit('update:mode', 'register')">没有账号？注册</button>
        </template>
        <button v-else type="button" @click="emit('update:mode', 'login')">← 返回登录</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.account-backdrop{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:20px;background:#1f2a2366}
.account-dialog{width:min(400px,100%);max-height:calc(100vh - 40px);overflow:auto;border:1px solid #e1e6dd;border-radius:9px;background:#fff;padding:22px 24px 18px;box-shadow:0 18px 50px #1c26182b}
.account-dialog header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.account-dialog .eyebrow{margin-bottom:6px}
.account-dialog h2{margin:0;color:#27312b;font-size:19px;font-weight:600}
.account-close{border:0;background:none;color:#8d968f;font-size:22px;line-height:1;cursor:pointer}
.account-hint{margin:10px 0 0;color:#7b857e;font-size:11px;line-height:1.6}
.account-form{display:grid;gap:13px;margin-top:16px}
.account-form label{display:grid;gap:6px;color:#4f5a53;font-size:12px;font-weight:500}
.account-form input{width:100%;min-width:0;height:38px;border:1px solid #dfe4dc;border-radius:5px;background:#fff;padding:0 11px;color:#26302a;font:13px inherit}
.account-form input:focus{outline:2px solid #9aac79;outline-offset:1px}
.account-form input:disabled{background:#f6f7f5}
.code-row{display:flex;gap:8px}
.code-button{flex:none;height:38px;border:1px solid #cdd6c4;border-radius:5px;background:#f5f8ef;color:#46533e;padding:0 11px;font:12px inherit;cursor:pointer}
.code-button:disabled{opacity:.55;cursor:default}
.account-submit{height:40px;margin-top:4px;border:0;border-radius:6px;background:#28332d;color:#fff;font:13px inherit;cursor:pointer}
.account-submit:disabled{opacity:.55;cursor:default}
.account-error,.account-info{padding:8px 10px;border-radius:5px;font-size:12px;line-height:1.5}
.account-error{background:#fbefeb;color:#8a3b2f}
.account-info{background:#f1f5e8;color:#566645}
.account-links{display:flex;justify-content:space-between;gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid #edf0eb}
.account-links button{border:0;background:none;padding:0;color:#687a43;font:12px inherit;cursor:pointer}
.account-links button:hover{text-decoration:underline}
</style>
