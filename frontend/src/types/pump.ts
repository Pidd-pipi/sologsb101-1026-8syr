/**
 * 泵机交接排班领域模型。
 *
 * 发酵车间只有一台移动泵，发酵罐液体、泵机时段、倒罐作业三类对象
 * 共用同一张「占用账」（pumpLedger），用 kind 区分条目类型：
 *  - liquid 发酵罐液体：只追加的流水（液位初录 / 倒罐 / 夜班补录 / 清洗排空）
 *  - lease  泵机时段：同一时段先提交者持有租约，后到者拒绝或待确认
 *  - job    倒罐作业：派工、撤单、失效重排、执行的状态机
 */
import type { TankMaterial, TankTempControl } from './tank'

/** 全车间唯一一台移动泵 id（占用账里所有 lease 都挂在它名下） */
export const PUMP_ID = 'pump-mobile-01'
export const PUMP_NAME = '移动泵 P-01（全车间唯一）'

/** 占用账条目类型：罐液体流水 / 泵机时段租约 / 倒罐作业 */
export type PumpLedgerKind = 'liquid' | 'lease' | 'job'

/** 液体变动原因 */
export type LiquidReason = '液位初录' | '倒罐' | '夜班补录' | '清洗排空'

/** 泵机租约状态：有效 / 已释放 / 待确认（断网合并冲突） / 已拒绝 */
export type LeaseState = '有效' | '已释放' | '待确认' | '已拒绝'

/** 倒罐作业派工状态 */
export type JobState =
  | '已派工' // 已拿到泵机租约，等待执行
  | '待派工' // 校验未过（容量不足 / 源罐未清空 / 时段冲突），带拒绝原因
  | '待确认' // 断网补录后与既有租约时段重叠，并列等待班长确认
  | '已执行'
  | '已撤单'
  | '已失效' // 罐号改动 / 撤单触发，未执行作业立即作废，等待重排

/** 提交渠道：在线提交 / 平板断网补录 */
export type SubmitChannel = '在线' | '断网补录'

/** 发酵罐液体流水（只追加） */
export interface PumpLiquidEntry {
  kind: 'liquid'
  id: string
  /** 发生时间 ISO，用作记账时刻 */
  at: string
  /** 罐 id */
  tankId: string
  /** 变化量 L：进罐为正（初录 / 倒入），出罐为负（倒出 / 排空） */
  deltaL: number
  reason: LiquidReason
  /** 关联倒罐作业（初录 / 补录可空） */
  jobId: string | null
  /** 数据来源设备（两台平板各自署名） */
  device: string
  note: string
}

/** 泵机时段租约 */
export interface PumpLeaseEntry {
  kind: 'lease'
  id: string
  pumpId: string
  /** 时段起止 ISO（半开区间 [start,end)） */
  startAt: string
  endAt: string
  /** 占用此时段的倒罐作业 id */
  jobId: string
  state: LeaseState
  /** 提交时刻（先提交者持约的判定依据） */
  submittedAt: string
  device: string
  /** 冲突对象：与哪条既存租约重叠（待确认 / 已拒绝时回填） */
  conflictsWith: string | null
  note: string
}

/** 倒罐作业 */
export interface PumpJobEntry {
  kind: 'job'
  id: string
  /** 作业编号，人工可读 */
  code: string
  sourceTankId: string
  targetTankId: string
  /** 计划倒出量 L（校验源罐是否够、是否清空） */
  volumeL: number
  /** 是否要求源罐清空（清空作业） */
  requireEmpty: boolean
  /** 期望开始时间 ISO；自动派工时从此刻向后找空时段 */
  requestedStartAt: string
  /** 时长（分钟） */
  durationMin: number
  state: JobState
  /** 拒绝派工 / 待确认原因（写明差量） */
  rejectReason: string | null
  /** 当前持有的泵机租约 id */
  leaseId: string | null
  /** 由哪条失效作业重排而来（重排链） */
  rerunOf: string | null
  submittedAt: string
  submitChannel: SubmitChannel
  device: string
  operator: string
}

/** 共用一张占用账：三类条目的判别联合 */
export type PumpLedgerEntry = PumpLiquidEntry | PumpLeaseEntry | PumpJobEntry

/* ------------------------------ 断网补录 ------------------------------ */

/** 补录条目类型 */
export type BackfillKind = '倒罐派工' | '液位补录'

/** 补录处理状态 */
export type BackfillState = '待合并' | '已合并' | '冲突待确认'

/**
 * 平板断网时先暂存的提交（outbox），恢复网络后再合并进占用账。
 * 液位补录合并时直接追加流水；倒罐派工合并时走派工校验，
 * 若泵机时段与既有租约重叠，则作业与租约并列「待确认」。
 */
export interface PumpBackfill {
  id: string
  kind: BackfillKind
  device: string
  /** 断网时记录的发生时刻 ISO */
  occurredAt: string
  /** 实际提交（暂存）时刻 ISO */
  submittedAt: string
  state: BackfillState
  /** 倒罐派工载荷（kind=倒罐派工） */
  job: {
    sourceTankId: string
    targetTankId: string
    volumeL: number
    requireEmpty: boolean
    requestedStartAt: string
    durationMin: number
    operator: string
  } | null
  /** 液位补录载荷（kind=液位补录） */
  liquid: { tankId: string; deltaL: number; reason: LiquidReason; note: string } | null
  /** 合并后生成的占用账条目 id */
  mergedEntryIds: string[]
  /** 合并 / 冲突说明（写明重叠时段或差量） */
  resultNote: string | null
}

/* ------------------------------ 写入快照 ------------------------------ */

/** 罐在快照时的最小字段（改罐号恢复用） */
export interface SnapshotTank {
  id: string
  code: string
  capacityL: number
  material: TankMaterial
  tempControl: TankTempControl
  state: string
}

/**
 * 写入前快照：罐号改动、撤单、失效重排、补录合并等动作落库前
 * 先存当时占用账全量；写入失败或需要撤销时可从该快照恢复。
 */
export interface PumpSnapshot {
  id: string
  label: string
  createdAt: string
  /** 占用账全量（liquid/lease/job） */
  ledger: PumpLedgerEntry[]
  /** 待合并 outbox */
  outbox: PumpBackfill[]
  /** 当时罐表（恢复改罐号前的罐号） */
  tanks: SnapshotTank[]
}

/* ------------------------------ 派工结果 ------------------------------ */

export type DispatchStatus = '派工成功' | '自动改期' | '拒绝派工' | '待确认'

/** 派工 / 合并的结构化结果，UI 据此提示差量与时段 */
export interface DispatchResult {
  status: DispatchStatus
  jobId: string
  leaseId: string | null
  /** 人类可读说明（拒绝时写明差量） */
  message: string
  /** 最终排到的时段（成功 / 自动改期 / 待确认时返回） */
  startAt: string | null
  endAt: string | null
}

export const LIQUID_REASONS: LiquidReason[] = ['液位初录', '倒罐', '夜班补录', '清洗排空']
export const LEASE_STATES: LeaseState[] = ['有效', '已释放', '待确认', '已拒绝']
export const JOB_STATES: JobState[] = ['已派工', '待派工', '待确认', '已执行', '已撤单', '已失效']
export const BACKFILL_KINDS: BackfillKind[] = ['倒罐派工', '液位补录']

/** 未执行（仍会被罐号改动 / 撤单波及）的作业状态 */
export function isUnexecuted(state: JobState): boolean {
  return state === '已派工' || state === '待派工' || state === '待确认'
}

/** 该作业是否实际占着泵机（持有有效租约） */
export function isLeaseActive(state: LeaseState): boolean {
  return state === '有效' || state === '待确认'
}

/** 新建倒罐派工表单字段（不含判别字段 kind 与系统字段） */
export type PumpJobForm = Omit<
  PumpJobEntry,
  'kind' | 'id' | 'code' | 'state' | 'rejectReason' | 'leaseId' | 'rerunOf' | 'submittedAt' | 'submitChannel'
>

/** 新建倒罐派工表单的默认值 */
export function createEmptyJobForm(): PumpJobForm {
  return {
    sourceTankId: '',
    targetTankId: '',
    volumeL: 1000,
    requireEmpty: true,
    requestedStartAt: '',
    durationMin: 60,
    device: '平板A',
    operator: ''
  }
}
