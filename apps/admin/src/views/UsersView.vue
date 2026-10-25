<script setup lang="ts">
import { Search } from "@lucide/vue";
import type { AdminUserListResponse, AdminUserRecord, UpdateUserRequest } from "@nyz-rag/types";
import { Button } from "@nyz-rag/ui/components/button";
import { Card } from "@nyz-rag/ui/components/card";
import { confirm } from "@nyz-rag/ui/confirm";
import { Input } from "@nyz-rag/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@nyz-rag/ui/components/table";
import { toast } from "@nyz-rag/ui/lib/toast";
import EmptyState from "../components/EmptyState.vue";
import ListPager from "../components/ListPager.vue";
import PageHeading from "../components/PageHeading.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { usePaginatedList } from "../composables/usePaginatedList";
import { usePending } from "../composables/usePending";
import { can, client, errorMessage, pageSize } from "../workspace";

const { items: users, total, query, page, loading, load: loadUsers, search } = usePaginatedList<AdminUserRecord>({
  pageSize,
  async fetch(params, signal) {
    const data = await client.request<AdminUserListResponse>(`/api/admin/users?${params}`, { signal });
    return { items: data.users, total: data.total };
  },
  onError: () => toast.error("用户列表加载失败，请检查 API 服务"),
});

const { isPending, run } = usePending();

async function toggleUser(user: AdminUserRecord) {
  if (isPending(user.id)) return;
  if (!user.disabled && !await confirm({ title: "停用账号", description: `确定停用账号“${user.email}”？该账号将立即退出登录且不能再登录，会话与问答记录保留。`, confirmText: "停用", destructive: true })) return;
  await run(user.id, async () => {
    try {
      const updated = await client.request<AdminUserRecord>(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !user.disabled } satisfies UpdateUserRequest) });
      users.value = users.value.map((item) => item.id === updated.id ? updated : item);
      toast.success(updated.disabled ? `已停用 ${updated.email}` : `已启用 ${updated.email}`);
    } catch (err) {
      toast.error(errorMessage(err, "账号状态更新失败"));
    }
  });
}
</script>

<template>
  <PageHeading eyebrow="USER ACCOUNTS" title="用户管理" subtitle="查看用户端邮箱注册账号，停用后立即退出登录且不能再登录">
    <span class="font-mono text-xs text-muted-foreground">{{ total }} 个账号</span>
  </PageHeading>
  <Card class="min-h-96 gap-0 overflow-hidden py-0">
    <div class="flex flex-wrap gap-2.5 border-b px-4 py-3.5">
      <label class="relative min-w-0 flex-1">
        <Search class="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input v-model="query" class="pl-8" placeholder="搜索邮箱" aria-label="搜索邮箱" @input="search" />
      </label>
    </div>
    <!-- 手机端（<768px）用下方的摘要列表，与表格共用数据和操作 -->
    <Table class="min-w-[750px]" container-class="max-md:hidden">
      <TableHeader class="bg-muted/50"><TableRow><TableHead class="pl-4">邮箱</TableHead><TableHead>状态</TableHead><TableHead>会话 / 问答</TableHead><TableHead>注册时间</TableHead><TableHead>最近登录</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        <TableRow v-for="user in users" :key="user.id" class="text-[13px] text-muted-foreground">
          <TableCell class="py-3 pl-4 font-semibold text-foreground">{{ user.email }}</TableCell>
          <TableCell><StatusBadge :on="!user.disabled">{{ user.disabled ? '已停用' : '正常' }}</StatusBadge></TableCell>
          <TableCell class="tabular-nums">{{ user.sessionCount }} / {{ user.messageCount }}</TableCell>
          <TableCell>{{ new Date(user.createdAt).toLocaleString() }}</TableCell>
          <TableCell>{{ user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—' }}</TableCell>
          <TableCell>
            <div class="flex justify-end">
              <Button v-if="can('users:manage')" :variant="user.disabled ? 'outline' : 'ghost'" size="sm" :disabled="isPending(user.id)" :class="!user.disabled && 'text-destructive hover:bg-destructive/10 hover:text-destructive'" @click="toggleUser(user)">{{ user.disabled ? '启用' : '停用' }}</Button>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
    <ul class="divide-y md:hidden" aria-label="用户列表">
      <li v-for="user in users" :key="user.id" class="grid gap-2 px-4 py-3 text-xs text-muted-foreground">
        <div class="flex items-start justify-between gap-3">
          <b class="min-w-0 text-sm font-semibold wrap-anywhere text-foreground">{{ user.email }}</b>
          <StatusBadge :on="!user.disabled">{{ user.disabled ? '已停用' : '正常' }}</StatusBadge>
        </div>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>会话 / 问答</dt><dd class="tabular-nums">{{ user.sessionCount }} / {{ user.messageCount }}</dd>
          <dt>注册时间</dt><dd>{{ new Date(user.createdAt).toLocaleString() }}</dd>
          <dt>最近登录</dt><dd>{{ user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—' }}</dd>
        </dl>
        <div v-if="can('users:manage')" class="flex justify-end">
          <Button :variant="user.disabled ? 'outline' : 'ghost'" size="sm" :disabled="isPending(user.id)" :class="!user.disabled && 'text-destructive hover:bg-destructive/10 hover:text-destructive'" @click="toggleUser(user)">{{ user.disabled ? '启用' : '停用' }}</Button>
        </div>
      </li>
    </ul>
    <EmptyState v-if="loading && !users.length">正在加载用户…</EmptyState>
    <EmptyState v-else-if="!users.length">{{ query ? '没有符合条件的账号' : '尚无注册用户' }}</EmptyState>
    <ListPager v-model:page="page" :total="total" unit="个" :disabled="loading" class="mt-auto" @update:page="loadUsers" />
  </Card>
</template>
