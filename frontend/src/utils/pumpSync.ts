/**
 * 两台平板断网补录后的占用账合并。
 * - 同 id 租约：按 updatedAt/submittedAt 取较新（断网期间各自编辑过的同一条）；
 * - 同时段重叠（半开区间相交）：在线同一时刻两份提交按「先提交先得」，
 *   但断网补录无法还原全局先后，因此重叠双方都置「待确认」并列，交人工裁决；
 * - 无冲突的补录租约直接并入。
 */
import type { PumpLease } from '../types/pump'

export interface MergeReport {
  merged: PumpLease[]
  /** 新增（对端有、本机没有）的租约 id */
  addedIds: string[]
  /** 同 id 被较新版本覆盖的租约 id */
  updatedIds: string[]
  /** 合并后进入「待确认」的租约 id（成对重叠） */
  conflictIds: string[]
  /** 合并时发现的重复提交对（同 id 不算，这里列时段相交对） */
  overlapPairs: Array<[string, string]>
}

/** 时间区间是否相交（端点相接不算占用同一台泵） */
export function isOverlap(a: PumpLease, b: PumpLease): boolean {
  if (a.id === b.id) return false
  const as = new Date(a.startAt).getTime()
  const ae = new Date(a.endAt).getTime()
  const bs = new Date(b.startAt).getTime()
  const be = new Date(b.endAt).getTime()
  return as < be && bs < ae
}

/** 终态租约不再参与补录冲突（已完成/已撤单/已拒绝） */
function isTerminal(lease: PumpLease): boolean {
  return lease.state === '已完成' || lease.state === '已撤单' || lease.state === '已拒绝'
}

/**
 * 合并本机账与对端平板补录包。
 * @param local 本机当前全部租约
 * @param incoming 对端平板导出的租约
 */
export function mergePumpSync(local: PumpLease[], incoming: PumpLease[]): MergeReport {
  const byId = new Map<string, PumpLease>()
  const addedIds: string[] = []
  const updatedIds: string[] = []

  for (const lease of local) byId.set(lease.id, lease)

  for (const remote of incoming) {
    const mine = byId.get(remote.id)
    if (!mine) {
      byId.set(remote.id, remote)
      addedIds.push(remote.id)
      continue
    }
    // 同一条记录：任一时间戳较新者胜出
    const remoteUpdated = versionOf(remote)
    const mineUpdated = versionOf(mine)
    if (remote.submittedAt > mine.submittedAt || remoteUpdated > mineUpdated) {
      byId.set(remote.id, remote)
      updatedIds.push(remote.id)
    }
  }

  const merged = [...byId.values()]

  // 时段重叠检测：只看仍开放（未执行）且非排队的租约；
  // 在线排队是先到先得的确定结果，补录合并才升级成「待确认」。
  const overlapPairs: Array<[string, string]> = []
  const conflictIds = new Set<string>()
  const open = merged.filter(
    (lease) => !isTerminal(lease) && lease.state !== '排队中'
  )
  for (let i = 0; i < open.length; i += 1) {
    for (let j = i + 1; j < open.length; j += 1) {
      const a = open[i]
      const b = open[j]
      if (isOverlap(a, b)) {
        overlapPairs.push([a.id, b.id])
        conflictIds.add(a.id)
        conflictIds.add(b.id)
      }
    }
  }

  for (const id of conflictIds) {
    const lease = byId.get(id)
    if (!lease) continue
    if (lease.state !== '待确认') {
      lease.state = '待确认'
      lease.rejectReason = '两台平板断网补录后时段重叠，并列待确认'
    }
    lease.conflictsWith = [...new Set([...lease.conflictsWith, ...overlapPairsFor(id, overlapPairs)])]
  }

  return {
    merged,
    addedIds,
    updatedIds,
    conflictIds: [...conflictIds],
    overlapPairs
  }
}

function overlapPairsFor(id: string, pairs: Array<[string, string]>): string[] {
  const peers: string[] = []
  for (const [a, b] of pairs) {
    if (a === id) peers.push(b)
    else if (b === id) peers.push(a)
  }
  return peers
}

/** 取行上的更新时间（补录行不带 Revisioned 时回退 submittedAt） */
function versionOf(lease: PumpLease & { updatedAt?: number }): number {
  return lease.updatedAt ?? lease.submittedAt
}

/** 解析对端平板导出的补录 JSON 文本 */
export function parsePumpPacket(text: string): { deviceId: string; leases: PumpLease[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON 文本')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('补录包根节点必须是对象')
  const packet = parsed as { deviceId?: unknown; leases?: unknown }
  if (typeof packet.deviceId !== 'string' || packet.deviceId.length === 0) {
    throw new Error('补录包缺少 deviceId')
  }
  if (!Array.isArray(packet.leases)) throw new Error('补录包缺少 leases 数组')
  for (const [index, item] of packet.leases.entries()) {
    if (typeof item !== 'object' || item === null) throw new Error(`第 ${index + 1} 条租约格式有误`)
    const lease = item as Record<string, unknown>
    if (typeof lease.id !== 'string') throw new Error(`第 ${index + 1} 条租约缺少 id`)
    if (typeof lease.startAt !== 'string' || typeof lease.endAt !== 'string') {
      throw new Error(`第 ${index + 1} 条租约缺少泵机时段`)
    }
  }
  return { deviceId: packet.deviceId, leases: packet.leases as PumpLease[] }
}
