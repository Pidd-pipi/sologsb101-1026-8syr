<script setup lang="ts">
/** 共用一张占用账：发酵罐液体 / 泵机时段租约 / 倒罐作业三类条目同表列示 */
import { computed, ref } from 'vue'
import type { PumpLedgerRow, TankRow } from '@/utils/db'
import { fmtClock, fmtDay } from '@/hooks/usePumpBoard'

const props = defineProps<{
  ledger: PumpLedgerRow[]
  tanksById: Map<string, TankRow>
}>()

const kindFilter = ref<'全部' | 'liquid' | 'lease' | 'job'>('全部')

const filtered = computed(() => {
  const list = kindFilter.value === '全部' ? props.ledger : props.ledger.filter((r) => r.kind === kindFilter.value)
  return list.slice().sort((a, b) => {
    const ta = a.kind === 'liquid' ? a.at : a.kind === 'lease' ? a.startAt : a.submittedAt
    const tb = b.kind === 'liquid' ? b.at : b.kind === 'lease' ? b.startAt : b.submittedAt
    return tb.localeCompare(ta)
  })
})

function tankCode(id: string): string {
  return props.tanksById.get(id)?.code ?? '已删罐'
}

function timeOf(row: PumpLedgerRow): string {
  if (row.kind === 'liquid') return `${fmtDay(row.at)} ${fmtClock(row.at)}`
  if (row.kind === 'lease') return `${fmtDay(row.startAt)} ${fmtClock(row.startAt)}–${fmtClock(row.endAt)}`
  return `${fmtDay(row.submittedAt)} ${fmtClock(row.submittedAt)}`
}

const kindLabel = computed<Record<PumpLedgerRow['kind'], string>>(() => ({
  liquid: '罐液体',
  lease: '泵机时段',
  job: '倒罐作业'
}))

const kindType = computed<Record<PumpLedgerRow['kind'], 'primary' | 'success' | 'warning'>>(() => ({
  liquid: 'success',
  lease: 'warning',
  job: 'primary'
}))
</script>

<template>
  <div>
    <div class="ledger-filter">
      <el-radio-group v-model="kindFilter" size="small">
        <el-radio-button label="全部">全部</el-radio-button>
        <el-radio-button label="liquid">发酵罐液体</el-radio-button>
        <el-radio-button label="lease">泵机时段</el-radio-button>
        <el-radio-button label="job">倒罐作业</el-radio-button>
      </el-radio-group>
      <span class="muted">同一泵机时段只保留先提交的租约；三类对象共用这张账</span>
    </div>

    <el-table :data="filtered" stripe border size="small" max-height="420">
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="kindType[row.kind as PumpLedgerRow['kind']]">
            {{ kindLabel[row.kind as PumpLedgerRow['kind']] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间 / 时段" width="210">
        <template #default="{ row }">{{ timeOf(row) }}</template>
      </el-table-column>
      <el-table-column label="内容" min-width="260">
        <template #default="{ row }">
          <template v-if="row.kind === 'liquid'">
            {{ tankCode(row.tankId) }}
            <span :class="row.deltaL >= 0 ? 'pos' : 'neg'">{{ row.deltaL >= 0 ? '+' : '' }}{{ row.deltaL }}L</span>
            · {{ row.reason }} <span class="muted">{{ row.note }}</span>
          </template>
          <template v-else-if="row.kind === 'lease'">
            {{ row.state }}
            <span v-if="row.conflictsWith" class="warn">· 撞 {{ row.conflictsWith }}</span>
            <span class="muted">· {{ row.note }}</span>
          </template>
          <template v-else>
            <strong>{{ row.code }}</strong>
            {{ tankCode(row.sourceTankId) }} → {{ tankCode(row.targetTankId) }} · {{ row.volumeL }}L ·
            {{ row.state }}
            <span v-if="row.rerunOf" class="warn">· 失效重排</span>
            <span v-if="row.submitChannel === '断网补录'" class="warn">· {{ row.device }} 补录</span>
          </template>
        </template>
      </el-table-column>
      <el-table-column label="状态 / 差量" min-width="260">
        <template #default="{ row }">
          <span v-if="row.kind === 'job' && row.rejectReason" class="danger">{{ row.rejectReason }}</span>
          <span v-else-if="row.kind === 'lease'" class="muted">{{ row.device }} 提交</span>
          <span v-else class="muted">{{ row.device }}</span>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.ledger-filter {
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

.warn {
  color: #b97a1f;
}

.danger {
  color: #c0392b;
}

.muted {
  color: #8c8479;
}
</style>
