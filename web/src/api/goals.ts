import api from './index'

export interface Goal {
  id: number
  name: string
  type: 'saving' | 'debt_payoff' | 'investment' | 'custom'
  target_amount: number
  current_amount: number
  deadline: string | null
  priority: number
  linked_account_id: number | null
  monthly_contribution: number
  status: 'active' | 'completed' | 'paused' | 'abandoned'
  icon: string
  note: string | null
  percent: number
  remaining: number
  estimated_completion: string | null
  created_at: string
  updated_at: string
}

export interface GoalProgress {
  amount: number
  snapshot_date: string
}

export function getGoals(status = 'active') {
  return api.get<{ code: number; data: { items: Goal[] } }>('/goals', { params: { status } })
}

export function createGoal(data: {
  name: string
  type: string
  target_amount: number
  current_amount?: number
  deadline?: string
  priority?: number
  linked_account_id?: number
  monthly_contribution?: number
  icon?: string
  note?: string
}) {
  return api.post<{ code: number; data: { id: number }; message: string }>('/goals', data)
}

export function updateGoal(id: number, data: Partial<Goal>) {
  return api.put(`/goals/${id}`, data)
}

export function deleteGoal(id: number) {
  return api.delete(`/goals/${id}`)
}

export function updateGoalProgress(id: number, amount: number) {
  return api.post(`/goals/${id}/progress`, { amount })
}

export function getGoalProgress(id: number) {
  return api.get<{ code: number; data: { history: GoalProgress[] } }>(`/goals/${id}/progress`)
}
