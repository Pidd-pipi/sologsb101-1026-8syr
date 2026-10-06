import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'

// localStorage stub（pumpStore 不直接测，但模块图可能触碰）
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v)
})

import { db, ROW_REVISION } from '../src/utils/db'
import { seedPumpLedger } from '../src/utils/seedPump'
import {
  currentLevel,
  dispatchJob,
  cancelJob,
  executeJob,
  enqueueBackfill,
  mergeBackfill,
  renameTankCode,
  loadPumpBoard,
  conflictingLeases
} from '../src/utils/pumpSchedule'
import type { PumpJobForm } from '../src/types/pump'

function stamp<T extends object>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  const now = Date.now()
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now }
}

async function seedTanks(): Promise<void> {
  await db.tanks.bulkPut([
    stamp({ id: 'tk-001', code: 'F-01', material: '不锈钢', capacityL: 3000, tempControl: '夹套', state: '在用' }),
    stamp({ id: 'tk-002', code: 'F-02', material: '不锈钢', capacityL: 2000, tempControl: '无', state: '在用' }),
    stamp({ id: 'tk-003', code: 'F-03', material: '不锈钢', capacityL: 1500, tempControl: '盘管', state: '空闲' }),
    stamp({ id: 'tk-004', code: 'F-04', material: '混凝土', capacityL: 5000, tempControl: '夹套', state: '清洗中' })
  ])
  await db.pumpLedger.bulkPut([
    stamp({ kind: 'liquid', id: 'l1', at: '2024-09-20T08:00:00.000Z', tankId: 'tk-001', deltaL: 2600, reason: '液位初录', jobId: null, device: '平板A', note: '' }),
    stamp({ kind: 'liquid', id: 'l2', at: '2024-09-20T08:00:00.000Z', tankId: 'tk-002', deltaL: 2000, reason: '液位初录', jobId: null, device: '平板A', note: '' }),
    stamp({ kind: 'liquid', id: 'l3', at: '2024-09-20T08:00:00.000Z', tankId: 'tk-004', deltaL: 4200, reason: '液位初录', jobId: null, device: '平板A', note: '' })
  ])
}

function jobForm(over: Partial<PumpJobForm> = {}): PumpJobForm {
  return {
    sourceTankId: 'tk-001',
    targetTankId: 'tk-003',
    volumeL: 1000,
    requireEmpty: false,
    requestedStartAt: '2024-10-01T09:00:00.000Z',
    durationMin: 60,
    device: '平板A',
    operator: '甲',
    ...over
  }
}

async function jobs() {
  const rows = await db.pumpLedger.toArray()
  return rows.filter((r) => r.kind === 'job')
}
async function leases() {
  const rows = await db.pumpLedger.toArray()
  return rows.filter((r) => r.kind === 'lease')
}

describe('泵机交接排班', () => {
  beforeEach(async () => {
    store.clear()
    // 删库会让重开走「新建」而非 upgrade，v2 表结构由 Dexie 按最新声明直接建出
    await db.delete()
    await db.open()
    await db.pumpLedger.clear()
    await db.pumpBackfill.clear()
    await db.pumpSnapshots.clear()
    await seedTanks()
  })

  it('目标罐容量不足：拒绝派工并写明差量', async () => {
    // tk-003 容量 1500，倒入 1600，空 1500，差 100
    const res = await dispatchJob(jobForm({ targetTankId: 'tk-003', volumeL: 1600 }))
    expect(res.status).toBe('拒绝派工')
    expect(res.message).toContain('还差 100L')
    const j = (await jobs()).find((x) => x.id === res.jobId)!
    expect(j.state).toBe('待派工')
    expect(j.leaseId).toBeNull()
  })

  it('要求清空但源罐未清空：拒绝并写明剩余差量', async () => {
    // tk-001 有 2600，只倒 1000 但要求清空
    const res = await dispatchJob(jobForm({ volumeL: 1000, requireEmpty: true }))
    expect(res.status).toBe('拒绝派工')
    expect(res.message).toContain('仍剩 1600L')
  })

  it('目标罐清洗未完成：拒绝派工', async () => {
    const res = await dispatchJob(jobForm({ targetTankId: 'tk-004', volumeL: 100 }))
    expect(res.status).toBe('拒绝派工')
    expect(res.message).toContain('清洗')
  })

  it('同一时段两份在线提交：先提交持约，后到自动改期', async () => {
    const first = await dispatchJob(jobForm(), { submittedAt: '2024-09-28T08:00:00.000Z' })
    expect(first.status).toBe('派工成功')
    const second = await dispatchJob(jobForm({ volumeL: 500, operator: '乙' }), {
      submittedAt: '2024-09-28T09:00:00.000Z'
    })
    expect(second.status).toBe('自动改期')
    expect(second.startAt).not.toBe(first.startAt)
    const rows = await db.pumpLedger.toArray()
    expect(conflictingLeases(rows, first.startAt!, first.endAt!).length).toBe(1)
  })

  it('派工成功占约，执行后释放租约并写两条液位流水', async () => {
    const res = await dispatchJob(jobForm({ volumeL: 600 }))
    expect(res.status).toBe('派工成功')
    await executeJob(res.jobId)
    const board = await loadPumpBoard()
    const job = board.ledger.find((r) => r.kind === 'job' && r.id === res.jobId)!
    expect(job.kind === 'job' && job.state).toBe('已执行')
    expect(currentLevel(board.ledger, 'tk-001')).toBe(2000) // 2600-600
    expect(currentLevel(board.ledger, 'tk-003')).toBe(600)
    const lease = board.ledger.find((r) => r.kind === 'lease' && r.jobId === res.jobId)!
    expect(lease.kind === 'lease' && lease.state).toBe('已释放')
  })

  it('撤单：触发作业作废，其它未执行作业失效重排且时段被吃掉', async () => {
    const a = await dispatchJob(jobForm({ requestedStartAt: '2024-10-01T09:00:00.000Z' }))
    const b = await dispatchJob(
      jobForm({ volumeL: 500, operator: '乙', requestedStartAt: '2024-10-01T09:00:00.000Z' }),
      { submittedAt: '2024-09-29T08:00:00.000Z' }
    )
    expect(b.status).toBe('自动改期')
    await cancelJob(a.jobId)
    const all = await jobs()
    const canceled = all.find((j) => j.id === a.jobId)!
    expect(canceled.state).toBe('已撤单')
    // b 的后继作业应重排回 10:00（吃掉空出来的 09:00）
    const rerun = all.find((j) => j.kind === 'job' && j.rerunOf)
    expect(rerun).toBeTruthy()
    if (rerun && rerun.kind === 'job') {
      expect(rerun.leaseId).toBeTruthy()
      const lease = (await leases()).find((l) => l.id === rerun.leaseId)
      expect(lease!.startAt).toBe('2024-10-01T09:00:00.000Z')
    }
  })

  it('罐号改动：引用该罐的未执行作业失效重排，罐号落新值', async () => {
    const a = await dispatchJob(jobForm()) // tk-001 -> tk-003
    const { reruns } = await renameTankCode('tk-003', 'F-30')
    expect(reruns.length).toBe(1)
    const all = await jobs()
    expect(all.find((j) => j.id === a.jobId)!.state).toBe('已失效')
    const tank = await db.tanks.get('tk-003')
    expect(tank!.code).toBe('F-30')
  })

  it('平板断网补录液位：合并后追加流水', async () => {
    const id = await enqueueBackfill({
      kind: '液位补录',
      device: '平板B',
      occurredAt: '2024-09-27T22:00:00.000Z',
      job: null,
      liquid: { tankId: 'tk-001', deltaL: -100, reason: '夜班补录', note: '损耗' }
    })
    await mergeBackfill(id)
    const board = await loadPumpBoard()
    expect(currentLevel(board.ledger, 'tk-001')).toBe(2500)
    const bf = board.backfill.find((b) => b.id === id)!
    expect(bf.state).toBe('已合并')
  })

  it('断网补录倒罐撞期：双方并列待确认', async () => {
    // 在线先占
    const first = await dispatchJob(jobForm({ volumeL: 200 }), { submittedAt: '2024-09-29T08:00:00.000Z' })
    expect(first.status).toBe('派工成功')
    // 断网补录，提交时刻更早但合并更晚
    const id = await enqueueBackfill({
      kind: '倒罐派工',
      device: '平板B',
      occurredAt: '2024-10-01T09:00:00.000Z',
      job: {
        sourceTankId: 'tk-002',
        targetTankId: 'tk-003',
        volumeL: 300,
        requireEmpty: false,
        requestedStartAt: '2024-10-01T09:00:00.000Z',
        durationMin: 60,
        operator: '乙'
      },
      submittedAt: '2024-09-28T07:00:00.000Z'
    })
    const res = await mergeBackfill(id)
    expect(res.status).toBe('待确认')
    const board = await loadPumpBoard()
    const pendingJobs = board.ledger.filter((r) => r.kind === 'job' && r.state === '待确认')
    expect(pendingJobs.length).toBe(2)
  })

  it('写入失败可从快照恢复（撤单后恢复回原状态）', async () => {
    const a = await dispatchJob(jobForm())
    const before = await loadPumpBoard()
    const jobsBefore = before.ledger.filter((r) => r.kind === 'job').length
    await cancelJob(a.jobId)
    const snapshots = (await loadPumpBoard()).snapshots
    // 撤单动作开头拍的快照（label 以「撤单」开头），恢复它即回到撤单前
    const target = [...snapshots].reverse().find((s) => s.label.startsWith('撤单'))
    expect(target).toBeTruthy()
    const { restoreSnapshot } = await import('../src/utils/pumpSchedule')
    await restoreSnapshot(target!.id)
    const after = await loadPumpBoard()
    const jobsAfter = after.ledger.filter((r) => r.kind === 'job').length
    expect(jobsAfter).toBe(jobsBefore)
  })

  it('演示数据播种幂等且可读', async () => {
    await db.pumpLedger.clear()
    await db.pumpBackfill.clear()
    await seedPumpLedger()
    const board = await loadPumpBoard()
    expect(board.ledger.length).toBeGreaterThan(5)
    expect(board.backfill.length).toBe(2)
  })
})
