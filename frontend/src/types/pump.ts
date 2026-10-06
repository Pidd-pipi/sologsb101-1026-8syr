/**
 * 泵机交接排班：发酵罐液体、泵机时段、倒罐作业共用的「一张占用账」。
 * 每条 PumpLease 既是一次泵机时段租约，也是一次倒罐作业，同时驱动罐内液体账变化。
 */

/** 租约生命周期状态 */
export type PumpLeaseState =
  | '已派工'
  | '排队中' // 泵机时段撞车，先到的租约占用，后到的排队等待重排
  | '待重排' // 罐号改动 / 撤单 / 清洗未完成 / 补录读数后容量变化，作业失效等待重排
  | '待确认' // 两台平板断网补录合并后出现重叠时段，并列待人工确认
  | '已拒绝' // 目标罐容量不足或源罐未清空，写明差量
  | '已完成'
  | '已撤单'

/** 泵机作业类别 */
export type PumpJobType = '倒罐' | '淋皮回泵' | '清洗转料'

/** 清空模式：倒罐是否要求把源罐抽干 */
export type PumpDrainMode = '清空' | '部分'

/** 一张占用账：泵机时段 + 倒罐作业 + 罐内液体转移 */
export interface PumpLease {
  id: string
  /** 租约标题/备注，如「F-01 赤霞珠倒罐」 */
  title: string
  /** 作业类别 */
  jobType: PumpJobType
  /** 清空模式：清空要求源罐抽到剩 0L */
  drainMode: PumpDrainMode
  /** 源罐 id（抽出方） */
  sourceTankId: string
  /** 目标罐 id（受入方） */
  targetTankId: string
  /** 计划转移液量 L */
  volumeL: number
  /** 泵机时段开始 ISO（移动泵全局唯一资源，按时段判占） */
  startAt: string
  /** 泵机时段结束 ISO */
  endAt: string
  /** 提交时间戳：同一泵机时段收到两份提交时，只保留先提交的租约 */
  submittedAt: number
  /** 提交来源平板（断网补录合并时区分两台平板） */
  deviceId: string
  /** 关联作业 id（撤单/改罐号时联动失效，可空） */
  operationId: string | null
  /** 状态 */
  state: PumpLeaseState
  /** 派工校验失败或重排原因，含差量描述，如「目标罐还差 300L」 */
  rejectReason: string
  /** 排队重排时建议的下一可用时段开始 ISO */
  suggestedStartAt: string | null
  /** 待确认场景下与之重叠的对端租约 id */
  conflictsWith: string[]
  /** 重排次数：罐号改动/撤单后每轮重排累加 */
  rerunNo: number
}

/** 快照表：写入失败时可从当时快照恢复占用账 */
export interface PumpSnapshot {
  id: string
  /** 快照来源动作，如「派工提交 / 补录合并 / 罐号改动」 */
  reason: string
  /** 拍照时全部租约 */
  leases: PumpLease[]
  createdAt: number
}

/** 平板断网补录数据包（两台平板各自导出，恢复联网后导入合并） */
export interface PumpSyncPacket {
  /** 来源平板标识 */
  deviceId: string
  /** 导出时间 ISO */
  exportedAt: string
  leases: PumpLease[]
}

export const PUMP_LEASE_STATES: PumpLeaseState[] = [
  '已派工',
  '排队中',
  '待重排',
  '待确认',
  '已拒绝',
  '已完成',
  '已撤单'
]

/** 尚未执行、仍占着泵机/罐容量账的状态（重排判定只看这些） */
export const PUMP_OPEN_STATES: PumpLeaseState[] = ['已派工', '排队中', '待重排', '待确认']

export const PUMP_JOB_TYPES: PumpJobType[] = ['倒罐', '淋皮回泵', '清洗转料']
export const PUMP_DRAIN_MODES: PumpDrainMode[] = ['清空', '部分']

/** 本机平板标识（localStorage key） */
export const PUMP_DEVICE_KEY = 'gbwinetank-pump-device-id'

export interface PumpLeaseDraft {
  title: string
  jobType: PumpJobType
  drainMode: PumpDrainMode
  sourceTankId: string
  targetTankId: string
  volumeL: number
  range: [Date, Date] | null
  operationId: string | null
}

export function createEmptyPumpLease(): PumpLeaseDraft {
  const start = new Date()
  start.setMinutes(0, 0, 0)
  start.setHours(start.getHours() + 1)
  const end = new Date(start.getTime() + 60 * 60000)
  return {
    title: '',
    jobType: '倒罐',
    drainMode: '清空',
    sourceTankId: '',
    targetTankId: '',
    volumeL: 1000,
    range: [start, end],
    operationId: null
  }
}
