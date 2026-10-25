<script setup lang="ts">
import { onMounted, ref } from "vue";
import { LoaderCircle, Plus } from "@lucide/vue";
import type { AdminAccount, AdminRole, CreateAdminRequest, UpdateAdminRequest } from "@nyz-rag/types";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nyz-rag/ui/components/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { validateAdminIdentity, validateAdminPassword } from "../admin-validation";
import { client, errorMessage } from "../workspace";

// reka-ui 的 SelectItem 不接受空字符串，“未分配角色”用哨兵值表示。
const NO_ROLE = "__none__";

const admins = ref<AdminAccount[]>([]);
const roles = ref<AdminRole[]>([]);
const loading = ref(false);
const updating = ref(new Set<string>());
const dialogOpen = ref(false);
const formBusy = ref(false);
const formError = ref("");
const form = ref<CreateAdminRequest & { roleId: string }>({ email: "", nickname: "", password: "", roleId: NO_ROLE });

async function loadAdmins() {
  loading.value = true;
  try {
    [admins.value, roles.value] = await Promise.all([
      client.request<AdminAccount[]>("/api/admin/admins"),
      client.request<AdminRole[]>("/api/admin/roles"),
    ]);
  } catch {
    toast.error("管理员列表加载失败，请检查 API 服务");
  } finally {
    loading.value = false;
  }
}
onMounted(loadAdmins);

const roleOptionLabel = (role: AdminRole) => role.disabled ? `${role.name}（已停用）` : role.name;

function openCreate() {
  form.value = { email: "", nickname: "", password: "", roleId: roles.value.find((role) => !role.disabled)?.id ?? NO_ROLE };
  formError.value = "";
  dialogOpen.value = true;
}

async function createAdmin() {
  const err = validateAdminIdentity(form.value) || validateAdminPassword(form.value.password, "密码");
  if (err) { formError.value = err; return; }
  formError.value = "";
  formBusy.value = true;
  try {
    const created = await client.request<AdminAccount>("/api/admin/admins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.value.email.trim(), nickname: form.value.nickname.trim(), password: form.value.password,
        roleId: form.value.roleId === NO_ROLE ? null : form.value.roleId,
      } satisfies CreateAdminRequest),
    });
    admins.value = [...admins.value, created];
    form.value = { email: "", nickname: "", password: "", roleId: NO_ROLE };
    dialogOpen.value = false;
    toast.success(`管理员 ${created.nickname} 已创建`);
  } catch (err) {
    formError.value = errorMessage(err, "创建失败，请检查 API 服务");
  } finally {
    formBusy.value = false;
  }
}

async function changeRole(admin: AdminAccount, value: string) {
  const roleId = value === NO_ROLE ? null : value;
  if (admin.isSuper || roleId === admin.roleId || updating.value.has(admin.id)) return;
  updating.value.add(admin.id);
  try {
    const updated = await client.request<AdminAccount>(`/api/admin/admins/${admin.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roleId } satisfies UpdateAdminRequest),
    });
    admins.value = admins.value.map((a) => a.id === updated.id ? updated : a);
    toast.success(updated.roleName ? `${updated.nickname} 的角色已改为 ${updated.roleName}` : `已取消 ${updated.nickname} 的角色`);
  } catch (err) {
    toast.error(errorMessage(err, "角色更新失败"));
  } finally {
    updating.value.delete(admin.id);
  }
}

async function toggleAdmin(admin: AdminAccount) {
  if (admin.isSuper || updating.value.has(admin.id)) return;
  const willDisable = !admin.disabled;
  if (willDisable && !await confirm({
    title: "停用管理员账号",
    description: `确定停用管理员"${admin.nickname}"（${admin.email}）？该账号将立即退出登录且不能再登录。`,
    confirmText: "停用",
    destructive: true,
  })) return;
  if (updating.value.has(admin.id)) return;
  updating.value.add(admin.id);
  try {
    const updated = await client.request<AdminAccount>(`/api/admin/admins/${admin.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: willDisable } satisfies UpdateAdminRequest),
    });
    admins.value = admins.value.map((a) => a.id === updated.id ? updated : a);
    toast.success(updated.disabled ? `已停用 ${updated.nickname}` : `已启用 ${updated.nickname}`);
  } catch (err) {
    toast.error(errorMessage(err, "账号状态更新失败"));
  } finally {
    updating.value.delete(admin.id);
  }
}
</script>

<template>
  <PageHeading eyebrow="ADMINISTRATOR ACCOUNTS" title="管理员管理" subtitle="管理后台管理员账号与角色，仅超级管理员可见；未分配角色的管理员只能修改个人资料">
    <Button @click="openCreate"><Plus /> 添加管理员</Button>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <!-- 手机端（<768px）用下方的摘要列表，与表格共用数据和操作 -->
    <Table class="min-w-[640px]" container-class="max-md:hidden">
      <TableHeader class="bg-muted/50">
        <TableRow>
          <TableHead class="pl-4">昵称</TableHead>
          <TableHead>邮箱</TableHead>
          <TableHead>角色</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>创建时间</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="admin in admins" :key="admin.id" class="text-[13px] text-muted-foreground">
          <TableCell class="py-3 pl-4 font-semibold text-foreground">{{ admin.nickname }}</TableCell>
          <TableCell>{{ admin.email }}</TableCell>
          <TableCell>
            <span v-if="admin.isSuper" class="rounded-sm bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">超级管理员</span>
            <Select v-else :model-value="admin.roleId ?? NO_ROLE" :disabled="updating.has(admin.id)" @update:model-value="changeRole(admin, String($event))">
              <SelectTrigger size="sm" class="min-w-32 text-xs" :aria-label="`${admin.nickname} 的角色`"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="NO_ROLE">未分配角色</SelectItem>
                <SelectItem v-for="role in roles" :key="role.id" :value="role.id">{{ roleOptionLabel(role) }}</SelectItem>
              </SelectContent>
            </Select>
          </TableCell>
          <TableCell>
            <StatusBadge :on="!admin.disabled">{{ admin.disabled ? '已停用' : '正常' }}</StatusBadge>
          </TableCell>
          <TableCell>{{ new Date(admin.createdAt).toLocaleString() }}</TableCell>
          <TableCell>
            <div class="flex justify-end">
              <Button
                v-if="!admin.isSuper"
                :variant="admin.disabled ? 'outline' : 'ghost'"
                size="sm"
                :disabled="updating.has(admin.id)"
                :aria-busy="updating.has(admin.id)"
                :class="!admin.disabled && 'text-destructive hover:bg-destructive/10 hover:text-destructive'"
                @click="toggleAdmin(admin)"
              >
                {{ admin.disabled ? '启用' : '停用' }}
              </Button>
              <span v-else class="pr-2 text-xs text-muted-foreground">不可停用</span>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <ul class="divide-y md:hidden" aria-label="管理员列表">
      <li v-for="admin in admins" :key="admin.id" class="grid gap-2.5 px-4 py-3 text-xs text-muted-foreground">
        <div class="flex items-start justify-between gap-3">
          <span class="grid min-w-0 gap-0.5"><b class="text-sm font-semibold break-words text-foreground">{{ admin.nickname }}</b><span class="wrap-anywhere">{{ admin.email }}</span></span>
          <StatusBadge :on="!admin.disabled">{{ admin.disabled ? '已停用' : '正常' }}</StatusBadge>
        </div>
        <span>创建于 {{ new Date(admin.createdAt).toLocaleString() }}</span>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span v-if="admin.isSuper" class="rounded-sm bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-foreground">超级管理员</span>
          <Select v-else :model-value="admin.roleId ?? NO_ROLE" :disabled="updating.has(admin.id)" @update:model-value="changeRole(admin, String($event))">
            <SelectTrigger size="sm" class="min-w-0 flex-1 text-xs" :aria-label="`${admin.nickname} 的角色`"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NO_ROLE">未分配角色</SelectItem>
              <SelectItem v-for="role in roles" :key="role.id" :value="role.id">{{ roleOptionLabel(role) }}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            v-if="!admin.isSuper"
            :variant="admin.disabled ? 'outline' : 'ghost'"
            size="sm"
            :disabled="updating.has(admin.id)"
            :aria-busy="updating.has(admin.id)"
            :class="!admin.disabled && 'text-destructive hover:bg-destructive/10 hover:text-destructive'"
            @click="toggleAdmin(admin)"
          >
            {{ admin.disabled ? '启用' : '停用' }}
          </Button>
          <span v-else class="text-muted-foreground">不可停用</span>
        </div>
      </li>
    </ul>
    <EmptyState v-if="loading && !admins.length">正在加载管理员…</EmptyState>
    <EmptyState v-else-if="!admins.length">尚无管理员账号</EmptyState>
  </Card>

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-md" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[11px] font-medium tracking-wider text-link">ADMINISTRATOR</p>
        <DialogTitle>添加管理员</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" novalidate @submit.prevent="createAdmin">
        <Alert v-if="formError" variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{{ formError }}</AlertDescription>
        </Alert>
        <div class="grid gap-2">
          <Label for="ca-email">邮箱</Label>
          <Input id="ca-email" v-model="form.email" type="email" autocomplete="off" required :disabled="formBusy" placeholder="admin@example.com" aria-required="true" />
        </div>
        <div class="grid gap-2">
          <Label for="ca-nickname">昵称</Label>
          <Input id="ca-nickname" v-model="form.nickname" type="text" autocomplete="off" required maxlength="100" :disabled="formBusy" placeholder="显示名称" aria-required="true" />
        </div>
        <div class="grid gap-2">
          <Label for="ca-role">角色</Label>
          <Select v-model="form.roleId" :disabled="formBusy">
            <SelectTrigger id="ca-role" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NO_ROLE">未分配角色</SelectItem>
              <SelectItem v-for="role in roles" :key="role.id" :value="role.id">{{ roleOptionLabel(role) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid gap-2">
          <Label for="ca-password">密码</Label>
          <Input id="ca-password" v-model="form.password" type="password" autocomplete="new-password" required minlength="8" maxlength="1024" :disabled="formBusy" placeholder="至少 8 个字符" aria-required="true" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="formBusy" @click="dialogOpen = false">取消</Button>
          <Button type="submit" :disabled="formBusy" :aria-busy="formBusy">
            <LoaderCircle v-if="formBusy" class="animate-spin" aria-hidden="true" />
            {{ formBusy ? '创建中…' : '创建管理员' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
