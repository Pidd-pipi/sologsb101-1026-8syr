<script setup lang="ts">
/** 两台平板断网补录：outbox 暂存、单条 / 一键合并，重叠时段合并后并列待确认 */
import { computed } from 'vue'
import { Connection } from '@element-plus/icons-vue'
import type { PumpBackfillRow, TankRow } from '@/utils/db'
import { fmtClock, fmtDay } from '@/hooks/usePumpBoard'

const props = defineProps<{
  backfill: PumpBackfillRow[]
  tanksById: Map<string, TankRow>
}>()

const emit = defineEmits<{
  (e: 'merge', id: string): void
  (e: 'mergeAll'): void
}>()

const pending = computed(() => props.backfill.filter((b) => b.state === '待合并'))
const done = computed(() => props.backfill.filter((b) => b.state !== '待合并'))

function tankCode(id: string | undefined): string {
  return id ? props.tanksById.get(id)?.code ?? '已删罐' : '—'
}
</script>

<template>
  <div>
    <div class="bf-head">
      <span class="muted">断网时两台平板先各自暂存，恢复网络后合并进占用账；倒罐派工撞期会并列待确认。</span>
      <el-button type="primary" size="small" :icon="Connection" :disabled="pending.length === 0" @click="emit('mergeAll')">
        一键合并全部（{{ pending.length }}）
      </el-button>
    </div>

    <el-empty v-if="backfill.length === 0" description="暂无断网补录" :image-size="60" />

    <el-table v-else :data="[...pending, ...done]" stripe border size="small">
      <el-table-column label="设备" width="80">
        <template #default="{ row }">
          <el-tag size="small" :type="row.device === '平板A' ? 'primary' : 'success'">{{ row.device }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100" prop="kind" />
      <el-table-column label="发生时间" width="150">
        <template #default="{ row }">{{ fmtDay(row.occurredAt) }} {{ fmtClock(row.occurredAt) }}</template>
      </el-table-column>
      <el-table-column label="内容" min-width="240">
        <template #default="{ row }">
          <template v-if="row.kind === '液位补录' && row.liquid">
            {{ tankCode(row.liquid.tankId) }}
            <span :class="row.liquid.deltaL >= 0 ? 'pos' : 'neg'">
              {{ row.liquid.deltaL >= 0 ? '+' : '' }}{{ row.liquid.deltaL }}L
            </span>
            · {{ row.liquid.reason }}
          </template>
          <template v-else-if="row.job">
            {{ tankCode(row.job.sourceTankId) }} → {{ tankCode(row.job.targetTankId) }} · {{ row.job.volumeL }}L ·
            {{ fmtDay(row.job.requestedStartAt) }} {{ fmtClock(row.job.requestedStartAt) }}
          </template>
        </template>
      </el-table-column>
      <el-table-column label="状态 / 结果" min-width="220">
        <template #default="{ row }">
          <el-tag size="small" :type="row.state === '待合并' ? 'warning' : row.state === '冲突待确认' ? 'danger' : 'success'">
            {{ row.state }}
          </el-tag>
          <span v-if="row.resultNote" class="note">{{ row.resultNote }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.state === '待合并'" link type="primary" size="small" @click="emit('merge', row.id)">
            合并
          </el-button>
          <span v-else class="muted">已处理</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.bf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.pos {
  color: #2f7d3f;
  font-weight: 700;
}

.neg {
  color: #c0392b;
  font-weight: 700;
}

.note {
  margin-left: 8px;
  font-size: 12px;
  color: #8c8479;
}

.muted {
  color: #8c8479;
  font-size: 12px;
}
</style>
