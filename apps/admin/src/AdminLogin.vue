<script setup lang="ts">
import { ref } from "vue";

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
  <div class="login-shell">
    <div class="login-card">
      <div class="login-brand">
        <span class="brand-mark">N</span>
        <div>
          <span class="brand-name">NYZ <b>KNOWLEDGE OPS</b></span>
          <span class="brand-sub">管理后台</span>
        </div>
      </div>

      <form class="login-form" @submit.prevent="handleSubmit" novalidate>
        <h1 class="login-title">登录</h1>

        <div v-if="error" class="login-error" role="alert" aria-live="assertive">
          {{ error }}
        </div>

        <label class="login-label">
          <span>用户名</span>
          <input
            v-model="username"
            type="text"
            name="username"
            autocomplete="username"
            required
            :disabled="busy"
            placeholder="请输入用户名"
            aria-required="true"
          />
        </label>

        <label class="login-label">
          <span>密码</span>
          <input
            v-model="password"
            type="password"
            name="password"
            autocomplete="current-password"
            required
            :disabled="busy"
            placeholder="请输入密码"
            aria-required="true"
          />
        </label>

        <button type="submit" class="login-submit" :disabled="busy" :aria-busy="busy">
          <span v-if="busy" class="login-spinner" aria-hidden="true">↻</span>
          {{ busy ? "验证中…" : "登录" }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f4f6f3;
  padding: 16px;
}

.login-card {
  width: 100%;
  max-width: 400px;
  background: #fff;
  border: 1px solid #dfe5df;
  border-radius: 10px;
  padding: 40px 36px 36px;
  box-shadow: 0 2px 12px rgba(32, 42, 38, 0.07);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 36px;
}

.brand-mark {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: #c9e07b;
  color: #29341e;
  display: grid;
  place-items: center;
  font-size: 16px;
  font-weight: 700;
  flex: none;
}

.brand-name {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: #202a26;
}

.brand-name b {
  color: #89958e;
  font-family: "DM Mono", monospace;
  font-weight: 500;
  font-size: 9px;
  display: block;
  margin-top: 3px;
}

.brand-sub {
  display: block;
  font-size: 10px;
  color: #97a59d;
  font-family: "DM Mono", monospace;
  margin-top: 2px;
}

.login-title {
  margin: 0 0 22px;
  font-size: 20px;
  font-weight: 700;
  color: #1f2c24;
}

.login-form {
  display: grid;
  gap: 16px;
}

.login-error {
  padding: 10px 14px;
  border-radius: 5px;
  background: #fdf2f1;
  border: 1px solid #f0c8c2;
  color: #9b4638;
  font-size: 12px;
  line-height: 1.5;
}

.login-label {
  display: grid;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  color: #536057;
}

.login-label input {
  height: 40px;
  padding: 0 12px;
  border: 1px solid #dfe5df;
  border-radius: 5px;
  background: #f9fbf8;
  color: #1f2c24;
  font-size: 13px;
  transition: border-color 0.15s;
}

.login-label input:focus {
  outline: none;
  border-color: #8ab87a;
  background: #fff;
}

.login-label input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.login-submit {
  margin-top: 6px;
  height: 42px;
  background: #557c5c;
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s;
}

.login-submit:hover:not(:disabled) {
  background: #44674b;
}

.login-submit:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.login-spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
  font-size: 16px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .login-card {
    padding: 28px 20px 24px;
  }
}
</style>
