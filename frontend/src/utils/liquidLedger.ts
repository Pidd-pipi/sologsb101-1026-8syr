/**
 * 发酵罐液体账：泵机交接排班的派工前置校验。
 * 所有倒罐租约按计划顺序对罐内液量做投影，得到「派工时刻」每罐的预计液位，
 * 从而判定：目标罐容量是否够、清空模式下源罐是否能抽干。夜班补录读数会改变当前液位，
 * 调用方重新投影即可让受影响的未执行作业失效重排。
 */
import type { BatchRow, TankRow } from './db'
import { PUMP_OPEN_STATES, type PumpLease } from '../types/pump'

/** 每个罐当前（或投影后）的液位账 */
export interface TankLiquid {
  tankId: string
  /** 当前/计划完成后的罐内液量 L */
  levelL: number
  /** 罐容量 L */
  capacityL: number
  /** 剩余可受入空间 L */
  freeL: number
}

export interface LiquidLedger {
  /** 按罐 id 索引的液位 */
  byTank: Map<string, TankLiquid>
}

/**
 * 建立液体账：以当前在罐批次的入罐量（最新读数不改液量，故以 volumeL 为准）为期初液位。
 * 已出罐批次不占液位；空罐液位为 0。
 */
export function buildLiquidLedger(tanks: TankRow[], batches: BatchRow[]): LiquidLedger {
  const byTank = new Map<string, TankLiquid>()
  for (const tank of tanks) {
    const level = batches
      .filter((batch) => batch.tankId === tank.id && batch.state !== '已出罐')
      .reduce((sum, batch) => sum + batch.volumeL, 0)
    byTank.set(tank.id, {
      tankId: tank.id,
      levelL: level,
      capacityL: tank.capacityL,
      freeL: Math.max(0, tank.capacityL - level)
    })
  }
  return { byTank }
}

/** 排序开放租约：先按开始时间，同刻按提交时间（先提交先占用） */
export function orderOpenLeases(leases: PumpLease[]): PumpLease[] {
  return leases
    .filter((lease) => PUMP_OPEN_STATES.includes(lease.state))
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.submittedAt - b.submittedAt)
}

/**
 * 把租约按时间顺序投影到液体账上，返回每个租约执行前一刻的液位快照。
 * 投影只信任「已派工」且不拒绝的租约；排队/待重排/待确认的暂不改变液位，
 * 避免悬而未决的作业把账占死。
 */
export function projectLedger(
  ledger: LiquidLedger,
  leases: PumpLease[]
): { before: Map<string, TankLiquid>; after: LiquidLedger } {
  const work = new Map<string, TankLiquid>()
  for (const [id, liquid] of ledger.byTank) work.set(id, { ...liquid })
  const before = new Map<string, TankLiquid>()

  const committed = leases
    .filter((lease) => lease.state === '已派工')
    .sort((a, b) => a.startAt.localeCompare(b.startAt))

  for (const lease of committed) {
    const source = work.get(lease.sourceTankId)
    const target = work.get(lease.targetTankId)
    if (source) before.set(lease.id, { ...source })
    if (source && target) {
      const moved = Math.min(lease.volumeL, source.levelL)
      const nextSource = source.levelL - moved
      const nextTarget = target.levelL + moved
      work.set(lease.sourceTankId, { ...source, levelL: nextSource, freeL: source.capacityL - nextSource })
      work.set(lease.targetTankId, {
        ...target,
        levelL: nextTarget,
        freeL: target.capacityL - nextTarget
      })
    }
  }
  return { before, after: { byTank: work } }
}

export interface DispatchCheck {
  ok: boolean
  /** 失败原因（含差量），ok 时为空串 */
  reason: string
  /** 目标罐缺口 L（容量不足时为正） */
  targetShortL: number
  /** 源罐差额 L：清空模式下应抽干但液量与计划量不符时，给出差值 */
  sourceGapL: number
}

/**
 * 派工前置校验（在「此前已派工租约」投影后的账上判定）：
 * 1. 目标罐容量不足 → 拒绝并写明还差多少 L；
 * 2. 源罐未清空（清空模式）→ 拒绝并写明源罐剩余/缺口差量。
 */
export function checkDispatch(
  lease: Pick<PumpLease, 'sourceTankId' | 'targetTankId' | 'volumeL' | 'drainMode'>,
  projected: LiquidLedger
): DispatchCheck {
  const source = projected.byTank.get(lease.sourceTankId)
  const target = projected.byTank.get(lease.targetTankId)
  if (!source) return { ok: false, reason: '源罐不存在或已删除，请重排罐号', targetShortL: 0, sourceGapL: 0 }
  if (!target) return { ok: false, reason: '目标罐不存在或已删除，请重排罐号', targetShortL: 0, sourceGapL: 0 }
  if (lease.sourceTankId === lease.targetTankId) {
    return { ok: false, reason: '源罐与目标罐不能相同', targetShortL: 0, sourceGapL: 0 }
  }

  // 目标罐受入后液位不得超容量
  const incoming = Math.min(lease.volumeL, source.levelL)
  const nextTargetLevel = target.levelL + incoming
  if (nextTargetLevel > target.capacityL) {
    const shortL = nextTargetLevel - target.capacityL
    return {
      ok: false,
      reason: `目标罐容量不足：受入后液位 ${nextTargetLevel}L / 容量 ${target.capacityL}L，还差 ${shortL}L`,
      targetShortL: shortL,
      sourceGapL: 0
    }
  }

  // 清空模式：计划抽量必须等于源罐当前液位，抽完应为 0；否则源罐「未清空」
  if (lease.drainMode === '清空') {
    if (lease.volumeL < source.levelL) {
      const remainL = source.levelL - lease.volumeL
      return {
        ok: false,
        reason: `源罐未清空：当前 ${source.levelL}L，计划仅抽 ${lease.volumeL}L，罐内仍剩 ${remainL}L，请增大抽量或改部分转料`,
        targetShortL: 0,
        sourceGapL: remainL
      }
    }
    if (lease.volumeL > source.levelL) {
      const overL = lease.volumeL - source.levelL
      return {
        ok: false,
        reason: `源罐液量不足：当前仅 ${source.levelL}L，计划抽 ${lease.volumeL}L，差 ${overL}L（清空抽量应等于源罐液位）`,
        targetShortL: 0,
        sourceGapL: overL
      }
    }
  } else if (lease.volumeL > source.levelL) {
    const overL = lease.volumeL - source.levelL
    return {
      ok: false,
      reason: `源罐液量不足：当前仅 ${source.levelL}L，计划抽 ${lease.volumeL}L，差 ${overL}L`,
      targetShortL: 0,
      sourceGapL: overL
    }
  }

  return { ok: true, reason: '', targetShortL: 0, sourceGapL: 0 }
}

/** 给排队租约推算下一可用泵机时段（整点步进，避开全部已派工时段） */
export function nextFreeSlot(
  from: Date,
  durationMin: number,
  busy: Array<{ startAt: string; endAt: string }>
): Date {
  const cursor = new Date(from)
  cursor.setMinutes(0, 0, 0)
  const sorted = [...busy].sort((a, b) => a.startAt.localeCompare(b.startAt))
  for (let guard = 0; guard < 24 * 14; guard += 1) {
    const slotStart = cursor.getTime()
    const slotEnd = slotStart + durationMin * 60000
    const hit = sorted.some((item) => {
      const s = new Date(item.startAt).getTime()
      const e = new Date(item.endAt).getTime()
      return slotStart < e && s < slotEnd
    })
    if (!hit) return new Date(slotStart)
    cursor.setTime(cursor.getTime() + 60 * 60000)
  }
  return cursor
}
