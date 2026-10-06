/**
 * 泵机交接看板派生数据：从同一张占用账里读出罐液位、泵机时间线与冲突对。
 * 页面 / 子组件共享这些派生逻辑，避免各自重复求和。
 */
import { computed, type Ref } from 'vue'
import type { PumpBackfillRow, PumpLedgerRow, PumpSnapshotRow, TankRow } from '@/utils/db'
import { currentLevel } from '@/utils/pumpSchedule'
import type { PumpJobEntry, PumpLeaseEntry } from '@/types/pump'

export interface TankLevel {
  tank: TankRow
  levelL: number
  freeL: number
  usageRatio: number
}

export interface TimelineItem {
  lease: Extract<PumpLedgerRow, { kind: 'lease' }>
  job: Extract<PumpLedgerRow, { kind: 'job' }> | null
  day: string
  startLabel: string
  endLabel: string
}

export interface ConflictPair {
  /** 先提交的一方 */
  first: { lease: PumpLeaseEntry; job: PumpJobEntry | null }
  /** 后到的一方 */
  second: { lease: PumpLeaseEntry; job: PumpJobEntry | null }
}

export interface PumpBoardRefs {
  ledger: Ref<PumpLedgerRow[]>
  backfill: Ref<PumpBackfillRow[]>
  snapshots: Ref<PumpSnapshotRow[]>
  tanks: Ref<TankRow[]>
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 统一按 UTC 拆出 YYYY-MM-DD 与 HH:mm（与服务端 fmtRange 保持一致） */
export function fmtClock(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export function fmtDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function usePumpBoard(refs: PumpBoardRefs) {
  const jobs = computed(() =>
    refs.ledger.value.filter((r): r is Extract<PumpLedgerRow, { kind: 'job' }> => r.kind === 'job')
  )
  const leases = computed(() =>
    refs.ledger.value.filter((r): r is Extract<PumpLedgerRow, { kind: 'lease' }> => r.kind === 'lease')
  )
  const liquids = computed(() =>
    refs.ledger.value.filter((r): r is Extract<PumpLedgerRow, { kind: 'liquid' }> => r.kind === 'liquid')
  )

  const jobById = computed(() => new Map(jobs.value.map((j) => [j.id, j])))

  /** 每个罐的当前液位 / 空余容量 / 占用比 */
  const tankLevels = computed<TankLevel[]>(() =>
    refs.tanks.value
      .map((tank) => {
        const levelL = currentLevel(refs.ledger.value, tank.id)
        const freeL = tank.capacityL - levelL
        const usageRatio = tank.capacityL > 0 ? Math.round((levelL / tank.capacityL) * 100) : 0
        return { tank, levelL, freeL, usageRatio }
      })
      .sort((a, b) => a.tank.code.localeCompare(b.tank.code, 'zh-Hans-CN'))
  )

  /** 泵机时间线：按开始时间排序的租约 + 其作业 */
  const timeline = computed<TimelineItem[]>(() =>
    leases.value
      .slice()
      .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.submittedAt.localeCompare(b.submittedAt))
      .map((lease) => ({
        lease,
        job: jobById.value.get(lease.jobId) ?? null,
        day: fmtDay(lease.startAt),
        startLabel: fmtClock(lease.startAt),
        endLabel: fmtClock(lease.endAt)
      }))
  )

  /** 按天分组的时间线 */
  const timelineByDay = computed(() => {
    const map = new Map<string, TimelineItem[]>()
    for (const item of timeline.value) {
      const list = map.get(item.day) ?? []
      list.push(item)
      map.set(item.day, list)
    }
    return Array.from(map.entries()).map(([day, items]) => ({ day, items }))
  })

  /** 当前仍并列待确认的冲突对（一条待确认租约 conflictsWith 另一条） */
  const conflictPairs = computed<ConflictPair[]>(() => {
    const pending = leases.value.filter((l) => l.state === '待确认')
    const seen = new Set<string>()
    const pairs: ConflictPair[] = []
    for (const lease of pending) {
      if (!lease.conflictsWith || seen.has(lease.id)) continue
      const other = leases.value.find((l) => l.id === lease.conflictsWith)
      if (!other) continue
      seen.add(lease.id)
      seen.add(other.id)
      const ordered = [lease, other].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
      pairs.push({
        first: { lease: ordered[0], job: jobById.value.get(ordered[0].jobId) ?? null },
        second: { lease: ordered[1], job: jobById.value.get(ordered[1].jobId) ?? null }
      })
    }
    return pairs
  })

  const pendingBackfillCount = computed(
    () => refs.backfill.value.filter((b) => b.state === '待合并').length
  )

  const stats = computed(() => {
    const unexecuted = jobs.value.filter((j) => j.state === '已派工' || j.state === '待确认').length
    return {
      jobs: jobs.value.length,
      dispatched: jobs.value.filter((j) => j.state === '已派工').length,
      rejected: jobs.value.filter((j) => j.state === '待派工').length,
      pending: jobs.value.filter((j) => j.state === '待确认').length,
      executed: jobs.value.filter((j) => j.state === '已执行').length,
      holding: unexecuted,
      liquidRows: liquids.value.length
    }
  })

  return {
    jobs,
    leases,
    liquids,
    jobById,
    tankLevels,
    timeline,
    timelineByDay,
    conflictPairs,
    pendingBackfillCount,
    stats
  }
}
