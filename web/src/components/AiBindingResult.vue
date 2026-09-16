<script setup lang="ts">
// 下发结果视图（受控）：BatchResult 表格 + 「返回编辑」按钮。绑定保存与工具自身配置
// 保存共用——从 AiBindingTab 抽出，展示逻辑原样。
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-vue-next'
import type { BatchResult } from '@/lib/api'

defineProps<{ result: BatchResult }>()
const emit = defineEmits<{ (e: 'back'): void }>()
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h3 class="text-sm font-medium">下发结果</h3>
      <span class="text-sm text-emerald-500">成功 {{ result.ok }}</span>
      <span class="text-sm text-destructive">失败 {{ result.failed }}</span>
      <span class="text-sm text-muted-foreground">共 {{ result.total }}</span>
    </div>
    <div class="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow class="bg-muted/50">
            <TableHead class="h-8 text-xs font-medium">目标</TableHead>
            <TableHead class="h-8 text-xs font-medium">结果</TableHead>
            <TableHead class="h-8 text-xs font-medium">输出</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="it in result.items" :key="it.id" class="align-top">
            <TableCell class="font-mono text-xs">{{ it.name }}</TableCell>
            <TableCell class="text-xs">
              <span v-if="it.ok" class="text-emerald-500">ok</span>
              <span v-else class="text-destructive">fail ({{ it.exitCode }})</span>
            </TableCell>
            <TableCell class="text-xs">
              <div v-if="it.error" class="text-destructive">{{ it.error }}</div>
              <pre
                v-if="it.stdout"
                class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground"
                >{{ it.stdout.trim() }}</pre
              >
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <div class="flex justify-end">
      <Button variant="outline" @click="emit('back')"><ArrowLeft class="size-3.5" /> 返回编辑</Button>
    </div>
  </div>
</template>
