<script setup lang="ts">
/**
 * /pump 泵机交接排班与占用账
 * 发酵罐液体、泵机时段、倒罐作业共用一张占用账：
 * 同一泵机时段先提交者持约；容量不足 / 源罐未清空拒绝派工并写明差量；
 * 罐号改动 / 撤单后未执行作业立即失效重排，可从写入前快照恢复；
 * 两台平板断网补录合并后重叠时段并列待确认。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { db, type PumpLedgerRow, type PumpBackfillRow, type PumpSnapshotRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { usePumpBoard } from '@/hooks/usePumpBoard'
import { usePumpStore } from '@/stores/pumpStore'
import { LIQUID_REASONS, type LiquidReason, type PumpJobForm } from '@/types/pump'
import { nowIso } from '@/utils/uuid'
import PumpDispatchForm from '@/components/pump/PumpDispatchForm.vue'
import PumpTimeline from '@/components/pump/PumpTimeline.vue'
import TankLevels from '@/components/pump/TankLevels.vue'
import PumpLedgerTable from '@/components/pump/PumpLedgerTable.vue'
import PumpBackfillPanel from '@/components/pump/PumpBackfillPanel.vue'
import PumpSnapshotPanel from '@/components/pump/PumpSnapshotPanel.vue'

const store = usePumpStore()

const { rows: ledger, ready } = useIdbTable<PumpLedgerRow>(() => db.pumpLedger)
const { rows: backfill } = useIdbTable<PumpBackfillRow>(() => db.pumpBackfill)
const { rows: snapshots } = useIdbTable<PumpSnapshotRow>(() => db.pumpSnapshots, {
  compare: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt))
})
const { rows: tanks } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})

const board = usePumpBoard({ ledger, backfill, snapshots, tanks })

const tanksById = computed(() => new Map(tanks.value.map((t) => [t.id, t])))
const levelMap = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const item of board.tankLevels.value) map[item.tank.id] = item.levelL
  return map
})

/* ------------------------------ 派工 ------------------------------ */
const dispatchMode = ref<'在线' | '断网'>('在线')
const formRef = ref<InstanceType<typeof PumpDispatchForm> | null>(null)

async function onSubmit(form: PumpJobForm, mode: '在线' | '断网'): Promise<void> {
  try {
    if (mode === '断网') {
      await store.enqueueJob({
        occurredAt: form.requestedStartAt,
        job: {
          sourceTankId: form.sourceTankId,
          targetTankId: form.targetTankId,
          volumeL: form.volumeL,
          requireEmpty: form.requireEmpty,
          requestedStartAt: form.requestedStartAt,
          durationMin: form.durationMin,
          operator: form.operator
        }
      })
      ElMessage.success(`已在 ${store.device} 本地暂存该派工，恢复网络后合并`)
    } else {
      const result = await store.dispatch(form)
      if (result.status === '拒绝派工') ElMessage.error(result.message)
      else if (result.status === '自动改期') ElMessage.warning(result.message)
      else ElMessage.success(result.message)
    }
    formRef.value?.reset()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '派工失败')
  }
}

/* ------------------------------ 执行 / 撤单 / 裁决 ------------------------------ */
async function onExecute(jobId: string): Promise<void> {
  try {
    await store.execute(jobId)
    ElMessage.success('交接完成：租约已释放，源罐 / 目标罐液位流水已入账')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '执行失败')
  }
}

async function onCancel(jobId: string): Promise<void> {
  const count = board.jobs.value.filter((j) =>
    ['已派工', '待派工', '待确认'].includes(j.state)
  ).length
  try {
    await ElMessageBox.confirm(
      `撤单后该作业立即作废、释放泵机，其余 ${Math.max(count - 1, 0)} 条未执行作业将全部失效并按提交先后重排。是否继续？`,
      '撤单并重排',
      { type: 'warning', confirmButtonText: '撤单并重排' }
    )
  } catch {
    return
  }
  const reruns = await store.cancel(jobId)
  ElMessage.success(`已撤单，${reruns.length} 条未执行作业已重排（快照已留存）`)
}

async function onResolve(keepJobId: string, dropJobId: string): Promise<void> {
  const rerunId = await store.resolve(keepJobId, dropJobId)
  ElMessage.success(rerunId ? '已保留先提交作业，另一份失效并自动重排' : '冲突已裁决')
}

/* ------------------------------ 断网补录 ------------------------------ */
async function onMerge(id: string): Promise<void> {
  try {
    const result = await store.mergeOne(id)
    if (result.status === '待确认') ElMessage.warning(result.message)
    else if ('status' in result && result.status === '拒绝派工') ElMessage.error(result.message)
    else ElMessage.success(result.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合并失败')
  }
}

async function onMergeAll(): Promise<void> {
  await store.mergeAll()
  ElMessage.success('待合并补录已全部并入占用账，撞期条目请在时间线裁决')
}

/** 夜班液位补录（断网演示入口） */
const liquidForm = reactive({
  tankId: '',
  deltaL: -100,
  reason: '夜班补录' as LiquidReason,
  note: '',
  occurredAt: nowIso()
})
const liquidReasons = LIQUID_REASONS

async function onEnqueueLiquid(): Promise<void> {
  if (!liquidForm.tankId) {
    ElMessage.warning('请先选择发酵罐')
    return
  }
  await store.enqueueLiquid({ ...liquidForm })
  ElMessage.success(`${store.device} 已暂存液位补录，待合并`)
  liquidForm.note = ''
}

/* ------------------------------ 快照 ------------------------------ */
async function onRestore(id: string): Promise<void> {
  try {
    await store.restore(id)
    ElMessage.success('已从当时快照恢复占用账、补录队列与罐号')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '恢复失败')
  }
}

async function onRemoveSnapshot(id: string): Promise<void> {
  await store.removeSnapshot(id)
  ElMessage.success('快照已删除')
}
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">泵机交接排班 · 共用占用账</h2>
        <p class="page__subtitle">
          全车间一台移动泵：发酵罐液体、泵机时段、倒罐作业同记一张账；同一时段只保留先提交租约，
          容量不足或源罐未清空写明差量拒绝派工。
        </p>
      </div>
      <div class="device-box">
        <span class="muted">当前平板</span>
        <el-radio-group :model-value="store.device" size="small" @change="(v: string | number | boolean) => store.setDevice(String(v))">
          <el-radio-button label="平板A">平板 A</el-radio-button>
          <el-radio-button label="平板B">平板 B</el-radio-button>
        </el-radio-group>
      </div>
    </div>

    <el-card shadow="never" class="stat-card">
      <div class="metric-row">
        <el-tag type="primary" effect="plain">倒罐作业 {{ board.stats.value.jobs }}</el-tag>
        <el-tag type="success" effect="plain">持约待交接 {{ board.stats.value.holding }}</el-tag>
        <el-tag type="danger" effect="plain">拒绝待派工 {{ board.stats.value.rejected }}</el-tag>
        <el-tag type="warning" effect="plain">撞期待确认 {{ board.stats.value.pending }}</el-tag>
        <el-tag type="info" effect="plain">已执行 {{ board.stats.value.executed }}</el-tag>
        <el-tag type="warning" effect="plain">断网待合并 {{ board.pendingBackfillCount.value }}</el-tag>
      </div>
    </el-card>

    <el-row :gutter="16">
      <!-- 左：派工 + 补录 -->
      <el-col :xs="24" :md="9">
        <el-card shadow="never" class="panel">
          <template #header>
            <div class="card-title">
              <span>倒罐派工</span>
              <el-radio-group v-model="dispatchMode" size="small">
                <el-radio-button label="在线">在线提交</el-radio-button>
                <el-radio-button label="断网">断网补录</el-radio-button>
              </el-radio-group>
            </div>
          </template>
          <PumpDispatchForm
            ref="formRef"
          :tanks="tanks"
          :device="store.device"
          :mode="dispatchMode"
          v-model:levels="levelMap"
          @submit="onSubmit"
        />
        </el-card>

        <el-card shadow="never" class="panel">
          <template #header>
            <div class="card-title"><span>夜班液位补录（断网暂存）</span></div>
          </template>
          <el-form label-width="72px" size="small">
            <el-form-item label="发酵罐">
              <el-select v-model="liquidForm.tankId" class="full" placeholder="选择罐" filterable>
                <el-option
                  v-for="t in tanks"
                  :key="t.id"
                  :label="`${t.code} · 现存 ${levelMap[t.id] ?? 0}L`"
                  :value="t.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="变化量(L)">
              <el-input-number v-model="liquidForm.deltaL" :step="50" />
              <el-select v-model="liquidForm.reason" class="reason-select">
                <el-option v-for="r in liquidReasons" :key="r" :label="r" :value="r" />
              </el-select>
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="liquidForm.note" placeholder="如：夜班复测液位 / 取样损耗" />
            </el-form-item>
            <el-form-item>
              <el-button size="small" @click="onEnqueueLiquid">暂存到补录队列</el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <!-- 右：罐液体 + 时间线 -->
      <el-col :xs="24" :md="15">
        <el-card shadow="never" class="panel">
          <template #header>
            <div class="card-title">
              <span>发酵罐液体账</span>
              <span class="muted">液位由流水求和，派工时按空余容量校验</span>
            </div>
          </template>
          <TankLevels :levels="board.tankLevels.value" />
        </el-card>

        <el-card shadow="never" class="panel">
          <template #header>
            <div class="card-title">
              <span>移动泵时间线 · 先提交者持约</span>
              <span class="muted">执行交接后自动释放并记液位流水</span>
            </div>
          </template>
          <PumpTimeline
            :days="board.timelineByDay.value"
            :tanks-by-id="tanksById"
            :conflicts="board.conflictPairs.value"
            @execute="onExecute"
            @cancel="onCancel"
            @resolve="onResolve"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="panel">
      <template #header>
        <div class="card-title">
          <span>断网补录队列（两台平板合并）</span>
          <span class="muted">合并后重叠时段并列待确认</span>
        </div>
      </template>
      <PumpBackfillPanel :backfill="backfill" :tanks-by-id="tanksById" @merge="onMerge" @merge-all="onMergeAll" />
    </el-card>

    <el-card shadow="never" class="panel">
      <template #header>
        <div class="card-title">
          <span>共用占用账（罐液体 / 泵机时段 / 倒罐作业）</span>
          <span class="muted">只追加流水，撤单与重排全程留痕</span>
        </div>
      </template>
      <PumpLedgerTable :ledger="ledger" :tanks-by-id="tanksById" />
    </el-card>

    <el-card v-if="snapshots.length > 0" shadow="never" class="panel">
      <template #header>
        <div class="card-title">
          <span>写入前快照（罐号改动 / 撤单 / 合并自动留存）</span>
          <span class="muted">写入失败或误操作时可从当时快照恢复</span>
        </div>
      </template>
      <PumpSnapshotPanel :snapshots="snapshots" @restore="onRestore" @remove="onRemoveSnapshot" />
    </el-card>

    <div v-if="!ready" class="loading-hint">正在读取本地占用账…</div>
  </div>
</template>

<style scoped>
.device-box {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stat-card {
  margin-bottom: 14px;
}

.metric-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.panel {
  margin-bottom: 14px;
}

.full {
  width: 100%;
}

.reason-select {
  width: 120px;
  margin-left: 8px;
}

.muted {
  color: #8c8479;
  font-size: 12px;
}

.loading-hint {
  text-align: center;
  color: #8c8479;
  padding: 12px;
}
</style>
