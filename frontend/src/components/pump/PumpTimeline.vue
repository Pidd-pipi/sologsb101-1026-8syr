<script setup lang="ts">
/** 泵机时间线：按天展示租约；已派工可执行 / 撤单，待确认并列时由班长裁决 */
import { computed } from 'vue'
import type { PumpLedgerRow, TankRow } from '@/utils/db'
import type { ConflictPair } from '@/hooks/usePumpBoard'
import { fmtClock } from '@/hooks/usePumpBoard'

const props = defineProps<{
  days: { day: string; items: Array<{
    lease: Extract<PumpLedgerRow, { kind: 'lease' }>
    job: Extract<PumpLedgerRow, { kind: 'job' }> | null
    day: string
    startLabel: string
    endLabel: string
  }> }[]
  tanksById: Map<string, TankRow>
  conflicts: ConflictPair[]
}>()

const emit = defineEmits<{
  (e: 'execute', jobId: string): void
  (e: 'cancel', jobId: string): void
  (e: 'resolve', keepJobId: string, dropJobId: string): void
}>()

function tankCode(id: string): string {
  return props.tanksById.get(id)?.code ?? '已删罐'
}

const leaseStateType = computed<Record<string, 'success' | 'warning' | 'info' | 'danger'>>(() => ({
  有效: 'success',
  待确认: 'warning',
  已释放: 'info',
  已拒绝: 'danger'
}))

const jobStateType = computed<Record<string, 'success' | 'warning' | 'info' | 'danger' | 'primary'>>(() => ({
  已派工: 'primary',
  待派工: 'danger',
  待确认: 'warning',
  已执行: 'success',
  已撤单: 'info',
  已失效: 'info'
}))

/** 某条待确认租约是否出现在冲突对里（渲染裁决按钮用） */
function conflictOf(jobId: string): ConflictPair | null {
  return (
    props.conflicts.find(
      (pair) =>
        (pair.first.job?.id === jobId || pair.second.job?.id === jobId) &&
        pair.first.job &&
        pair.second.job
    ) ?? null
  )
}
</script>

<template>
  <div class="timeline">
    <el-alert
      v-if="conflicts.length > 0"
      type="warning"
      :closable="false"
      show-icon
      class="conflict-banner"
      title="存在断网补录撞期：以下时段两份提交并列，请班长选择保留哪一份，另一份立即失效重排"
    />

    <div v-for="group in days" :key="group.day" class="timeline__day">
      <div class="timeline__date">{{ group.day }}</div>
      <div class="timeline__items">
        <div
          v-for="item in group.items"
          :key="item.lease.id"
          class="slot"
          :class="{
            'is-active': item.lease.state === '有效',
            'is-pending': item.lease.state === '待确认',
            'is-done': item.lease.state === '已释放'
          }"
        >
          <div class="slot__time">
            <strong>{{ item.startLabel }}–{{ item.endLabel }}</strong>
            <el-tag size="small" :type="leaseStateType[item.lease.state]" effect="plain">
              租约·{{ item.lease.state }}
            </el-tag>
          </div>
          <div class="slot__body">
            <template v-if="item.job">
              <div class="slot__title">
                <el-tag size="small" :type="jobStateType[item.job.state]">{{ item.job.state }}</el-tag>
                <span class="slot__code">{{ item.job.code }}</span>
                <span class="slot__route">
                  {{ tankCode(item.job.sourceTankId) }} → {{ tankCode(item.job.targetTankId) }}
                </span>
                <span class="slot__vol">{{ item.job.volumeL }}L</span>
                <el-tag v-if="item.job.submitChannel === '断网补录'" size="small" type="warning">
                  {{ item.job.device }} 补录
                </el-tag>
              </div>
              <div v-if="item.job.rejectReason" class="slot__reason">{{ item.job.rejectReason }}</div>
              <div class="slot__meta">
                操作人 {{ item.job.operator || '—' }} · 提交于 {{ fmtClock(item.lease.submittedAt) }}
                <template v-if="item.job.rerunOf"> · 失效重排作业</template>
              </div>

              <!-- 冲突裁决 -->
              <div v-if="item.lease.state === '待确认'" class="slot__resolve">
                <template v-if="conflictOf(item.job.id)">
                  <span class="muted">重叠时段并列：</span>
                  <el-button
                    link
                    type="success"
                    size="small"
                    @click="
                      emit(
                        'resolve',
                        item.job!.id,
                        conflictOf(item.job.id)!.first.job!.id === item.job!.id
                          ? conflictOf(item.job.id)!.second.job!.id
                          : conflictOf(item.job.id)!.first.job!.id
                      )
                    "
                  >
                    保留本作业
                  </el-button>
                </template>
              </div>

              <div v-if="item.job.state === '已派工'" class="slot__actions">
                <el-button link type="success" size="small" @click="emit('execute', item.job!.id)">执行交接</el-button>
                <el-button link type="danger" size="small" @click="emit('cancel', item.job!.id)">撤单重排</el-button>
              </div>
            </template>
            <div v-else class="muted">租约对应作业已不在占用账</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.conflict-banner {
  margin-bottom: 4px;
}

.timeline__day {
  display: flex;
  gap: 12px;
}

.timeline__date {
  width: 104px;
  flex-shrink: 0;
  font-weight: 700;
  color: #8a3b56;
  font-variant-numeric: tabular-nums;
}

.timeline__items {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.slot {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #c9c0b8;
  border-radius: 10px;
  background: #fff;
}

.slot.is-active {
  border-left-color: #6fae7a;
}

.slot.is-pending {
  border-left-color: #e0a44a;
  background: #fffaf0;
}

.slot.is-done {
  opacity: 0.72;
}

.slot__time {
  width: 150px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}

.slot__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.slot__code {
  font-weight: 700;
}

.slot__route {
  font-weight: 600;
}

.slot__vol {
  color: #8c8479;
}

.slot__reason {
  margin-top: 4px;
  font-size: 12px;
  color: #c0392b;
}

.slot__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.slot__actions,
.slot__resolve {
  margin-top: 6px;
}

.muted {
  color: #8c8479;
  font-size: 12px;
}
</style>
