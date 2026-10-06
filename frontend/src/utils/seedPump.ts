/**
 * 泵机交接排班演示数据（v2 起幂等播种，仅在 pumpLedger 为空时执行）。
 * 占用账里同时放入液体流水、泵机租约与倒罐作业，并故意保留一条
 * 容量不足被拒的「待派工」与一条断网补录撞期的「待确认」，
 * 保证泵机交接页首次打开就能演示差量拒绝与并列确认。
 */
import type { PumpLedgerRow, PumpBackfillRow } from './db'
import { db, ROW_REVISION } from './db'
import type { PumpLedgerEntry, PumpBackfill } from '@/types/pump'

function revLedger(row: PumpLedgerEntry): PumpLedgerRow {
  return { ...(row as object), revision: ROW_REVISION, createdAt: 1727000000000, updatedAt: 1727000000000 } as PumpLedgerRow
}

function revBackfill(row: PumpBackfill): PumpBackfillRow {
  return { ...(row as object), revision: ROW_REVISION, createdAt: 1727000000000, updatedAt: 1727000000000 } as PumpBackfillRow
}

const PUMP_ID = 'pump-mobile-01'
const DEVICE_A = '平板A'
const DEVICE_B = '平板B'

/** 占用账：液体 / 租约 / 作业混排在同一张表 */
const LEDGER: PumpLedgerEntry[] = [
  /* ---------------------------- 液位初录流水 ---------------------------- */
  {
    kind: 'liquid',
    id: 'pl-001',
    at: '2024-09-20T08:00:00.000Z',
    tankId: 'tk-001',
    deltaL: 2600,
    reason: '液位初录',
    jobId: null,
    device: DEVICE_A,
    note: 'F-01 在罐液位'
  },
  {
    kind: 'liquid',
    id: 'pl-002',
    at: '2024-09-20T08:10:00.000Z',
    tankId: 'tk-002',
    deltaL: 2000,
    reason: '液位初录',
    jobId: null,
    device: DEVICE_A,
    note: 'F-02 在罐液位'
  },
  {
    kind: 'liquid',
    id: 'pl-003',
    at: '2024-09-20T08:20:00.000Z',
    tankId: 'tk-004',
    deltaL: 4200,
    reason: '液位初录',
    jobId: null,
    device: DEVICE_B,
    note: 'F-04 在罐液位（待清洗）'
  },

  /* ----------------------- JOB-001：已执行的倒罐 ----------------------- */
  {
    kind: 'job',
    id: 'pj-001',
    code: 'JOB-001',
    sourceTankId: 'tk-001',
    targetTankId: 'tk-003',
    volumeL: 1000,
    requireEmpty: false,
    requestedStartAt: '2024-09-25T09:00:00.000Z',
    durationMin: 50,
    state: '已执行',
    rejectReason: null,
    leaseId: 'pls-001',
    rerunOf: null,
    submittedAt: '2024-09-24T16:00:00.000Z',
    submitChannel: '在线',
    device: DEVICE_A,
    operator: '林沐'
  },
  {
    kind: 'lease',
    id: 'pls-001',
    pumpId: PUMP_ID,
    startAt: '2024-09-25T09:00:00.000Z',
    endAt: '2024-09-25T09:50:00.000Z',
    jobId: 'pj-001',
    state: '已释放',
    submittedAt: '2024-09-24T16:00:00.000Z',
    device: DEVICE_A,
    conflictsWith: null,
    note: '执行完成，租约释放'
  },
  {
    kind: 'liquid',
    id: 'pl-004',
    at: '2024-09-25T09:50:00.000Z',
    tankId: 'tk-001',
    deltaL: -1000,
    reason: '倒罐',
    jobId: 'pj-001',
    device: DEVICE_A,
    note: 'JOB-001 倒出至 F-03'
  },
  {
    kind: 'liquid',
    id: 'pl-005',
    at: '2024-09-25T09:50:00.000Z',
    tankId: 'tk-003',
    deltaL: 1000,
    reason: '倒罐',
    jobId: 'pj-001',
    device: DEVICE_A,
    note: 'JOB-001 自 F-01 接入'
  },

  /* ---------------------- JOB-002：已派工，持有效租约 ---------------------- */
  {
    kind: 'job',
    id: 'pj-002',
    code: 'JOB-002',
    sourceTankId: 'tk-002',
    targetTankId: 'tk-001',
    volumeL: 1200,
    requireEmpty: false,
    requestedStartAt: '2024-09-28T09:00:00.000Z',
    durationMin: 60,
    state: '已派工',
    rejectReason: null,
    leaseId: 'pls-002',
    rerunOf: null,
    submittedAt: '2024-09-26T10:12:00.000Z',
    submitChannel: '在线',
    device: DEVICE_A,
    operator: '周亦'
  },
  {
    kind: 'lease',
    id: 'pls-002',
    pumpId: PUMP_ID,
    startAt: '2024-09-28T09:00:00.000Z',
    endAt: '2024-09-28T10:00:00.000Z',
    jobId: 'pj-002',
    state: '有效',
    submittedAt: '2024-09-26T10:12:00.000Z',
    device: DEVICE_A,
    conflictsWith: null,
    note: '先提交，持有租约'
  },

  /* -------------- JOB-003：目标罐容量不足，拒绝派工并写明差量 -------------- */
  {
    kind: 'job',
    id: 'pj-003',
    code: 'JOB-003',
    sourceTankId: 'tk-001',
    targetTankId: 'tk-002',
    volumeL: 1600,
    requireEmpty: true,
    requestedStartAt: '2024-09-28T14:00:00.000Z',
    durationMin: 70,
    state: '待派工',
    rejectReason: '拒绝派工：目标罐 F-02 空余容量仅 250L，倒入 1600L 还差 1350L。',
    leaseId: null,
    rerunOf: null,
    submittedAt: '2024-09-26T10:40:00.000Z',
    submitChannel: '在线',
    device: DEVICE_B,
    operator: '陈岩'
  },

  /* -------- JOB-004：在线先提交，持 09-29 下午时段的有效租约 -------- */
  {
    kind: 'job',
    id: 'pj-004',
    code: 'JOB-004',
    sourceTankId: 'tk-002',
    targetTankId: 'tk-004',
    volumeL: 800,
    requireEmpty: false,
    requestedStartAt: '2024-09-29T14:00:00.000Z',
    durationMin: 60,
    state: '已派工',
    rejectReason: null,
    leaseId: 'pls-004',
    rerunOf: null,
    submittedAt: '2024-09-27T08:30:00.000Z',
    submitChannel: '在线',
    device: DEVICE_A,
    operator: '许澜'
  },
  {
    kind: 'lease',
    id: 'pls-004',
    pumpId: PUMP_ID,
    startAt: '2024-09-29T14:00:00.000Z',
    endAt: '2024-09-29T15:00:00.000Z',
    jobId: 'pj-004',
    state: '有效',
    submittedAt: '2024-09-27T08:30:00.000Z',
    device: DEVICE_A,
    conflictsWith: null,
    note: '班长先提交，占位在先'
  },

  /* ---- JOB-005：平板B 断网补录合并后撞 JOB-004 时段，并列待确认 ---- */
  {
    kind: 'job',
    id: 'pj-005',
    code: 'JOB-005',
    sourceTankId: 'tk-001',
    targetTankId: 'tk-003',
    volumeL: 400,
    requireEmpty: false,
    requestedStartAt: '2024-09-29T14:00:00.000Z',
    durationMin: 60,
    state: '待确认',
    rejectReason: '断网补录与 JOB-004 的泵机时段 14:00–15:00 重叠，并列待班长确认。',
    leaseId: 'pls-005',
    rerunOf: null,
    submittedAt: '2024-09-27T07:55:00.000Z',
    submitChannel: '断网补录',
    device: DEVICE_B,
    operator: '林沐'
  },
  {
    kind: 'lease',
    id: 'pls-005',
    pumpId: PUMP_ID,
    startAt: '2024-09-29T14:00:00.000Z',
    endAt: '2024-09-29T15:00:00.000Z',
    jobId: 'pj-005',
    state: '待确认',
    submittedAt: '2024-09-27T07:55:00.000Z',
    device: DEVICE_B,
    conflictsWith: 'pls-004',
    note: '平板B 断网补录，合并时撞期，并列待确认'
  }
]

/** 断网补录 outbox：一条液位补录、一条倒罐派工，等待恢复后合并 */
const BACKFILL: PumpBackfill[] = [
  {
    id: 'pbf-001',
    kind: '液位补录',
    device: DEVICE_B,
    occurredAt: '2024-09-27T22:10:00.000Z',
    submittedAt: '2024-09-27T22:10:00.000Z',
    state: '待合并',
    job: null,
    liquid: { tankId: 'tk-004', deltaL: -200, reason: '夜班补录', note: '夜班复测液位，修正 -200L' },
    mergedEntryIds: [],
    resultNote: null
  },
  {
    id: 'pbf-002',
    kind: '倒罐派工',
    device: DEVICE_B,
    occurredAt: '2024-09-27T20:30:00.000Z',
    submittedAt: '2024-09-27T20:30:00.000Z',
    state: '待合并',
    job: {
      sourceTankId: 'tk-003',
      targetTankId: 'tk-001',
      volumeL: 300,
      requireEmpty: false,
      requestedStartAt: '2024-09-30T10:00:00.000Z',
      durationMin: 45,
      operator: '陈岩'
    },
    liquid: null,
    mergedEntryIds: [],
    resultNote: null
  }
]

/** 灌入泵机占用账演示数据（幂等：由调用方判定表是否为空） */
export async function seedPumpLedger(): Promise<void> {
  await db.transaction('rw', [db.pumpLedger, db.pumpBackfill], async () => {
    await db.pumpLedger.bulkPut(LEDGER.map(revLedger))
    await db.pumpBackfill.bulkPut(BACKFILL.map(revBackfill))
  })
}
