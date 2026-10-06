<script setup lang="ts">
/** 写入前快照：每次罐号改动 / 撤单 / 重排 / 合并落库前自动留存，可从当时快照恢复 */
import { ElMessageBox } from 'element-plus'
import type { PumpSnapshotRow } from '@/utils/db'
import { fmtClock, fmtDay } from '@/hooks/usePumpBoard'

const props = defineProps<{
  snapshots: PumpSnapshotRow[]
}>()

const emit = defineEmits<{
  (e: 'restore', id: string): void
  (e: 'remove', id: string): void
}>()

async function restore(row: PumpSnapshotRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将把占用账、补录队列与罐号恢复到快照「${row.label}」（${fmtDay(row.createdAt)} ${fmtClock(row.createdAt)}），是否继续？`,
      '从快照恢复',
      { type: 'warning', confirmButtonText: '恢复到此时刻' }
    )
  } catch {
    return
  }
  emit('restore', row.id)
}

function pendingCount(row: PumpSnapshotRow): number {
  return row.outbox.filter((b) => b.state === '待合并').length
}
</script>

<template>
  <el-table :data="props.snapshots" stripe border size="small" max-height="300">
    <el-table-column label="快照动作" prop="label" min-width="220" />
    <el-table-column label="拍摄时刻" width="180">
      <template #default="{ row }">{{ fmtDay(row.createdAt) }} {{ fmtClock(row.createdAt) }}</template>
    </el-table-column>
    <el-table-column label="账面条目" width="100" align="right">
      <template #default="{ row }">{{ row.ledger.length }}</template>
    </el-table-column>
    <el-table-column label="待合并补录" width="110" align="right">
      <template #default="{ row }">{{ pendingCount(row) }}</template>
    </el-table-column>
    <el-table-column label="操作" width="150" fixed="right">
      <template #default="{ row }">
        <el-button link type="primary" size="small" @click="restore(row)">恢复</el-button>
        <el-button link type="danger" size="small" @click="emit('remove', row.id)">删除</el-button>
      </template>
    </el-table-column>
  </el-table>
</template>
