/**
 * 泵机交接排班核心领域服务（无 UI 依赖，可被 store / 页面 / 测试直接调用）。
 *
 * 一张占用账（pumpLedger）同时承载：
 *  - 发酵罐液体流水（kind=liquid）：液位由流水求和派生
 *  - 泵机时段租约（kind=lease）：全车间唯一移动泵，时段重叠时只保留先提交者
 *  - 倒罐作业（kind=job）：派工 / 拒绝（写明差量）/ 撤单 / 失效重排 / 执行
 *
 * 每个写动作落库前先存 PumpSnapshot，写入失败或需要撤销时可从快照恢复。
 */
import {
  db,
  listPumpLedger,
  bulkPutPumpLedger,
  listPumpBackfill,
  bulkPutPumpBackfill,
  listPumpSnapshots,
  removePumpSnapshot,
  updateTank,
  ROW_REVISION,
  type PumpLedgerRow,
  type PumpLeaseRow,
  type PumpJobRow,
  type PumpLiquidRow,
  type PumpBackfillRow,
  type PumpSnapshotRow,
  type TankRow
} from './db'
import {
  PUMP_ID,
  isLeaseActive,
  isUnexecuted,
  type DispatchResult,
  type JobState,
  type LeaseState,
  type PumpBackfill,
  type PumpJobForm,
  type PumpLeaseEntry,
  type PumpLedgerEntry,
  type PumpLiquidEntry,
  type PumpSnapshot,
  type SnapshotTank,
  type SubmitChannel
} from '@/types/pump'
import { createId, nowIso } from './uuid'

/** 自动改期时的时段对齐粒度（毫秒） */
const SLOT_GRID_MS = 30 * 60 * 1000
/** 自动向后找空时段时最多探测的步长数（覆盖 30 天） */
const MAX_SLOT_STEPS = 30 * 48
/** 本机最多留存的写入快照数量 */
const SNAPSHOT_KEEP = 10

type JobRow = PumpJobRow
type LeaseRow = PumpLeaseRow
type LiquidRow = PumpLiquidRow

/* ------------------------------ 纯函数工具 ------------------------------ */

/** 两个半开区间 [s1,e1) / [s2,e2) 是否重叠 */
export function intervalsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  return s1 < e2 && s2 < e1
}

function alignGrid(iso: string): number {
  const t = new Date(iso).getTime()
  return Math.ceil(t / SLOT_GRID_MS) * SLOT_GRID_MS
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function jobsOf(rows: PumpLedgerRow[]): JobRow[] {
  return rows.filter((r): r is JobRow => r.kind === 'job')
}

function leasesOf(rows: PumpLedgerRow[]): LeaseRow[] {
  return rows.filter((r): r is LeaseRow => r.kind === 'lease')
}

function liquidsOf(rows: PumpLedgerRow[]): LiquidRow[] {
  return rows.filter((r): r is LiquidRow => r.kind === 'liquid')
}

/** 当前在罐液位：该罐全部液体流水求和 */
export function currentLevel(rows: PumpLedgerRow[], tankId: string): number {
  return liquidsOf(rows)
    .filter((r) => r.tankId === tankId)
    .reduce((sum, r) => sum + r.deltaL, 0)
}

/** 某作业的有效/待确认租约（通过 jobId 反查） */
export function activeLeaseOfJob(rows: PumpLedgerRow[], jobId: string): LeaseRow | null {
  return (
    leasesOf(rows).find((l) => l.jobId === jobId && isLeaseActive(l.state)) ?? null
  )
}

/**
 * 某时刻之前已经落地的倒罐对罐液位的净影响：
 * 已派工 / 待确认且租约在 before 之前结束的作业，目标罐 +volume、源罐 -volume。
 * 派工校验目标罐空余容量时把这些「排队中的倒入」也算进去，避免两份派工同时通过。
 */
function reservedFlow(rows: PumpLedgerRow[], tankId: string, beforeStart: string): number {
  let flow = 0
  for (const job of jobsOf(rows)) {
    if (job.state !== '已派工' && job.state !== '待确认') continue
    const lease = activeLeaseOfJob(rows, job.id)
    if (!lease || lease.endAt > beforeStart) continue
    if (job.targetTankId === tankId) flow += job.volumeL
    if (job.sourceTankId === tankId) flow -= job.volumeL
  }
  return flow
}

/** 与指定窗口冲突、且不排除某条租约的在占用租约 */
export function conflictingLeases(
  rows: PumpLedgerRow[],
  startAt: string,
  endAt: string,
  excludeLeaseId: string | null = null
): LeaseRow[] {
  return leasesOf(rows).filter(
    (l) =>
      l.id !== excludeLeaseId &&
      isLeaseActive(l.state) &&
      intervalsOverlap(startAt, endAt, l.startAt, l.endAt)
  )
}

/**
 * 从期望起点向后找第一个没有在占用租约的对齐时段。
 * 找不到时返回 null（理论上探测窗口足够大不会发生）。
 */
export function nextFreeSlot(
  rows: PumpLedgerRow[],
  requestedStartAt: string,
  durationMin: number,
  excludeLeaseId: string | null = null
): { startAt: string; endAt: string } | null {
  const durationMs = durationMin * 60 * 1000
  let cursor = alignGrid(requestedStartAt)
  for (let i = 0; i < MAX_SLOT_STEPS; i += 1) {
    const startAt = toIso(cursor)
    const endAt = toIso(cursor + durationMs)
    if (conflictingLeases(rows, startAt, endAt, excludeLeaseId).length === 0) {
      return { startAt, endAt }
    }
    cursor += SLOT_GRID_MS
  }
  return null
}

/** 生成下一个可读作业编号 JOB-001…（重排后缀另算） */
function nextJobCode(rows: PumpLedgerRow[]): string {
  let max = 0
  for (const job of jobsOf(rows)) {
    const match = /^JOB-(\d+)/.exec(job.code)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `JOB-${String(max + 1).padStart(3, '0')}`
}

/** 重排编号：JOB-002 → JOB-002-R1，再次重排 → -R2 */
function rerunCode(code: string, rows: PumpLedgerRow[]): string {
  let n = 1
  const base = code.replace(/-R\d+$/, '')
  while (rows.some((r) => r.kind === 'job' && r.code === `${base}-R${n}`)) n += 1
  return `${base}-R${n}`
}

function stampLedger(entry: PumpLedgerEntry, now: number): PumpLedgerRow {
  return { ...(entry as object), revision: ROW_REVISION, createdAt: now, updatedAt: now } as PumpLedgerRow
}

/* ------------------------------ 派工校验 ------------------------------ */

export interface ValidationInput {
  rows: PumpLedgerRow[]
  tanksById: Map<string, TankRow>
  sourceTankId: string
  targetTankId: string
  volumeL: number
  requireEmpty: boolean
  /** 校验时刻（排队倒入的截止线），一般用作业期望开始时间 */
  beforeStart: string
}

/**
 * 派工前置校验：
 *  - 源 / 目标罐必须存在、不能同罐、目标罐不能在清洗
 *  - 目标罐空余容量（含排队倒入）不足 → 拒绝，写明还差多少 L
 *  - 源罐存量不足 → 拒绝，写明差多少 L
 *  - 要求清空但倒出后仍有剩 → 拒绝，写明源罐还剩多少 L
 * 返回 null 表示通过，否则返回人类可读拒绝原因。
 */
export function validateDispatch(input: ValidationInput): string | null {
  const { rows, tanksById, sourceTankId, targetTankId, volumeL, requireEmpty, beforeStart } = input
  const source = tanksById.get(sourceTankId)
  const target = tanksById.get(targetTankId)
  if (!source) return '拒绝派工：源罐不存在或已删除。'
  if (!target) return '拒绝派工：目标罐不存在或已删除。'
  if (sourceTankId === targetTankId) return '拒绝派工：源罐与目标罐不能是同一个罐。'
  if (target.state === '清洗中') return `拒绝派工：目标罐 ${target.code} 正在清洗，清洗未完成不能接酒。`

  if (volumeL <= 0) return '拒绝派工：倒罐量必须大于 0。'

  const targetLevel = currentLevel(rows, targetTankId) + reservedFlow(rows, targetTankId, beforeStart)
  const targetFree = target.capacityL - targetLevel
  if (volumeL > targetFree) {
    return `拒绝派工：目标罐 ${target.code} 空余容量仅 ${targetFree}L，倒入 ${volumeL}L 还差 ${volumeL - targetFree}L。`
  }

  const sourceLevel = currentLevel(rows, sourceTankId) + reservedFlow(rows, sourceTankId, beforeStart)
  if (sourceLevel < volumeL) {
    return `拒绝派工：源罐 ${source.code} 现存仅 ${sourceLevel}L，倒出 ${volumeL}L 不足 ${volumeL - sourceLevel}L。`
  }
  if (requireEmpty && sourceLevel - volumeL !== 0) {
    return `拒绝派工：要求源罐清空，但 ${source.code} 倒出后仍剩 ${sourceLevel - volumeL}L，差量 ${sourceLevel - volumeL}L 未排空。`
  }
  return null
}

/* ------------------------------ 快照 ------------------------------ */

function snapshotTanks(tanks: TankRow[]): SnapshotTank[] {
  return tanks.map((t) => ({
    id: t.id,
    code: t.code,
    capacityL: t.capacityL,
    material: t.material,
    tempControl: t.tempControl,
    state: t.state
  }))
}

/** 在当前事务内拍一份写入前快照（占用账 + outbox + 罐表） */
async function captureSnapshot(tx: {
  pumpLedger: typeof db.pumpLedger
  pumpBackfill: typeof db.pumpBackfill
  tanks: typeof db.tanks
  pumpSnapshots: typeof db.pumpSnapshots
}, label: string): Promise<void> {
  const [ledger, outbox, tanks] = await Promise.all([
    tx.pumpLedger.toArray(),
    tx.pumpBackfill.toArray(),
    tx.tanks.toArray()
  ])
  const createdAt = nowIso()
  const snapshot: PumpSnapshot = {
    id: createId('psnap'),
    label,
    createdAt,
    ledger: ledger.map(stripStamp) as PumpLedgerEntry[],
    outbox: outbox.map(stripStamp) as PumpBackfill[],
    tanks: snapshotTanks(tanks)
  }
  await tx.pumpSnapshots.put({ ...snapshot, revision: ROW_REVISION, updatedAt: Date.now() })
  // 只留最近 N 份
  const all = await tx.pumpSnapshots.toArray()
  const stale = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(SNAPSHOT_KEEP)
  for (const item of stale) {
    await tx.pumpSnapshots.delete(item.id)
  }
}

function stripStamp<T extends { revision?: number; createdAt?: number; updatedAt?: number }>(row: T): T {
  const copy = { ...row } as Record<string, unknown>
  delete copy.revision
  delete copy.createdAt
  delete copy.updatedAt
  return copy as T
}

export async function listSnapshots(): Promise<PumpSnapshotRow[]> {
  return listPumpSnapshots()
}

/**
 * 从快照恢复：占用账 / outbox 全量回到快照时刻，罐号也一并还原。
 * 恢复前再拍一份「恢复前」快照，保证恢复本身可撤销。
 */
export async function restoreSnapshot(snapshotId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
    async () => {
      const target = await db.pumpSnapshots.get(snapshotId)
      if (!target) throw new Error('快照不存在，无法恢复')
      await captureSnapshot(
        {
          pumpLedger: db.pumpLedger,
          pumpBackfill: db.pumpBackfill,
          tanks: db.tanks,
          pumpSnapshots: db.pumpSnapshots
        },
        `恢复「${target.label}」前的自动快照`
      )
      await db.pumpLedger.clear()
      await db.pumpBackfill.clear()
      const ts = Date.now()
      await db.pumpLedger.bulkPut(
        target.ledger.map(
          (e) =>
            ({ ...(e as object), revision: ROW_REVISION, createdAt: ts, updatedAt: ts }) as unknown as PumpLedgerRow
        )
      )
      await db.pumpBackfill.bulkPut(
        target.outbox.map(
          (o) =>
            ({ ...(o as object), revision: ROW_REVISION, createdAt: ts, updatedAt: ts }) as PumpBackfillRow
        )
      )
      for (const tank of target.tanks) {
        await db.tanks.update(tank.id, {
          code: tank.code,
          capacityL: tank.capacityL,
          material: tank.material,
          tempControl: tank.tempControl,
          state: tank.state,
          updatedAt: ts
        } as never)
      }
    }
  )
}

export async function deleteSnapshot(snapshotId: string): Promise<void> {
  await removePumpSnapshot(snapshotId)
}

/* ------------------------------ 派工 ------------------------------ */

export interface DispatchOptions {
  channel?: SubmitChannel
  submittedAt?: string
  device?: string
  /** 在线提交撞期时是否自动改期到下一空时段，默认 true */
  autoReschedule?: boolean
  /** 关联的断网补录 outbox 条目 id（合并路径回填用） */
  backfillId?: string
  snapshotLabel?: string
}

/**
 * 核心派工：先校验容量 / 清空，再按「先提交者持约」分配泵机时段。
 *  - 校验不过：作业落为「待派工」，rejectReason 写明差量，不发租约
 *  - 在线撞期：保留先提交者，新作业自动改期到下一空时段（状态已派工）
 *  - 断网补录撞期：双方并列「待确认」，交班长裁决
 * 整个过程在一个事务里，落库前先拍快照；任一步失败事务回滚，可用快照恢复。
 */
export async function dispatchJob(form: PumpJobForm, options: DispatchOptions = {}): Promise<DispatchResult> {
  const channel: SubmitChannel = options.channel ?? '在线'
  const submittedAt = options.submittedAt ?? nowIso()
  const device = options.device ?? form.device
  const autoReschedule = options.autoReschedule ?? true

  const result = await db.transaction(
    'rw',
    [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
    async (): Promise<DispatchResult> => {
      await captureSnapshot(
        {
          pumpLedger: db.pumpLedger,
          pumpBackfill: db.pumpBackfill,
          tanks: db.tanks,
          pumpSnapshots: db.pumpSnapshots
        },
        options.snapshotLabel ?? `派工 ${device} ${form.sourceTankId}→${form.targetTankId}`
      )

      const rows = await db.pumpLedger.toArray()
      const tanks = await db.tanks.toArray()
      const tanksById = new Map(tanks.map((t) => [t.id, t]))
      const now = Date.now()

      const add = async (entry: PumpLedgerEntry): Promise<void> => {
        const stamped = stampLedger(entry, now)
        await db.pumpLedger.put(stamped)
        rows.push(stamped)
      }

      const jobId = createId('pj')
      const code = nextJobCode(rows)
      const baseJob: JobRow = {
        kind: 'job',
        id: jobId,
        code,
        sourceTankId: form.sourceTankId,
        targetTankId: form.targetTankId,
        volumeL: form.volumeL,
        requireEmpty: form.requireEmpty,
        requestedStartAt: form.requestedStartAt,
        durationMin: form.durationMin,
        state: '待派工',
        rejectReason: null,
        leaseId: null,
        rerunOf: null,
        submittedAt,
        submitChannel: channel,
        device,
        operator: form.operator,
        revision: ROW_REVISION,
        createdAt: now,
        updatedAt: now
      }

      const durationMs = form.durationMin * 60 * 1000
      const requestedEnd = toIso(new Date(form.requestedStartAt).getTime() + durationMs)

      // 1) 容量 / 清空校验
      const invalidReason = validateDispatch({
        rows,
        tanksById,
        sourceTankId: form.sourceTankId,
        targetTankId: form.targetTankId,
        volumeL: form.volumeL,
        requireEmpty: form.requireEmpty,
        beforeStart: form.requestedStartAt
      })
      if (invalidReason) {
        const rejected: JobRow = { ...baseJob, state: '待派工', rejectReason: invalidReason }
        await db.pumpLedger.put(rejected)
        await linkBackfill(options.backfillId, [jobId], invalidReason, '冲突待确认')
        return {
          status: '拒绝派工',
          jobId,
          leaseId: null,
          message: invalidReason,
          startAt: null,
          endAt: null
        }
      }

      // 2) 时段冲突：先提交者持约
      const hits = conflictingLeases(rows, form.requestedStartAt, requestedEnd)

      if (hits.length > 0 && channel === '断网补录') {
        // 断网补录合并撞期：既有租约与新租约并列待确认
        const first = hits.slice().sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0]
        const leaseId = createId('pls')
        const pendingJob: JobRow = {
          ...baseJob,
          state: '待确认',
          leaseId,
          rejectReason: `断网补录与作业 ${jobCodeOf(rows, first.jobId)} 的泵机时段 ${fmtRange(
            first.startAt,
            first.endAt
          )} 重叠，并列待班长确认。`
        }
        const pendingLease: PumpLeaseEntry = {
          kind: 'lease',
          id: leaseId,
          pumpId: PUMP_ID,
          startAt: form.requestedStartAt,
          endAt: requestedEnd,
          jobId,
          state: '待确认',
          submittedAt,
          device,
          conflictsWith: first.id,
          note: `${device} 断网补录，合并时与 ${first.id} 撞期，并列待确认`
        }
        await add(pendingLease)
        await db.pumpLedger.put(pendingJob)
        rows.push(pendingJob)
        // 原来先到的租约也并列待确认（不再独占）
        await db.pumpLedger.update(first.id, { state: '待确认' as LeaseState, updatedAt: now } as never)
        const firstJob = jobsOf(rows).find((j) => j.id === first.jobId)
        if (firstJob && firstJob.state === '已派工') {
          await db.pumpLedger.update(firstJob.id, {
            state: '待确认' as JobState,
            rejectReason: `与断网补录作业 ${code} 时段重叠，并列待班长确认。`,
            updatedAt: now
          } as never)
        }
        await linkBackfill(options.backfillId, [jobId, leaseId], pendingJob.rejectReason ?? '重叠待确认', '冲突待确认')
        return {
          status: '待确认',
          jobId,
          leaseId,
          message: pendingJob.rejectReason ?? '重叠时段并列待确认',
          startAt: form.requestedStartAt,
          endAt: requestedEnd
        }
      }

      // 在线撞期：保留先提交租约，新作业自动改期
      let startAt = form.requestedStartAt
      let endAt = requestedEnd
      let moved = false
      if (hits.length > 0) {
        if (!autoReschedule) {
          const holder = hits.slice().sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0]
          const reason = `拒绝派工：泵机时段 ${fmtRange(startAt, endAt)} 已被先提交的作业 ${jobCodeOf(
            rows,
            holder.jobId
          )} 占用，只保留先提交租约。`
          const rejected: JobRow = { ...baseJob, state: '待派工', rejectReason: reason }
          await db.pumpLedger.put(rejected)
          return { status: '拒绝派工', jobId, leaseId: null, message: reason, startAt: null, endAt: null }
        }
        const slot = nextFreeSlot(rows, form.requestedStartAt, form.durationMin)
        if (!slot) {
          const reason = '拒绝派工：未来 30 天内找不到空闲泵机时段。'
          const rejected: JobRow = { ...baseJob, state: '待派工', rejectReason: reason }
          await db.pumpLedger.put(rejected)
          return { status: '拒绝派工', jobId, leaseId: null, message: reason, startAt: null, endAt: null }
        }
        startAt = slot.startAt
        endAt = slot.endAt
        moved = true
      }

      // 3) 发租约、落已派工作业
      const leaseId = createId('pls')
      const lease: PumpLeaseEntry = {
        kind: 'lease',
        id: leaseId,
        pumpId: PUMP_ID,
        startAt,
        endAt,
        jobId,
        state: '有效',
        submittedAt,
        device,
        conflictsWith: null,
        note: moved ? '原时段被先提交租约占用，自动改期' : '先提交，持有租约'
      }
      const job: JobRow = {
        ...baseJob,
        state: '已派工',
        leaseId,
        rejectReason: null
      }
      await add(lease)
      await db.pumpLedger.put(job)
      rows.push(job)
      await linkBackfill(options.backfillId, [jobId, leaseId], null, '已合并')
      return {
        status: moved ? '自动改期' : '派工成功',
        jobId,
        leaseId,
        message: moved
          ? `原时段已被先提交作业占用，已自动改期至 ${fmtRange(startAt, endAt)}。`
          : `派工成功，泵机时段 ${fmtRange(startAt, endAt)}。`,
        startAt,
        endAt
      }
    }
  )
  return result
}

function jobCodeOf(rows: PumpLedgerRow[], jobId: string): string {
  const job = jobsOf(rows).find((j) => j.id === jobId)
  return job ? job.code : jobId
}

function fmtRange(startAt: string, endAt: string): string {
  const p = (iso: string) => {
    const d = new Date(iso)
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
    const dd = String(d.getUTCDate()).padStart(2, '0')
    const hh = String(d.getUTCHours()).padStart(2, '0')
    const mi = String(d.getUTCMinutes()).padStart(2, '0')
    return `${d.getUTCFullYear()}-${mm}-${dd} ${hh}:${mi}`
  }
  return `${p(startAt)}–${p(endAt)}`
}

/** 合并路径回填 outbox 条目状态 */
async function linkBackfill(
  backfillId: string | undefined,
  mergedEntryIds: string[],
  note: string | null,
  state: PumpBackfill['state']
): Promise<void> {
  if (!backfillId) return
  await db.pumpBackfill.update(backfillId, {
    state,
    mergedEntryIds,
    resultNote: note,
    updatedAt: Date.now()
  } as never)
}

/* --------------------------- 撤单 / 失效重排 --------------------------- */

/**
 * 撤单：该作业置「已撤单」并释放租约；
 * 随后所有未执行作业立即失效并按提交时刻先后重新派工（重建干净排班）。
 */
export async function cancelJob(jobId: string): Promise<string[]> {
  return invalidateAndRerun({
    triggerJobId: jobId,
    label: `撤单 ${jobId}`,
    cancelTrigger: true
  })
}

/**
 * 罐号改动后调用：引用该罐的未执行作业立即失效并重排。
 * 罐实体 id 不变（只改罐号），重排作业继续引用同一 tankId。
 */
export async function tankCodeChangedRerun(tankId: string, oldCode: string): Promise<string[]> {
  return invalidateAndRerun({
    label: `罐号改动 ${oldCode}`,
    tankIdFilter: tankId,
    cancelTrigger: false
  })
}

interface RerunOptions {
  label: string
  triggerJobId?: string
  tankIdFilter?: string
  /** 触发者本身是否撤单（撤单不重排自己） */
  cancelTrigger: boolean
}

async function invalidateAndRerun(opts: RerunOptions): Promise<string[]> {
  const newJobIds: string[] = []
  await db.transaction(
    'rw',
    [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
    async () => {
      await captureSnapshot(
        {
          pumpLedger: db.pumpLedger,
          pumpBackfill: db.pumpBackfill,
          tanks: db.tanks,
          pumpSnapshots: db.pumpSnapshots
        },
        opts.label
      )
      const now = Date.now()
      const rows = await db.pumpLedger.toArray()

      const touched = (job: JobRow): boolean => {
        if (!isUnexecuted(job.state)) return false
        if (opts.triggerJobId && opts.cancelTrigger) return true // 撤单：波及全部未执行作业
        if (opts.tankIdFilter) return job.sourceTankId === opts.tankIdFilter || job.targetTankId === opts.tankIdFilter
        return false
      }

      // 先撤触发作业 / 批量失效，并释放租约
      const victims = jobsOf(rows).filter(touched)
      for (const job of victims) {
        const nextState: JobState = opts.cancelTrigger && job.id === opts.triggerJobId ? '已撤单' : '已失效'
        await db.pumpLedger.update(job.id, { state: nextState, updatedAt: now } as never)
        const lease = activeLeaseOfJob(rows, job.id)
        if (lease) {
          await db.pumpLedger.update(lease.id, { state: '已释放' as LeaseState, updatedAt: now } as never)
        }
      }

      // 需要重排的作业：失效者（撤单的触发作业本身不重排），按原提交时刻排队
      const rerunCandidates = victims
        .filter((j) => !(opts.cancelTrigger && j.id === opts.triggerJobId))
        .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))

      // 紧凑重排游标：从前一批腾出的最早时段起向后排，
      // 既不早于作业自身的期望开始时间，又能吃掉撤单/清洗空出来的泵机时段。
      const freedStarts = victims
        .map((j) => activeLeaseOfJob(rows, j.id)?.startAt ?? j.requestedStartAt)
        .sort()
      let cursorIso = freedStarts[0] ?? rerunCandidates[0]?.requestedStartAt

      // 用重排作业替换内存视图后逐个走派工（串行，保证先排的占时段）
      const liveRows = await db.pumpLedger.toArray()
      for (const old of rerunCandidates) {
        const floor = old.requestedStartAt > (cursorIso ?? '') ? old.requestedStartAt : cursorIso
        const successorForm: PumpJobForm = {
          sourceTankId: old.sourceTankId,
          targetTankId: old.targetTankId,
          volumeL: old.volumeL,
          requireEmpty: old.requireEmpty,
          requestedStartAt: floor ?? old.requestedStartAt,
          durationMin: old.durationMin,
          device: old.device,
          operator: old.operator
        }
        // 在同一事务内直接内联派工（快照已在动作开头拍过）
        const successor = await inlineDispatch(liveRows, successorForm, {
          channel: '在线',
          submittedAt: old.submittedAt,
          device: old.device,
          rerunOf: old.id,
          code: rerunCode(old.code, liveRows)
        })
        newJobIds.push(successor.jobId)
        // 游标推进到本次排到的结束时刻，下一条紧接着排
        if (successor.endAt) cursorIso = successor.endAt
      }
    }
  )
  return newJobIds
}

interface InlineDispatchOptions {
  channel: SubmitChannel
  submittedAt: string
  device: string
  rerunOf: string | null
  code: string
}

/** 事务内派工：复用校验 / 时段逻辑，调用方已拍过快照（重排不再重复拍） */
async function inlineDispatch(
  rows: PumpLedgerRow[],
  form: PumpJobForm,
  opts: InlineDispatchOptions
): Promise<DispatchResult> {
  const tanks = await db.tanks.toArray()
  const tanksById = new Map(tanks.map((t) => [t.id, t]))
  const now = Date.now()

  const jobId = createId('pj')
  const baseJob: JobRow = {
    kind: 'job',
    id: jobId,
    code: opts.code,
    sourceTankId: form.sourceTankId,
    targetTankId: form.targetTankId,
    volumeL: form.volumeL,
    requireEmpty: form.requireEmpty,
    requestedStartAt: form.requestedStartAt,
    durationMin: form.durationMin,
    state: '待派工',
    rejectReason: null,
    leaseId: null,
    rerunOf: opts.rerunOf,
    submittedAt: opts.submittedAt,
    submitChannel: opts.channel,
    device: opts.device,
    operator: form.operator,
    revision: ROW_REVISION,
    createdAt: now,
    updatedAt: now
  }

  const invalidReason = validateDispatch({
    rows,
    tanksById,
    sourceTankId: form.sourceTankId,
    targetTankId: form.targetTankId,
    volumeL: form.volumeL,
    requireEmpty: form.requireEmpty,
    beforeStart: form.requestedStartAt
  })
  if (invalidReason) {
    await db.pumpLedger.put({ ...baseJob, state: '待派工', rejectReason: invalidReason })
    return { status: '拒绝派工', jobId, leaseId: null, message: invalidReason, startAt: null, endAt: null }
  }

  // 重排统一自动找下一空时段
  const slot = nextFreeSlot(rows, form.requestedStartAt, form.durationMin)
  if (!slot) {
    const reason = '拒绝派工：未来 30 天内找不到空闲泵机时段。'
    await db.pumpLedger.put({ ...baseJob, state: '待派工', rejectReason: reason })
    return { status: '拒绝派工', jobId, leaseId: null, message: reason, startAt: null, endAt: null }
  }

  const leaseId = createId('pls')
  const lease: PumpLeaseEntry = {
    kind: 'lease',
    id: leaseId,
    pumpId: PUMP_ID,
    startAt: slot.startAt,
    endAt: slot.endAt,
    jobId,
    state: '有效',
    submittedAt: opts.submittedAt,
    device: opts.device,
    conflictsWith: null,
    note: opts.rerunOf ? '失效重排，自动排入下一空时段' : '重排持约'
  }
  await db.pumpLedger.put({ ...lease, revision: ROW_REVISION, createdAt: now, updatedAt: now } as PumpLeaseRow)
  rows.push({ ...lease, revision: ROW_REVISION, createdAt: now, updatedAt: now } as PumpLeaseRow)
  await db.pumpLedger.put({ ...baseJob, state: '已派工', leaseId })
  rows.push({ ...baseJob, state: '已派工', leaseId })
  return {
    status: '派工成功',
    jobId,
    leaseId,
    message: `重排成功，泵机时段 ${fmtRange(slot.startAt, slot.endAt)}。`,
    startAt: slot.startAt,
    endAt: slot.endAt
  }
}

/* ------------------------------ 执行作业 ------------------------------ */

/**
 * 执行：作业置「已执行」、租约「已释放」，并按倒罐量追加两条液体流水
 * （源罐 -volume，目标罐 +volume）。待确认作业不能直接执行。
 */
export async function executeJob(jobId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
    async () => {
    await captureSnapshot(
      {
        pumpLedger: db.pumpLedger,
        pumpBackfill: db.pumpBackfill,
        tanks: db.tanks,
        pumpSnapshots: db.pumpSnapshots
      },
      `执行作业 ${jobId}`
    )
    const now = Date.now()
    const job = (await db.pumpLedger.get(jobId)) as JobRow | undefined
    if (!job || job.kind !== 'job') throw new Error('作业不存在')
    if (job.state === '已执行') throw new Error('作业已执行，请勿重复操作')
    if (job.state === '待确认') throw new Error('该作业时段重叠待确认，请先由班长裁决')
    if (job.state !== '已派工') throw new Error(`当前状态「${job.state}」不能执行`)
    const lease = job.leaseId ? ((await db.pumpLedger.get(job.leaseId)) as LeaseRow | undefined) : undefined
    const at = lease ? lease.endAt : nowIso()

    const out: PumpLiquidEntry = {
      kind: 'liquid',
      id: createId('pl'),
      at,
      tankId: job.sourceTankId,
      deltaL: -job.volumeL,
      reason: '倒罐',
      jobId,
      device: job.device,
      note: `${job.code} 倒出`
    }
    const into: PumpLiquidEntry = {
      kind: 'liquid',
      id: createId('pl'),
      at,
      tankId: job.targetTankId,
      deltaL: job.volumeL,
      reason: '倒罐',
      jobId,
      device: job.device,
      note: `${job.code} 接入`
    }
    await db.pumpLedger.bulkPut([
      { ...out, revision: ROW_REVISION, createdAt: now, updatedAt: now },
      { ...into, revision: ROW_REVISION, createdAt: now, updatedAt: now }
    ])
    await db.pumpLedger.update(jobId, { state: '已执行' as JobState, rejectReason: null, updatedAt: now } as never)
    if (lease) {
      await db.pumpLedger.update(lease.id, { state: '已释放' as LeaseState, updatedAt: now } as never)
    }
  })
}

/* --------------------------- 待确认冲突裁决 --------------------------- */

/**
 * 班长裁决重叠时段：保留 keepJobId（转「已派工」/租约「有效」），
 * 另一条 dropJobId 立即失效并重排到下一空时段。
 */
export async function resolveConflict(keepJobId: string, dropJobId: string): Promise<string | null> {
  let rerunId: string | null = null
  await db.transaction(
    'rw',
    [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
    async () => {
      await captureSnapshot(
        {
          pumpLedger: db.pumpLedger,
          pumpBackfill: db.pumpBackfill,
          tanks: db.tanks,
          pumpSnapshots: db.pumpSnapshots
        },
        `裁决冲突 保留 ${keepJobId}`
      )
      const now = Date.now()
      const rows = await db.pumpLedger.toArray()
      const keep = jobsOf(rows).find((j) => j.id === keepJobId)
      const drop = jobsOf(rows).find((j) => j.id === dropJobId)
      if (!keep || !drop) throw new Error('冲突作业不存在，无法裁决')

      // 释放 / 失效落败方
      const dropLease = activeLeaseOfJob(rows, dropJobId)
      await db.pumpLedger.update(dropJobId, { state: '已失效' as JobState, updatedAt: now } as never)
      if (dropLease) {
        await db.pumpLedger.update(dropLease.id, { state: '已释放' as LeaseState, updatedAt: now } as never)
      }
      // 胜出方持约
      const keepLease = activeLeaseOfJob(rows, keepJobId)
      await db.pumpLedger.update(keepJobId, {
        state: '已派工' as JobState,
        rejectReason: null,
        updatedAt: now
      } as never)
      if (keepLease) {
        await db.pumpLedger.update(keepLease.id, {
          state: '有效' as LeaseState,
          conflictsWith: null,
          note: '班长裁决保留',
          updatedAt: now
        } as never)
      }

      // 落败方重排到下一空时段
      const liveRows = await db.pumpLedger.toArray()
      const result = await inlineDispatch(
        liveRows,
        {
          sourceTankId: drop.sourceTankId,
          targetTankId: drop.targetTankId,
          volumeL: drop.volumeL,
          requireEmpty: drop.requireEmpty,
          requestedStartAt: drop.requestedStartAt,
          durationMin: drop.durationMin,
          device: drop.device,
          operator: drop.operator
        },
        {
          channel: '在线',
          submittedAt: drop.submittedAt,
          device: drop.device,
          rerunOf: drop.id,
          code: rerunCode(drop.code, liveRows)
        }
      )
      rerunId = result.jobId
    }
  )
  return rerunId
}

/* --------------------------- 断网补录与合并 --------------------------- */

/** 平板断网：先把提交暂存进 outbox（不触碰占用账） */
export async function enqueueBackfill(
  input: Omit<PumpBackfill, 'id' | 'state' | 'mergedEntryIds' | 'resultNote' | 'submittedAt'> & {
    submittedAt?: string
  }
): Promise<string> {
  const id = createId('pbf')
  const row: PumpBackfillRow = {
    ...input,
    id,
    submittedAt: input.submittedAt ?? nowIso(),
    state: '待合并',
    mergedEntryIds: [],
    resultNote: null,
    revision: ROW_REVISION,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  await db.pumpBackfill.put(row)
  return id
}

/** 合并单条断网补录：液位直接入流水；倒罐派工走派工（撞期则并列待确认） */
export async function mergeBackfill(backfillId: string): Promise<DispatchResult | { status: '液位入账'; message: string }> {
  const item = await db.pumpBackfill.get(backfillId)
  if (!item) throw new Error('补录条目不存在')
  if (item.state === '已合并') throw new Error('该补录已合并，请勿重复合并')

  if (item.kind === '液位补录') {
    if (!item.liquid) throw new Error('液位补录缺少载荷')
    await db.transaction(
      'rw',
      [db.pumpLedger, db.pumpBackfill, db.pumpSnapshots, db.tanks],
      async () => {
        await captureSnapshot(
          {
            pumpLedger: db.pumpLedger,
            pumpBackfill: db.pumpBackfill,
            tanks: db.tanks,
            pumpSnapshots: db.pumpSnapshots
          },
          `合并液位补录 ${item.device}`
        )
      const now = Date.now()
      const entry: PumpLiquidEntry = {
        kind: 'liquid',
        id: createId('pl'),
        at: item.occurredAt,
        tankId: item.liquid!.tankId,
        deltaL: item.liquid!.deltaL,
        reason: item.liquid!.reason,
        jobId: null,
        device: item.device,
        note: `[断网补录] ${item.liquid!.note}`
      }
      await db.pumpLedger.put({ ...entry, revision: ROW_REVISION, createdAt: now, updatedAt: now })
      await db.pumpBackfill.update(item.id, {
        state: '已合并',
        mergedEntryIds: [entry.id],
        resultNote: `液位变动 ${entry.deltaL}L 已入账`,
        updatedAt: now
      } as never)
    })
    return { status: '液位入账', message: '夜班液位补录已写入占用账流水。' }
  }

  // 倒罐派工：保留断网时的提交时刻，合并时撞期 → 并列待确认
  const job = item.job
  if (!job) throw new Error('倒罐派工缺少载荷')
  return dispatchJob(
    {
      sourceTankId: job.sourceTankId,
      targetTankId: job.targetTankId,
      volumeL: job.volumeL,
      requireEmpty: job.requireEmpty,
      requestedStartAt: job.requestedStartAt,
      durationMin: job.durationMin,
      device: item.device,
      operator: job.operator
    },
    {
      channel: '断网补录',
      submittedAt: item.submittedAt,
      device: item.device,
      backfillId: item.id,
      autoReschedule: false,
      snapshotLabel: `合并断网派工 ${item.device}`
    }
  )
}

/** 一键合并全部待合并补录（按提交时刻先后） */
export async function mergeAllBackfill(): Promise<void> {
  const pending = (await listPumpBackfill()).filter((b) => b.state === '待合并')
  for (const item of pending.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    await mergeBackfill(item.id)
  }
}

/* ------------------------------ 查询门面 ------------------------------ */

export interface PumpBoardData {
  ledger: PumpLedgerRow[]
  backfill: PumpBackfillRow[]
  snapshots: PumpSnapshotRow[]
  tanks: TankRow[]
}

/** 页面 / store 一次性读取泵机模块全部数据 */
export async function loadPumpBoard(): Promise<PumpBoardData> {
  const [ledger, backfill, snapshots, tanks] = await Promise.all([
    listPumpLedger(),
    listPumpBackfill(),
    listPumpSnapshots(),
    db.tanks.toArray()
  ])
  return { ledger, backfill, snapshots, tanks }
}

/** 改罐号的统一入口：先失效重排引用该罐的未执行作业，再写新罐号 */
export async function renameTankCode(tankId: string, nextCode: string): Promise<{ changed: boolean; reruns: string[] }> {
  const tank = await db.tanks.get(tankId)
  if (!tank) throw new Error('发酵罐不存在')
  if (tank.code === nextCode) return { changed: false, reruns: [] }
  const reruns = await tankCodeChangedRerun(tankId, tank.code)
  await updateTank(tankId, { code: nextCode })
  return { changed: true, reruns }
}

// 供本模块外复用批量写（恢复 / 导入路径）
export { bulkPutPumpLedger, bulkPutPumpBackfill }
