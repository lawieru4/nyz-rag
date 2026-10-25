<script setup lang="ts">
import { onMounted, ref } from "vue";
import { LoaderCircle, Plus } from "@lucide/vue";
import type { AdminPermission, AdminRole, SaveAdminRoleRequest, UpdateAdminRoleRequest } from "@nyz-rag/types";
import { Alert, AlertDescription } from "@nyz-rag/ui/components/alert";
import { Badge } from "@nyz-rag/ui/components/badge";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@nyz-rag/ui/components/dialog";
import { Input } from "@nyz-rag/ui/components/input";
import { Label } from "@nyz-rag/ui/components/label";
import { Switch } from "@nyz-rag/ui/components/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { Textarea } from "@nyz-rag/ui/components/textarea";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { hasManage, managePermission, PERMISSION_MODULES, viewPermission, type PermissionModule } from "../permissions";
import { client, errorMessage } from "../workspace";

const roles = ref<AdminRole[]>([]);
const loading = ref(false);
const updating = ref(new Set<string>());
const dialogOpen = ref(false);
const editingId = ref<string | null>(null);
const formBusy = ref(false);
const formError = ref("");
const form = ref<SaveAdminRoleRequest>({ name: "", description: "", permissions: [] });

async function loadRoles() {
  loading.value = true;
  try {
    roles.value = await client.request<AdminRole[]>("/api/admin/roles");
  } catch {
    toast.error("角色列表加载失败，请检查 API 服务");
  } finally {
    loading.value = false;
  }
}
onMounted(loadRoles);

/** 表格中每个模块显示一项：有「管理」显示管理，否则显示查看。 */
function grantedModules(role: AdminRole) {
  return PERMISSION_MODULES.flatMap((item) => {
    if (role.permissions.includes(managePermission(item.module))) return [{ label: item.label, manage: true }];
    return role.permissions.includes(viewPermission(item.module)) ? [{ label: item.label, manage: false }] : [];
  });
}

function openEditor(role?: AdminRole) {
  editingId.value = role?.id ?? null;
  form.value = role
    ? { name: role.name, description: role.description, permissions: [...role.permissions] }
    : { name: "", description: "", permissions: [] };
  formError.value = "";
  dialogOpen.value = true;
}

const granted = (permission: AdminPermission) => form.value.permissions.includes(permission);

// 「管理」包含「查看」：开启管理时一并开启查看，关闭查看时一并关闭管理。
function setPermission(item: PermissionModule, action: "view" | "manage", on: boolean) {
  const view = viewPermission(item.module);
  const manage = managePermission(item.module);
  const next = new Set(form.value.permissions);
  if (on) {
    next.add(view);
    if (action === "manage") next.add(manage);
  } else {
    next.delete(manage);
    if (action === "view") next.delete(view);
  }
  form.value.permissions = PERMISSION_MODULES
    .flatMap((module) => [viewPermission(module.module), ...(hasManage(module) ? [managePermission(module.module)] : [])])
    .filter((permission) => next.has(permission));
}

async function saveRole() {
  const name = form.value.name.trim();
  if (!name) { formError.value = "请输入角色名称"; return; }
  formError.value = "";
  formBusy.value = true;
  const editing = editingId.value;
  try {
    const saved = await client.request<AdminRole>(`/api/admin/roles${editing ? `/${editing}` : ""}`, {
      method: editing ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: form.value.description.trim(), permissions: form.value.permissions } satisfies SaveAdminRoleRequest),
    });
    roles.value = editing ? roles.value.map((role) => role.id === saved.id ? saved : role) : [...roles.value, saved];
    dialogOpen.value = false;
    toast.success(editing ? `角色 ${saved.name} 已保存` : `角色 ${saved.name} 已创建`);
  } catch (err) {
    formError.value = errorMessage(err, "保存失败，请检查 API 服务");
  } finally {
    formBusy.value = false;
  }
}

async function toggleRole(role: AdminRole) {
  if (updating.value.has(role.id)) return;
  const willDisable = !role.disabled;
  if (willDisable && !await confirm({
    title: "停用角色",
    description: role.adminCount
      ? `确定停用角色"${role.name}"？使用该角色的 ${role.adminCount} 位管理员将立即失去全部模块权限（仍可登录并修改个人资料）。`
      : `确定停用角色"${role.name}"？`,
    confirmText: "停用",
    destructive: true,
  })) return;
  if (updating.value.has(role.id)) return;
  updating.value.add(role.id);
  try {
    const updated = await client.request<AdminRole>(`/api/admin/roles/${role.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: willDisable } satisfies UpdateAdminRoleRequest),
    });
    roles.value = roles.value.map((item) => item.id === updated.id ? updated : item);
    toast.success(updated.disabled ? `已停用 ${updated.name}` : `已启用 ${updated.name}`);
  } catch (err) {
    toast.error(errorMessage(err, "角色状态更新失败"));
  } finally {
    updating.value.delete(role.id);
  }
}

async function deleteRole(role: AdminRole) {
  if (role.adminCount || updating.value.has(role.id)) return;
  if (!await confirm({ title: "删除角色", description: `确定删除角色"${role.name}"？`, confirmText: "删除", destructive: true })) return;
  updating.value.add(role.id);
  try {
    await client.request(`/api/admin/roles/${role.id}`, { method: "DELETE" });
    roles.value = roles.value.filter((item) => item.id !== role.id);
    toast.success(`已删除 ${role.name}`);
  } catch (err) {
    toast.error(errorMessage(err, "删除失败"));
  } finally {
    updating.value.delete(role.id);
  }
}
</script>

<template>
  <PageHeading eyebrow="ADMINISTRATOR ROLES" title="角色管理" subtitle="为普通管理员分配可查看与管理的模块，仅超级管理员可见">
    <Button @click="openEditor()"><Plus /> 新建角色</Button>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <Table class="min-w-[760px]">
      <TableHeader class="bg-muted/50">
        <TableRow>
          <TableHead class="pl-4">角色</TableHead>
          <TableHead>权限</TableHead>
          <TableHead>管理员</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>更新时间</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="role in roles" :key="role.id" class="text-[13px] text-muted-foreground">
          <TableCell class="max-w-56 py-3 pl-4">
            <div class="grid gap-0.5">
              <b class="truncate font-semibold text-foreground">{{ role.name }}</b>
              <small v-if="role.description" class="truncate text-xs" :title="role.description">{{ role.description }}</small>
            </div>
          </TableCell>
          <TableCell class="max-w-96 whitespace-normal">
            <div v-if="grantedModules(role).length" class="flex flex-wrap gap-1">
              <Badge v-for="item in grantedModules(role)" :key="item.label" :variant="item.manage ? 'brand' : 'muted'">{{ item.label }} · {{ item.manage ? '管理' : '查看' }}</Badge>
            </div>
            <span v-else class="text-muted-foreground">无权限</span>
          </TableCell>
          <TableCell class="font-mono">{{ role.adminCount }}</TableCell>
          <TableCell><StatusBadge :on="!role.disabled">{{ role.disabled ? '已停用' : '正常' }}</StatusBadge></TableCell>
          <TableCell>{{ new Date(role.updatedAt).toLocaleString() }}</TableCell>
          <TableCell>
            <div class="flex justify-end gap-1">
              <Button variant="ghost" size="sm" :disabled="updating.has(role.id)" @click="openEditor(role)">编辑</Button>
              <Button
                :variant="role.disabled ? 'outline' : 'ghost'"
                size="sm"
                :disabled="updating.has(role.id)"
                :aria-busy="updating.has(role.id)"
                :class="!role.disabled && 'text-destructive hover:bg-destructive/10 hover:text-destructive'"
                @click="toggleRole(role)"
              >
                {{ role.disabled ? '启用' : '停用' }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                :disabled="role.adminCount > 0 || updating.has(role.id)"
                :title="role.adminCount ? '仍有管理员使用该角色，请先为他们更换角色' : undefined"
                @click="deleteRole(role)"
              >
                删除
              </Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <EmptyState v-if="loading && !roles.length">正在加载角色…</EmptyState>
    <EmptyState v-else-if="!roles.length">尚未创建角色 <Button variant="link" size="sm" class="text-link" @click="openEditor()">创建第一个角色</Button></EmptyState>
  </Card>

  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-xl" :aria-describedby="undefined">
      <DialogHeader>
        <p class="font-mono text-[11px] font-medium tracking-wider text-link">ROLE</p>
        <DialogTitle>{{ editingId ? '编辑角色' : '新建角色' }}</DialogTitle>
      </DialogHeader>
      <form class="grid gap-4" novalidate @submit.prevent="saveRole">
        <Alert v-if="formError" variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{{ formError }}</AlertDescription>
        </Alert>
        <div class="grid gap-2">
          <Label for="role-name">名称</Label>
          <Input id="role-name" v-model="form.name" type="text" autocomplete="off" required maxlength="50" :disabled="formBusy" placeholder="如：内容运营" aria-required="true" />
        </div>
        <div class="grid gap-2">
          <Label for="role-description">说明</Label>
          <Textarea id="role-description" v-model="form.description" rows="2" maxlength="200" :disabled="formBusy" placeholder="可选" />
        </div>
        <fieldset class="grid gap-2" :disabled="formBusy">
          <legend class="mb-2 text-sm font-medium">权限</legend>
          <div class="overflow-hidden rounded-md border">
            <div class="grid grid-cols-[1fr_3rem_3rem] items-center gap-x-3 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <span>模块</span><span class="text-center">查看</span><span class="text-center">管理</span>
            </div>
            <div v-for="item in PERMISSION_MODULES" :key="item.module" class="grid grid-cols-[1fr_3rem_3rem] items-center gap-x-3 border-t px-3 py-2.5">
              <div class="grid min-w-0 gap-0.5">
                <span class="text-xs font-medium">{{ item.label }}</span>
                <small class="text-xs text-muted-foreground">查看：{{ item.view }}<template v-if="hasManage(item)">；管理：{{ item.manage }}</template></small>
              </div>
              <div class="flex justify-center">
                <Switch :model-value="granted(viewPermission(item.module))" :aria-label="`${item.label}：查看`" @update:model-value="setPermission(item, 'view', $event)" />
              </div>
              <div class="flex justify-center">
                <Switch v-if="hasManage(item)" :model-value="granted(managePermission(item.module))" :aria-label="`${item.label}：管理`" @update:model-value="setPermission(item, 'manage', $event)" />
                <span v-else class="text-muted-foreground/50" aria-hidden="true">—</span>
              </div>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">「管理」包含「查看」。管理员与角色管理仅限超级管理员，不能通过角色授予；修改后立即对使用该角色的管理员生效。</p>
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" :disabled="formBusy" @click="dialogOpen = false">取消</Button>
          <Button type="submit" :disabled="formBusy" :aria-busy="formBusy">
            <LoaderCircle v-if="formBusy" class="animate-spin" aria-hidden="true" />
            {{ formBusy ? '保存中…' : editingId ? '保存角色' : '创建角色' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
