<script setup lang="ts">
import { ref } from "vue";
import { LoaderCircle } from "@lucide/vue";
import type { AdminSession, ChangeAdminPasswordRequest, UpdateAdminProfileRequest } from "@nyz-rag/types";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { toast } from "@nyz-rag/ui/lib/toast";
import PageHeading from "../components/PageHeading.vue";
import { client, errorMessage } from "../workspace";

const props = defineProps<{ session: AdminSession }>();
const emit = defineEmits<{
  (e: "session-updated", session: AdminSession): void;
  (e: "logout-required"): void;
}>();

// Profile form
const profileBusy = ref(false);
const profileError = ref("");
const profileForm = ref<UpdateAdminProfileRequest>({
  email: props.session.admin.email,
  nickname: props.session.admin.nickname,
});

async function saveProfile() {
  if (!profileForm.value.email.trim()) { profileError.value = "请输入邮箱"; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profileForm.value.email.trim())) { profileError.value = "邮箱格式不正确"; return; }
  if (!profileForm.value.nickname.trim()) { profileError.value = "请输入昵称"; return; }
  profileError.value = "";
  profileBusy.value = true;
  try {
    const updated = await client.request<AdminSession>("/api/admin/auth/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: profileForm.value.email.trim(), nickname: profileForm.value.nickname.trim() }),
    });
    emit("session-updated", updated);
    toast.success("个人资料已更新");
  } catch (err) {
    profileError.value = errorMessage(err, "保存失败，请检查 API 服务");
  } finally {
    profileBusy.value = false;
  }
}

// Password form
const passwordBusy = ref(false);
const passwordError = ref("");
const passwordForm = ref<ChangeAdminPasswordRequest & { confirmPassword: string }>({
  currentPassword: "",
  newPassword: "",
  confirmPassword: "",
});

async function changePassword() {
  if (!passwordForm.value.currentPassword) { passwordError.value = "请输入当前密码"; return; }
  if (!passwordForm.value.newPassword) { passwordError.value = "请输入新密码"; return; }
  if (passwordForm.value.newPassword.length < 8) { passwordError.value = "新密码至少 8 个字符"; return; }
  if (passwordForm.value.newPassword.length > 1024) { passwordError.value = "新密码不能超过 1024 个字符"; return; }
  if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) { passwordError.value = "两次输入的新密码不一致"; return; }
  passwordError.value = "";
  passwordBusy.value = true;
  try {
    await client.request("/api/admin/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: passwordForm.value.currentPassword, newPassword: passwordForm.value.newPassword }),
    });
    toast.success("密码已修改，请重新登录");
    emit("logout-required");
  } catch (err) {
    passwordError.value = errorMessage(err, "密码修改失败，请检查 API 服务");
  } finally {
    passwordBusy.value = false;
  }
}
</script>

<template>
  <PageHeading eyebrow="MY ACCOUNT" title="个人资料" subtitle="修改邮箱、昵称或密码；修改密码后需重新登录" />

  <div class="grid gap-6 lg:grid-cols-2">
    <!-- Profile info -->
    <Card class="gap-0 py-0">
      <div class="border-b px-5 py-4">
        <h2 class="text-sm font-semibold">基本信息</h2>
        <p class="mt-1 text-xs text-muted-foreground">修改邮箱或昵称后立即生效</p>
      </div>
      <form class="grid gap-4 p-5" novalidate @submit.prevent="saveProfile">
        <Alert v-if="profileError" variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{{ profileError }}</AlertDescription>
        </Alert>
        <div class="grid gap-2">
          <Label for="pf-email">邮箱</Label>
          <Input id="pf-email" v-model="profileForm.email" type="email" autocomplete="email" required :disabled="profileBusy" />
        </div>
        <div class="grid gap-2">
          <Label for="pf-nickname">昵称</Label>
          <Input id="pf-nickname" v-model="profileForm.nickname" type="text" autocomplete="nickname" required maxlength="100" :disabled="profileBusy" />
        </div>
        <div class="flex justify-end">
          <Button type="submit" :disabled="profileBusy" :aria-busy="profileBusy">
            <LoaderCircle v-if="profileBusy" class="animate-spin" aria-hidden="true" />
            {{ profileBusy ? '保存中…' : '保存资料' }}
          </Button>
        </div>
      </form>
    </Card>

    <!-- Password change -->
    <Card class="gap-0 py-0">
      <div class="border-b px-5 py-4">
        <h2 class="text-sm font-semibold">修改密码</h2>
        <p class="mt-1 text-xs text-muted-foreground">修改后当前会话立即失效，需重新登录</p>
      </div>
      <form class="grid gap-4 p-5" novalidate @submit.prevent="changePassword">
        <Alert v-if="passwordError" variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{{ passwordError }}</AlertDescription>
        </Alert>
        <div class="grid gap-2">
          <Label for="pw-current">当前密码</Label>
          <Input id="pw-current" v-model="passwordForm.currentPassword" type="password" autocomplete="current-password" required :disabled="passwordBusy" />
        </div>
        <div class="grid gap-2">
          <Label for="pw-new">新密码</Label>
          <Input id="pw-new" v-model="passwordForm.newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="passwordBusy" placeholder="至少 8 个字符" />
        </div>
        <div class="grid gap-2">
          <Label for="pw-confirm">确认新密码</Label>
          <Input id="pw-confirm" v-model="passwordForm.confirmPassword" type="password" autocomplete="new-password" required :disabled="passwordBusy" />
        </div>
        <div class="flex justify-end">
          <Button type="submit" :disabled="passwordBusy" :aria-busy="passwordBusy">
            <LoaderCircle v-if="passwordBusy" class="animate-spin" aria-hidden="true" />
            {{ passwordBusy ? '修改中…' : '修改密码' }}
          </Button>
        </div>
      </form>
    </Card>
  </div>
</template>
