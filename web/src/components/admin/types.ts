/** 管理面板的 tab 键与运维信号形状（壳与各 panel 共用） */
export type TabKey =
  | 'overview'
  | 'users'
  | 'ai'
  | 'quality'
  | 'automation'
  | 'triage'
  | 'samples'
  | 'logs'
  | 'rules'
  | 'release'

/** 「需要处理」信号：管理面板的价值是发现问题，不是看总数 */
export interface AdminOpsSignal {
  level: 'warn' | 'danger' | 'info'
  title: string
  detail: string
  tab: TabKey
}
