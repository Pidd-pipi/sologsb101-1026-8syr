<script setup lang="ts">
/** /pump 泵机交接排班：发酵罐液体、泵机时段与倒罐作业共用一张占用账 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules, type UploadFile } from 'element-plus'
import { Plus, RefreshRight, Connection, Download, Upload } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type BatchRow, type OperationRow, type PumpLeaseRow, type ReadingRow, type TankRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { usePumpStore } from '@/stores/pumpStore'
import {
  PUMP_DRAIN_MODES,
  PUMP_JOB_TYPES,
  createEmptyPumpLease,
  type PumpLeaseDraft,
  type PumpLeaseState
} from '@/types/pump'
import { buildLiquidLedger } from '@/utils/liquidLedger'
import { downloadJson } from '@/utils/export'
import type { MergeReport } from '@/utils/pumpSync'

const pumpStore = usePumpStore()
const { leases, snapshots, deviceId, busy, lastMergeReport } = storeToRefs(pumpStore)

const { rows: tanks, ready: tanksReady } = useIdbTable<TankRow>(() => db.tanks, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: batches } = useIdbTable<BatchRow>(() => db.batches)
const { rows: operations } = useIdbTable<OperationRow>(() => db.operations)
const { rows: readings } = useIdbTable<ReadingRow>(() => db.readings)

const STATE_TONE: Record<PumpLeaseState, 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  已派工: 'success',
  排队中: 'warning',
  待重排: 'warning',
  待确认: 'danger',
  已拒绝: 'danger',
  已完成: 'info',
  已撤单: 'info'
}

const tankById = computed(() => new Map(tanks.value.map((tank) => [tank.id, tank])))
const operationIds = computed(() => new Set(operations.value.map((operation) => operation.id)))

function tankCode(id: string): string {
  return tankById.value.get(id)?.code ?? '已删罐'
}

function context() {
  return { tanks: tanks.value, batches: batches.value, operationIds: operationIds.value }
}

/** 当前液体账（初始液位），供表格内展示每罐实时余量 */
const liquid = computed(() => buildLiquidLedger(tanks.value, batches.value))

const summary = computed(() => {
  const open = leases.value.filter((lease) => lease.state !== '已完成' && lease.state !== '已撤单')
  return {
    total: leases.value.length,
    dispatched: open.filter((lease) => lease.state === '已派工').length,
    queued: open.filter((lease) => lease.state === '排队中').length,
    rerun: open.filter((lease) => lease.state === '待重排').length,
    conflict: open.filter((lease) => lease.state === '待确认').length,
    rejected: leases.value.filter((lease) => lease.state === '已拒绝').length
  }
})

/* ------------------------------ 自动重排 ------------------------------ */

/**
 * 罐号改动 / 撤单 / 夜班补录读数 / 清洗状态变化后，未执行作业立即失效重排。
 * 监听泵机账之外的四张账（罐、批次、作业、读数）签名，变化即触发 reconcile；
 * reconcile 无实际状态变化时不写库。
 */
const contextSignature = computed(() =>
      JSON.stringify([
        tanks.value.map((t) => [t.id, t.code, t.state, t.capacityL]),
        batches.value.map((b) => [b.id, b.tankId, b.volumeL, b.state]),
        operations.value.map((o) => o.id),
        readings.value.map((r) => [r.batchId, r.date, r.updatedAt])
      ])
)

let loadedOnce = false
onMounted(async () => {
  await pumpStore.load()
  loadedOnce = true
  await pumpStore.reconcileAndPersist(context())
})

watch(contextSignature, async () => {
  if (!loadedOnce || !tanksReady.value) return
  const result = await pumpStore.reconcileAndPersist(context())
  if (result.restored) ElMessage.warning('写入失败，已从当时快照恢复占用账')
  else if (result.changed) ElMessage.info('罐位 / 读数 / 作业账有变动，未执行作业已自动重排')
})

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()
const form = reactive<PumpLeaseDraft>(createEmptyPumpLease())

const rules: FormRules = {
  sourceTankId: [{ required: true, message: '请选择源罐', trigger: 'change' }],
  targetTankId: [{ required: true, message: '请选择目标罐', trigger: 'change' }],
  volumeL: [{ required: true, message: '请填写转移液量', trigger: 'blur' }]
}

const linkableOperations = computed(() =>
  operations.value
    .filter((operation) => operation.type === '倒罐' || operation.type === '淋皮')
    .map((operation) => {
      const batch = batches.value.find((item) => item.id === operation.batchId)
      return {
        label: `${operation.date} ${operation.type} · ${operation.operator}（${batch ? tankCode(batch.tankId) : '无罐'}）`,
        value: operation.id
      }
    })
)

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptyPumpLease())
  dialogVisible.value = true
}

function openEdit(row: PumpLeaseRow): void {
  editingId.value = row.id
  Object.assign(form, {
    title: row.title,
    jobType: row.jobType,
    drainMode: row.drainMode,
    sourceTankId: row.sourceTankId,
    targetTankId: row.targetTankId,
    volumeL: row.volumeL,
    range: [new Date(row.startAt), new Date(row.endAt)],
    operationId: row.operationId
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (form.sourceTankId === form.targetTankId) {
    ElMessage.error('源罐与目标罐不能相同')
    return
  }
  try {
    if (editingId.value) {
      await pumpStore.updateLease(
        editingId.value,
        {
          title: form.title.trim() || '未命名倒罐作业',
          jobType: form.jobType,
          drainMode: form.drainMode,
          sourceTankId: form.sourceTankId,
          targetTankId: form.targetTankId,
          volumeL: form.volumeL,
          startAt: form.range?.[0].toISOString() ?? '',
          endAt: form.range?.[1].toISOString() ?? '',
          operationId: form.operationId
        },
        context()
      )
      ElMessage.success('租约已修改并重新派工')
    } else {
      const row = await pumpStore.submitLease({ ...form }, context())
      if (row.state === '已派工') ElMessage.success('租约已派工，泵机时段已占用')
      else if (row.state === '排队中') ElMessage.warning(`该时段已有先提交租约，已排队：${row.rejectReason}`)
      else if (row.state === '已拒绝') ElMessage.error(`派工被拒：${row.rejectReason}`)
      else ElMessage.info(`当前状态：${row.state} · ${row.rejectReason}`)
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '提交失败')
  }
}

async function cancel(row: PumpLeaseRow): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认撤单「${row.title}」？撤单后受影响的未执行作业立即重排。`, '撤单确认', {
      type: 'warning'
    })
  } catch {
    return
  }
  await pumpStore.cancelLease(row.id, context())
  ElMessage.success('已撤单，占用账已重排')
}

async function remove(row: PumpLeaseRow): Promise<void> {
  await pumpStore.deleteLease(row.id, context())
  ElMessage.success('租约已从占用账删除')
}

async function complete(row: PumpLeaseRow): Promise<void> {
  await pumpStore.completeLease(row.id)
  ElMessage.success('租约已完成，泵机时段释放')
}

async function rerun(row: PumpLeaseRow): Promise<void> {
  await pumpStore.rerunLease(row.id, context())
  ElMessage.success('已按建议时段重新派工')
}

async function manualReconcile(): Promise<void> {
  const result = await pumpStore.reconcileAndPersist(context())
  if (result.restored) ElMessage.error('重排写入失败，已从快照恢复')
  else ElMessage.success(result.changed ? '已重排全部未执行作业' : '占用账无变化')
}

/* ------------------------------ 冲突裁决 ------------------------------ */

async function keepLease(row: PumpLeaseRow): Promise<void> {
  await pumpStore.resolveConflict(row.id, row.conflictsWith, context())
  ElMessage.success('已保留该租约，重叠方撤单，占用账已重排')
}

/* ------------------------------ 平板补录合并 ------------------------------ */

const syncDialogVisible = ref(false)
const incomingText = ref('')
const lastReport = ref<MergeReport | null>(null)

function openSync(): void {
  incomingText.value = ''
  lastReport.value = lastMergeReport.value
  syncDialogVisible.value = true
}

function exportMyPacket(): void {
  const packet = pumpStore.exportPacket()
  downloadJson(`pump-sync-${packet.deviceId}-${Date.now()}.json`, JSON.stringify(packet, null, 2))
}

async function onPacketFile(file: File): Promise<void> {
  const text = await file.text()
  incomingText.value = text
}

function onUploadChange(file: UploadFile): void {
  if (file.raw) void onPacketFile(file.raw)
}

async function mergeIncoming(): Promise<void> {
  if (!incomingText.value.trim()) {
    ElMessage.warning('请先粘贴或选择对端平板的补录包')
    return
  }
  try {
    const report = await pumpStore.importPacket(incomingText.value, context())
    lastReport.value = report
    ElMessage.success(
      `合并完成：新增 ${report.addedIds.length} 条，更新 ${report.updatedIds.length} 条，${report.conflictIds.length} 条重叠并列待确认`
    )
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '合并失败')
  }
}

/* ------------------------------ 快照恢复 ------------------------------ */

async function restoreSnapshot(): Promise<void> {
  const snap = snapshots.value[0]
  if (!snap) {
    ElMessage.info('还没有可恢复的快照')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将占用账整体恢复到「${snap.reason}」时刻（${new Date(snap.createdAt).toLocaleString()}）？`,
      '快照恢复',
      { type: 'warning' }
    )
  } catch {
    return
  }
  const ok = await pumpStore.restoreLatest()
  if (ok) ElMessage.success('占用账已从快照恢复')
}

const showTerminal = ref(false)
const visibleLeases = computed(() =>
  showTerminal.value
    ? pumpStore.timeline
    : pumpStore.timeline.filter((lease) => lease.state !== '已完成' && lease.state !== '已撤单')
)

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function submittedLabel(row: PumpLeaseRow): string {
  return new Date(row.submittedAt).toLocaleTimeString('zh-Hans-CN', { hour12: false })
}
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">泵机交接排班</h2>
        <p class="page__subtitle">
          发酵罐液体、泵机时段、倒罐作业共用一张占用账；同一时段先提交先占，容量不足 / 源罐未清空写明差量拒派。
          本机平板：<el-tag size="small" effect="plain">{{ deviceId }}</el-tag>
        </p>
      </div>
      <div>
        <el-button :icon="RefreshRight" :loading="busy" @click="manualReconcile">立即重排</el-button>
        <el-button :icon="Download" @click="openSync">平板补录合并</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">提交倒罐派工</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="占用账租约" :value="summary.total" suffix="条" icon="Grid" tone="primary" />
      <StatBadge label="已派工" :value="summary.dispatched" suffix="条" icon="Files" tone="success" />
      <StatBadge label="排队 / 待重排" :value="summary.queued + summary.rerun" suffix="条" icon="Clock" tone="warning" />
      <StatBadge label="重叠待确认" :value="summary.conflict" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="已拒绝（含差量）" :value="summary.rejected" suffix="条" icon="Histogram" tone="info" />
    </div>

    <el-card shadow="never" class="ledger-card">
      <template #header>
        <div class="card-title">
          <span><Connection /> 发酵罐液体账（实时投影当前在罐批次入罐量）</span>
          <el-button link type="primary" :icon="RefreshRight" @click="restoreSnapshot">从最近快照恢复</el-button>
        </div>
      </template>
      <div class="liquid-row">
        <div v-for="tank in tanks" :key="tank.id" class="liquid-chip">
          <div class="liquid-chip__head">
            <strong>{{ tank.code }}</strong>
            <el-tag size="small" :type="tank.state === '清洗中' ? 'warning' : tank.state === '在用' ? 'success' : 'info'">
              {{ tank.state }}
            </el-tag>
          </div>
          <div class="liquid-chip__level">
            {{ liquid.byTank.get(tank.id)?.levelL ?? 0 }} / {{ tank.capacityL }} L
          </div>
          <el-progress
            :percentage="Math.min(100, Math.round(((liquid.byTank.get(tank.id)?.levelL ?? 0) / tank.capacityL) * 100))"
            :stroke-width="8"
            :color="(liquid.byTank.get(tank.id)?.freeL ?? 0) < 300 ? '#c0392b' : '#8a3b56'"
          />
          <div class="liquid-chip__free">尚可受入 {{ liquid.byTank.get(tank.id)?.freeL ?? 0 }} L</div>
        </div>
      </div>
    </el-card>

    <div class="list-head">
      <el-checkbox v-model="showTerminal">显示已完成 / 已撤单</el-checkbox>
      <span class="muted">共 {{ visibleLeases.length }} 条 · 快照 {{ snapshots.length }} 份</span>
    </div>

    <EmptyPanel
      v-if="visibleLeases.length === 0"
      title="占用账还是空的"
      description="提交第一条倒罐派工：选源罐、目标罐、液量与泵机时段，系统自动判占并校验容量与清空差量。"
      create-text="提交倒罐派工"
      @create="openCreate"
    />

    <div v-else class="lease-list">
      <div v-for="row in visibleLeases" :key="row.id" class="lease-item" :class="`is-${row.state}`">
        <div class="lease-item__time">
          <div class="lease-item__slot">{{ formatTime(row.startAt) }} – {{ formatTime(row.endAt) }}</div>
          <div class="lease-item__submit">提交 {{ submittedLabel(row) }} · {{ row.deviceId }}</div>
        </div>
        <div class="lease-item__body">
          <div class="lease-item__title">
            <strong>{{ row.title }}</strong>
            <el-tag :type="STATE_TONE[row.state]" effect="dark" size="small">{{ row.state }}</el-tag>
            <el-tag size="small" effect="plain">{{ row.jobType }}</el-tag>
            <el-tag size="small" effect="plain">{{ row.drainMode }}</el-tag>
            <el-tag v-if="row.rerunNo > 0" size="small" type="warning" effect="plain">第 {{ row.rerunNo + 1 }} 轮</el-tag>
          </div>
          <div class="lease-item__route">
            <span class="tank-name">{{ tankCode(row.sourceTankId) }}</span>
            <span class="arrow">━━ {{ row.volumeL }}L ━━▶</span>
            <span class="tank-name">{{ tankCode(row.targetTankId) }}</span>
          </div>
          <div v-if="row.rejectReason" class="lease-item__reason">⚠️ {{ row.rejectReason }}</div>
          <div v-if="row.suggestedStartAt && (row.state === '排队中' || row.state === '待重排')" class="lease-item__suggest">
            建议改到 {{ formatTime(row.suggestedStartAt) }} 起
          </div>
        </div>
        <div class="lease-item__actions">
          <el-button
            v-if="row.state === '待确认'"
            link
            type="success"
            size="small"
            @click="keepLease(row)"
          >
            保留本条
          </el-button>
          <el-button
            v-if="(row.state === '排队中' || row.state === '待重排') && row.suggestedStartAt"
            link
            type="success"
            size="small"
            @click="rerun(row)"
          >
            按建议重排
          </el-button>
          <el-button v-if="row.state === '已派工'" link type="success" size="small" @click="complete(row)">完成</el-button>
          <el-button
            v-if="row.state !== '已完成' && row.state !== '已撤单'"
            link
            type="primary"
            size="small"
            @click="openEdit(row)"
          >
            改罐号 / 改时段
          </el-button>
          <el-button
            v-if="row.state !== '已完成' && row.state !== '已撤单'"
            link
            type="warning"
            size="small"
            @click="cancel(row)"
          >
            撤单
          </el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </div>
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '改罐号 / 改时段（重新派工）' : '提交倒罐派工'" width="580px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="作业标题">
          <el-input v-model="form.title" placeholder="如：F-02 梅洛清空转 F-04" />
        </el-form-item>
        <el-form-item label="作业类别">
          <el-radio-group v-model="form.jobType">
            <el-radio-button v-for="item in PUMP_JOB_TYPES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="清空模式">
          <el-radio-group v-model="form.drainMode">
            <el-radio-button v-for="item in PUMP_DRAIN_MODES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
          <div class="form-hint">清空模式下抽量须等于源罐液位，否则按「源罐未清空」写明差量拒派</div>
        </el-form-item>
        <el-form-item label="源罐" prop="sourceTankId">
          <el-select v-model="form.sourceTankId" class="full" placeholder="抽出方发酵罐">
            <el-option
              v-for="tank in tanks"
              :key="tank.id"
              :label="`${tank.code}（${tank.state}，现存 ${liquid.byTank.get(tank.id)?.levelL ?? 0}L）`"
              :value="tank.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="目标罐" prop="targetTankId">
          <el-select v-model="form.targetTankId" class="full" placeholder="受入方发酵罐">
            <el-option
              v-for="tank in tanks"
              :key="tank.id"
              :label="`${tank.code}（容量 ${tank.capacityL}L，尚可受入 ${liquid.byTank.get(tank.id)?.freeL ?? 0}L）`"
              :value="tank.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="转移液量(L)" prop="volumeL">
          <el-input-number v-model="form.volumeL" :min="1" :max="50000" :step="50" />
        </el-form-item>
        <el-form-item label="泵机时段">
          <el-date-picker
            v-model="form.range"
            type="datetimerange"
            range-separator="至"
            start-placeholder="开始"
            end-placeholder="结束"
            format="MM/DD HH:mm"
            class="full"
          />
          <div class="form-hint">全车间只有一台移动泵：时段重叠时只保留先提交的租约</div>
        </el-form-item>
        <el-form-item label="关联倒罐作业">
          <el-select v-model="form.operationId" clearable class="full" placeholder="可选：关联作业编排里的倒罐作业">
            <el-option v-for="item in linkableOperations" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <div class="form-hint">关联作业被撤单时，本租约立即失效重排</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submit">提交派工</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="syncDialogVisible" title="两台平板断网补录合并" width="640px">
      <el-alert type="info" :closable="false" show-icon>
        <template #title>
          两台平板各自断网排班后，先在本页导出本机补录包，再把对端包导入合并；
          同 id 取较新版本，泵机时段重叠的租约双方并列「待确认」，由班长裁决。
        </template>
      </el-alert>
      <div class="sync-actions">
        <el-button :icon="Download" @click="exportMyPacket">导出本机补录包（{{ deviceId }}）</el-button>
      </div>
      <el-input
        v-model="incomingText"
        type="textarea"
        :rows="8"
        placeholder="把对端平板导出的 JSON 粘贴到这里，或点下方按钮选择文件"
      />
      <el-upload
        class="sync-upload"
        :auto-upload="false"
        :show-file-list="false"
        accept="application/json"
        :on-change="onUploadChange"
      >
        <el-button :icon="Upload">选择对端补录包文件</el-button>
      </el-upload>
      <div v-if="lastReport" class="sync-report">
        上次合并：新增 {{ lastReport.addedIds.length }} · 更新 {{ lastReport.updatedIds.length }} ·
        重叠待确认 {{ lastReport.conflictIds.length }}
      </div>
      <template #footer>
        <el-button @click="syncDialogVisible = false">关闭</el-button>
        <el-button type="primary" :loading="busy" @click="mergeIncoming">合并补录</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.form-hint {
  font-size: 12px;
  color: #8c8479;
  line-height: 1.6;
}

.ledger-card {
  margin: 14px 0;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.liquid-row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}

.liquid-chip {
  padding: 10px 12px;
  border: 1px solid var(--wine-border);
  border-radius: 10px;
  background: #fffdfd;
}

.liquid-chip__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.liquid-chip__level {
  margin: 6px 0 4px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: #43323a;
}

.liquid-chip__free {
  margin-top: 4px;
  font-size: 12px;
  color: #8c8479;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0 8px;
}

.lease-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.lease-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--wine-border);
  border-left: 4px solid #1e8449;
  border-radius: 10px;
}

.lease-item.is-排队中,
.lease-item.is-待重排 {
  border-left-color: #d68910;
}

.lease-item.is-待确认,
.lease-item.is-已拒绝 {
  border-left-color: #c0392b;
  background: #fff8f7;
}

.lease-item.is-已完成,
.lease-item.is-已撤单 {
  border-left-color: #9aa5b1;
  opacity: 0.75;
}

.lease-item__time {
  width: 170px;
  flex-shrink: 0;
}

.lease-item__slot {
  font-weight: 700;
  color: #43323a;
  font-variant-numeric: tabular-nums;
}

.lease-item__submit {
  font-size: 11px;
  color: #8c8479;
  margin-top: 2px;
}

.lease-item__body {
  flex: 1;
  min-width: 0;
}

.lease-item__title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.lease-item__route {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.tank-name {
  font-weight: 700;
  color: #8a3b56;
}

.arrow {
  color: #8c8479;
  font-variant-numeric: tabular-nums;
}

.lease-item__reason {
  margin-top: 6px;
  font-size: 12px;
  color: #c0392b;
}

.lease-item__suggest {
  margin-top: 4px;
  font-size: 12px;
  color: #b9770e;
}

.lease-item__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 240px;
}

.sync-actions {
  margin: 12px 0 8px;
}

.sync-upload {
  margin-top: 8px;
}

.sync-report {
  margin-top: 10px;
  font-size: 13px;
  color: #8a3b56;
}

.muted {
  font-size: 12px;
  color: #8c8479;
}
</style>
