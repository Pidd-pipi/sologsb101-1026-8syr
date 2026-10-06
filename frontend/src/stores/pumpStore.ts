/**
 * 泵机交接排班 store：设备身份、占用账 / 补录 / 快照的动作封装。
 * 页面只调用这里的 actions，核心规则全部落在 utils/pumpSchedule。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { DispatchResult, LiquidReason, PumpBackfill, PumpJobForm } from '@/types/pump'
import {
  cancelJob,
  deleteSnapshot,
  dispatchJob,
  enqueueBackfill,
  executeJob,
  mergeAllBackfill,
  mergeBackfill,
  renameTankCode,
  resolveConflict,
  restoreSnapshot
} from '@/utils/pumpSchedule'

const DEVICE_KEY = 'gbwinetank-pump-device'

export const usePumpStore = defineStore('pump', () => {
  /** 当前平板署名（A / B），断网补录时带到每条提交上 */
  const device = ref<string>(localStorage.getItem(DEVICE_KEY) ?? '平板A')

  function setDevice(next: string): void {
    device.value = next
    localStorage.setItem(DEVICE_KEY, next)
  }

  /** 在线派工（撞期自动改期） */
  async function dispatch(form: PumpJobForm): Promise<DispatchResult> {
    return dispatchJob({ ...form, device: device.value }, { device: device.value })
  }

  /** 撤单：释放租约，未执行作业立即失效重排 */
  async function cancel(jobId: string): Promise<string[]> {
    return cancelJob(jobId)
  }

  async function execute(jobId: string): Promise<void> {
    await executeJob(jobId)
  }

  /** 冲突裁决：保留 keep，落败的 drop 立即重排 */
  async function resolve(keepJobId: string, dropJobId: string): Promise<string | null> {
    return resolveConflict(keepJobId, dropJobId)
  }

  /** 改罐号：引用该罐的未执行作业失效重排，再落新罐号 */
  async function renameTank(tankId: string, code: string): Promise<{ changed: boolean; reruns: string[] }> {
    return renameTankCode(tankId, code)
  }

  /** 断网暂存液位补录 */
  async function enqueueLiquid(payload: {
    occurredAt: string
    tankId: string
    deltaL: number
    reason: LiquidReason
    note: string
  }): Promise<string> {
    return enqueueBackfill({
      kind: '液位补录',
      device: device.value,
      occurredAt: payload.occurredAt,
      job: null,
      liquid: { tankId: payload.tankId, deltaL: payload.deltaL, reason: payload.reason, note: payload.note }
    })
  }

  /** 断网暂存倒罐派工 */
  async function enqueueJob(payload: { occurredAt: string; job: NonNullable<PumpBackfill['job']> }): Promise<string> {
    return enqueueBackfill({
      kind: '倒罐派工',
      device: device.value,
      occurredAt: payload.occurredAt,
      job: payload.job,
      liquid: null
    })
  }

  async function mergeOne(backfillId: string): Promise<DispatchResult | { status: '液位入账'; message: string }> {
    return mergeBackfill(backfillId)
  }

  async function mergeAll(): Promise<void> {
    await mergeAllBackfill()
  }

  async function restore(snapshotId: string): Promise<void> {
    await restoreSnapshot(snapshotId)
  }

  async function removeSnapshot(snapshotId: string): Promise<void> {
    await deleteSnapshot(snapshotId)
  }

  return {
    device,
    setDevice,
    dispatch,
    cancel,
    execute,
    resolve,
    renameTank,
    enqueueLiquid,
    enqueueJob,
    mergeOne,
    mergeAll,
    restore,
    removeSnapshot
  }
})
