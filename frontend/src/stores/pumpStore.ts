/**
 * 泵机交接 store：发酵罐液体、泵机时段与倒罐作业共用一张占用账。
 *
 * 派工规则：
 * - 同一泵机时段收到两份提交，只保留先提交的租约（submittedAt 小者占用），后到者排队；
 * - 目标罐容量不足 / 源罐未清空 → 拒绝派工，并写明差量；
 * - 罐号改动、撤单、清洗未完成、夜班补录读数后，受影响的未执行作业立即失效重排；
 * - 写入失败可从当时快照恢复；
 * - 两台平板断网补录后合并，重叠时段并列「待确认」。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  bulkPutPumpLeases,
  latestPumpSnapshot,
  listPumpLeases,
  listPumpSnapshots,
  removePumpLease,
  restorePumpLeases,
  savePumpSnapshot,
  updatePumpLease,
  ROW_REVISION,
  type BatchRow,
  type PumpLeaseRow,
  type PumpSnapshotRow,
  type TankRow
} from '@/utils/db'
import { createId } from '@/utils/uuid'
import {
  buildLiquidLedger,
  checkDispatch,
  nextFreeSlot,
  type LiquidLedger
} from '@/utils/liquidLedger'
import { mergePumpSync, parsePumpPacket, type MergeReport } from '@/utils/pumpSync'
import {
  PUMP_DEVICE_KEY,
  PUMP_OPEN_STATES,
  type PumpLease,
  type PumpLeaseDraft,
  type PumpSyncPacket
} from '@/types/pump'

/** 还占着泵机/罐容量账的开放状态 */
const OPEN = new Set<string>(PUMP_OPEN_STATES)

interface ReconcileContext {
  tanks: TankRow[]
  batches: BatchRow[]
  /** 现存作业 id 集合（关联作业被撤单即判失效） */
  operationIds: Set<string>
}

/** 计算单个租约执行前的液体账：把所有更早、已派工的租约投影上去 */
function ledgerBefore(
  lease: PumpLease,
  all: PumpLease[],
  base: LiquidLedger
): LiquidLedger {
  const work = new Map<string, { tankId: string; levelL: number; capacityL: number; freeL: number }>()
  for (const [id, liquid] of base.byTank) work.set(id, { ...liquid })
  const earlier = all
    .filter(
      (item) =>
        item.state === '已派工' &&
        item.startAt < lease.startAt &&
        item.id !== lease.id
    )
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
  for (const item of earlier) {
    const source = work.get(item.sourceTankId)
    const target = work.get(item.targetTankId)
    if (!source || !target) continue
    const moved = Math.min(item.volumeL, source.levelL)
    const sourceLevel = source.levelL - moved
    const targetLevel = target.levelL + moved
    work.set(item.sourceTankId, { ...source, levelL: sourceLevel, freeL: source.capacityL - sourceLevel })
    work.set(item.targetTankId, { ...target, levelL: targetLevel, freeL: target.capacityL - targetLevel })
  }
  return { byTank: work }
}

export const usePumpStore = defineStore('pump', () => {
  const leases = ref<PumpLeaseRow[]>([])
  const snapshots = ref<PumpSnapshotRow[]>([])
  const ready = ref(false)
  const busy = ref(false)
  const lastMergeReport = ref<MergeReport | null>(null)

  /** 本机平板标识（首次使用生成并持久化） */
  const deviceId = ref<string>(deviceIdFromStorage())

  const openLeases = computed(() => leases.value.filter((lease) => OPEN.has(lease.state)))

  /** 按开始时间排序的占用账，供时间轴渲染 */
  const timeline = computed(() =>
    [...leases.value].sort((a, b) => a.startAt.localeCompare(b.startAt) || a.submittedAt - b.submittedAt)
  )

  async function load(): Promise<void> {
    const [rows, snaps] = await Promise.all([listPumpLeases(), listPumpSnapshots()])
    leases.value = rows
    snapshots.value = snaps
    ready.value = true
  }

  /**
   * 重排整张占用账：按「开始时间 → 提交时间」顺序逐条判定。
   * 纯函数式返回下一版租约列表与变更标记，写库由调用方统一执行。
   */
  function reconcile(
    current: PumpLease[],
    context: ReconcileContext,
    options: { rerunAll?: boolean } = {}
  ): { next: PumpLease[]; changed: boolean } {
    const base = buildLiquidLedger(context.tanks, context.batches)
    const tankById = new Map(context.tanks.map((tank) => [tank.id, tank]))

    // 已派工的按时间排列，供后续时段判占；待确认/排队/待重排不占泵机
    const pumpBusy: Array<{ startAt: string; endAt: string }> = []

    const next = [...current].sort(
      (a, b) => a.startAt.localeCompare(b.startAt) || a.submittedAt - b.submittedAt
    )

    let changed = false
    const patchOne = (lease: PumpLease, patch: Partial<PumpLease>): void => {
      for (const key of Object.keys(patch) as Array<keyof PumpLease>) {
        if (lease[key] !== patch[key]) {
          changed = true
          break
        }
      }
      Object.assign(lease, patch)
    }

    for (const lease of next) {
      // 终态（已完成/已撤单/已拒绝）保持不动
      if (!OPEN.has(lease.state)) continue
      // 待确认是人工裁决项：仅在整轮重排时才允许重新参与判占，
      // 且只要它仍与任一已派工租约时段重叠，就必须保持「并列待确认」。
      if (lease.state === '待确认' && !options.rerunAll) continue
      const stillConflicted = lease.conflictsWith.some((peerId) => {
        const peer = next.find((item) => item.id === peerId)
        if (!peer || peer.state === '已撤单' || peer.state === '已完成') return false
        return (
          new Date(lease.startAt).getTime() < new Date(peer.endAt).getTime() &&
          new Date(peer.startAt).getTime() < new Date(lease.endAt).getTime()
        )
      })
      if (stillConflicted) continue

      const sourceTank = tankById.get(lease.sourceTankId)
      const targetTank = tankById.get(lease.targetTankId)

      // 1) 罐号改动 / 罐被删除：立即失效重排
      if (!sourceTank || !targetTank) {
        bumpRerun(lease, patchOne, '源罐或目标罐已变更/删除，作业立即失效，请重选罐号后排班')
        continue
      }

      // 2) 关联作业被撤单（删除）：立即失效
      if (lease.operationId && !context.operationIds.has(lease.operationId)) {
        bumpRerun(lease, patchOne, '关联倒罐作业已撤单，租约立即失效重排')
        continue
      }

      // 3) 清洗未完成：源罐/目标罐仍在清洗中，泵机不能接线
      if (sourceTank.state === '清洗中' || targetTank.state === '清洗中') {
        bumpRerun(lease, patchOne, `罐 ${sourceTank.state === '清洗中' ? sourceTank.code : targetTank.code} 清洗未完成，作业失效待重排`)
        continue
      }

      // 4) 泵机时段：与已派工租约重叠 → 先提交的占用，后到的排队
      const overlap = pumpBusy.some((slot) => {
        const s = new Date(slot.startAt).getTime()
        const e = new Date(slot.endAt).getTime()
        const ls = new Date(lease.startAt).getTime()
        const le = new Date(lease.endAt).getTime()
        return ls < e && s < le
      })
      if (overlap) {
        const holder = findHolder(lease, next)
        const durationMin = Math.max(
          10,
          Math.round((new Date(lease.endAt).getTime() - new Date(lease.startAt).getTime()) / 60000)
        )
        const suggestion = nextFreeSlot(new Date(lease.startAt), durationMin, pumpBusy)
        patchOne(lease, {
          state: '排队中',
          rejectReason: `同一泵机时段已有先提交的租约 ${holder}，按先提交先得排队等待`,
          suggestedStartAt: suggestion.toISOString(),
          conflictsWith: holder ? [holder] : []
        })
        continue
      }

      // 5) 液体账校验：目标罐容量不足 / 源罐未清空
      const projected = ledgerBefore(lease, next, base)
      const verdict = checkDispatch(lease, projected)
      if (!verdict.ok) {
        patchOne(lease, {
          state: '已拒绝',
          rejectReason: verdict.reason,
          suggestedStartAt: null
        })
        continue
      }

      // 通过：占用泵机时段 + 恢复为已派工
      pumpBusy.push({ startAt: lease.startAt, endAt: lease.endAt })
      if (lease.state !== '已派工') {
        patchOne(lease, {
          state: '已派工',
          rejectReason: '',
          suggestedStartAt: null,
          conflictsWith: []
        })
      }
    }

    return { next, changed }
  }

  function findHolder(lease: PumpLease, all: PumpLease[]): string {
    const holder = all.find(
      (item) =>
        item.id !== lease.id &&
        item.state === '已派工' &&
        new Date(item.startAt).getTime() < new Date(lease.endAt).getTime() &&
        new Date(lease.startAt).getTime() < new Date(item.endAt).getTime()
    )
    return holder ? holder.id : ''
  }

  function bumpRerun(
    lease: PumpLease,
    patchOne: (lease: PumpLease, patch: Partial<PumpLease>) => void,
    reason: string
  ): void {
    patchOne(lease, {
      state: '待重排',
      rejectReason: reason,
      rerunNo: lease.rerunNo + 1
    })
  }

  /** 以当前上下文重排并整批写库（先拍快照，写失败可恢复） */
  async function reconcileAndPersist(context: ReconcileContext): Promise<{ changed: boolean; restored: boolean }> {
    busy.value = true
    const snapshot: PumpLease[] = leases.value.map(stripRowFields)
    try {
      const { next, changed } = reconcile(leases.value.map(cloneLease), context)
      if (changed) {
        // 自动重排由外部账变动触发，不额外拍快照（显式派工/撤单/合并前都已各自留快照）
        await bulkPutPumpLeases(next.map(toRow))
        leases.value = next as PumpLeaseRow[]
      }
      return { changed, restored: false }
    } catch (error) {
      // 写入失败：从当时快照恢复占用账
      const restored = await tryRestore(snapshot, error)
      return { changed: false, restored }
    } finally {
      busy.value = false
    }
  }

  /** 提交一条新租约：先快照，校验通过即派工，否则按规则排队/拒绝（带差量） */
  async function submitLease(draft: PumpLeaseDraft, context: ReconcileContext): Promise<PumpLeaseRow> {
    if (!draft.range || draft.range.length !== 2) throw new Error('请选择泵机时段')
    if (!draft.sourceTankId) throw new Error('请选择源罐')
    if (!draft.targetTankId) throw new Error('请选择目标罐')
    if (draft.volumeL <= 0) throw new Error('转移液量必须大于 0')
    if (draft.range[1].getTime() <= draft.range[0].getTime()) throw new Error('泵机时段结束时间必须晚于开始时间')

    const now = Date.now()
    const id = createId('pump')
    const lease: PumpLease = {
      id,
      title: draft.title.trim() || '未命名倒罐作业',
      jobType: draft.jobType,
      drainMode: draft.drainMode,
      sourceTankId: draft.sourceTankId,
      targetTankId: draft.targetTankId,
      volumeL: draft.volumeL,
      startAt: draft.range[0].toISOString(),
      endAt: draft.range[1].toISOString(),
      submittedAt: now,
      deviceId: deviceId.value,
      operationId: draft.operationId,
      state: '已派工',
      rejectReason: '',
      suggestedStartAt: null,
      conflictsWith: [],
      rerunNo: 0
    }

    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot(`派工提交前快照 · ${lease.title}`, snapshot)
      const withNew = [...leases.value.map(cloneLease), lease]
      const { next } = reconcile(withNew, context)
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
      return next.find((item) => item.id === id) as PumpLeaseRow
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 编辑租约（改罐号/改量/改时段等同一次重新派工，先提交时间保留） */
  async function updateLease(id: string, patch: Partial<PumpLease>, context: ReconcileContext): Promise<void> {
    const target = leases.value.find((item) => item.id === id)
    if (!target) throw new Error('租约不存在')
    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot(`租约修改前快照 · ${target.title}`, snapshot)
      const edited = cloneLease(target)
      Object.assign(edited, patch)
      if (patch.sourceTankId || patch.targetTankId || patch.volumeL || patch.startAt) {
        edited.rerunNo += 1
      }
      const others = leases.value.filter((item) => item.id !== id).map(cloneLease)
      const { next } = reconcile([...others, edited], context, { rerunAll: true })
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 撤单：租约置为已撤单（终态），受其影响的未执行作业立即重排 */
  async function cancelLease(id: string, context: ReconcileContext): Promise<void> {
    const target = leases.value.find((item) => item.id === id)
    if (!target) return
    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot(`撤单前快照 · ${target.title}`, snapshot)
      const cancelled = cloneLease(target)
      cancelled.state = '已撤单'
      cancelled.rejectReason = '已撤单'
      const others = leases.value.filter((item) => item.id !== id).map(cloneLease)
      // 撤单后整张账重排：原本排队/被容量卡住的作业可能重新可行
      const { next } = reconcile([...others, cancelled], context, { rerunAll: true })
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 标记完成：终态，后续账不再把它当作待执行占用 */
  async function completeLease(id: string): Promise<void> {
    await updatePumpLease(id, { state: '已完成', rejectReason: '', suggestedStartAt: null })
    leases.value = leases.value.map((item) =>
      item.id === id ? ({ ...item, state: '已完成' } as PumpLeaseRow) : item
    )
  }

  /** 删除租约行（区别于撤单：从占用账中彻底移除） */
  async function deleteLease(id: string, context: ReconcileContext): Promise<void> {
    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot('删除租约前快照', snapshot)
      await removePumpLease(id)
      const rest = leases.value.filter((item) => item.id !== id).map(cloneLease)
      const { next } = reconcile(rest, context, { rerunAll: true })
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 接受建议时段重排一条排队/待重排租约 */
  async function rerunLease(id: string, context: ReconcileContext): Promise<void> {
    const target = leases.value.find((item) => item.id === id)
    if (!target || !target.suggestedStartAt) {
      await reconcileAndPersist(context)
      return
    }
    const start = new Date(target.suggestedStartAt)
    const duration = new Date(target.endAt).getTime() - new Date(target.startAt).getTime()
    await updateLease(
      id,
      { startAt: start.toISOString(), endAt: new Date(start.getTime() + duration).toISOString() },
      context
    )
  }

  /** 待确认裁决：保留其中一条，另一条撤单（然后重排） */
  async function resolveConflict(keepId: string, dropIds: string[], context: ReconcileContext): Promise<void> {
    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot('冲突裁决前快照', snapshot)
      const working = leases.value.map(cloneLease)
      for (const dropId of dropIds) {
        const lease = working.find((item) => item.id === dropId)
        if (lease) {
          lease.state = '已撤单'
          lease.rejectReason = `冲突裁决：保留 ${keepId}，本租约撤单`
        }
      }
      const kept = working.find((item) => item.id === keepId)
      if (kept) {
        kept.state = '已派工'
        kept.rejectReason = ''
        kept.conflictsWith = []
      }
      const { next } = reconcile(working, context, { rerunAll: true })
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /* ----------------------- 两台平板断网补录合并 ----------------------- */

  /** 导出本机平板补录包（开放租约为主，另附终态便于对端收敛） */
  function exportPacket(): PumpSyncPacket {
    return {
      deviceId: deviceId.value,
      exportedAt: new Date().toISOString(),
      leases: leases.value.map(stripRowFields)
    }
  }

  /** 导入对端平板补录 JSON 并合并：重叠时段并列待确认 */
  async function importPacket(text: string, context: ReconcileContext): Promise<MergeReport> {
    const parsed = parsePumpPacket(text)
    const snapshot = leases.value.map(stripRowFields)
    busy.value = true
    try {
      await saveSnapshot(`平板 ${parsed.deviceId} 补录合并前快照`, snapshot)
      const report = mergePumpSync(snapshot, parsed.leases)
      // 合并后用本机液体/罐位上下文再跑一遍：非重叠的新租约也要过容量与清空校验
      const { next } = reconcile(report.merged.map(cloneLease), context, { rerunAll: true })
      // merge 已标出的待确认必须保留（rerunAll 后 reconcile 不降级它们）
      await bulkPutPumpLeases(next.map(toRow))
      leases.value = next as PumpLeaseRow[]
      lastMergeReport.value = report
      return report
    } catch (error) {
      await tryRestore(snapshot, error)
      throw error
    } finally {
      busy.value = false
    }
  }

  /** 手动从最近快照恢复 */
  async function restoreLatest(): Promise<boolean> {
    const snap = await latestPumpSnapshot()
    if (!snap) return false
    await restorePumpLeases(snap.leases)
    await load()
    return true
  }

  async function refreshSnapshots(): Promise<void> {
    snapshots.value = await listPumpSnapshots()
  }

  /* ------------------------------ 内部工具 ------------------------------ */

  async function saveSnapshot(reason: string, snapshotLeases: PumpLease[]): Promise<void> {
    await savePumpSnapshot({
      id: createId('snap'),
      reason,
      leases: snapshotLeases,
      createdAt: Date.now()
    })
    snapshots.value = await listPumpSnapshots()
  }

  async function tryRestore(snapshotLeases: PumpLease[], error: unknown): Promise<boolean> {
    console.error('泵机占用账写入失败，尝试从快照恢复', error)
    try {
      await restorePumpLeases(snapshotLeases)
      leases.value = (await listPumpLeases()) as PumpLeaseRow[]
      return true
    } catch (restoreError) {
      console.error('快照恢复也失败了', restoreError)
      return false
    }
  }

  return {
    deviceId,
    leases,
    snapshots,
    ready,
    busy,
    lastMergeReport,
    openLeases,
    timeline,
    load,
    reconcile,
    reconcileAndPersist,
    submitLease,
    updateLease,
    cancelLease,
    completeLease,
    deleteLease,
    rerunLease,
    resolveConflict,
    exportPacket,
    importPacket,
    restoreLatest,
    refreshSnapshots
  }
})

/* ------------------------------ 纯工具 ------------------------------ */

function cloneLease(lease: PumpLease): PumpLease {
  return { ...lease, conflictsWith: [...lease.conflictsWith] }
}

/** 剥掉 IndexedDB 行字段，得到可进快照/补录包的纯租约 */
function stripRowFields(row: PumpLeaseRow): PumpLease {
  return {
    id: row.id,
    title: row.title,
    jobType: row.jobType,
    drainMode: row.drainMode,
    sourceTankId: row.sourceTankId,
    targetTankId: row.targetTankId,
    volumeL: row.volumeL,
    startAt: row.startAt,
    endAt: row.endAt,
    submittedAt: row.submittedAt,
    deviceId: row.deviceId,
    operationId: row.operationId,
    state: row.state,
    rejectReason: row.rejectReason,
    suggestedStartAt: row.suggestedStartAt,
    conflictsWith: [...row.conflictsWith],
    rerunNo: row.rerunNo
  }
}

function toRow(lease: PumpLease): PumpLeaseRow {
  const now = Date.now()
  return { ...cloneLease(lease), revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

function deviceIdFromStorage(): string {
  try {
    const existed = localStorage.getItem(PUMP_DEVICE_KEY)
    if (existed) return existed
    const id = `tablet-${Math.random().toString(36).slice(2, 8)}`
    localStorage.setItem(PUMP_DEVICE_KEY, id)
    return id
  } catch {
    return `tablet-${Math.random().toString(36).slice(2, 8)}`
  }
}
