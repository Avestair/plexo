import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IpcChannels } from '../../shared/ipc-channels'
import { matchCategoryRule } from '../../shared/categoryRules'
import type { CategoryRule } from '../../shared/types'
import {
  flushCategoryRules,
  loadCategoryRules,
  saveCategoryRules
} from '../storage/categoryRuleStorage'

export type CategoryRuleInput = Omit<CategoryRule, 'id' | 'order'>
export type CategoryRulePatch = Partial<Omit<CategoryRule, 'id'>>

/**
 * CRUD for the rules that auto-route a pasted/added URL to a queue (see shared/categoryRules.ts
 * for the actual matching logic, which this only wraps with the persisted list). An ordered
 * list, not keyed by queueId the way QueueSchedule/QueueAction are — any number of rules can
 * target the same queue, or none at all — so CRUD here looks like QueueManager's item list
 * (create/update/remove/reorder) rather than ScheduleManager's per-queue `set`.
 */
export class CategoryRuleManager {
  private rules: CategoryRule[] = []
  private readonly initialization: Promise<void>

  constructor(private getWindow: () => BrowserWindow | null) {
    this.initialization = this.restore()
  }

  private async restore(): Promise<void> {
    this.rules = await loadCategoryRules()
  }

  async getRules(): Promise<CategoryRule[]> {
    await this.initialization
    return structuredClone(this.rules)
  }

  async getRule(id: string): Promise<CategoryRule | null> {
    await this.initialization
    const rule = this.find(id)
    return rule ? structuredClone(rule) : null
  }

  async createRule(input: CategoryRuleInput): Promise<CategoryRule> {
    await this.initialization
    const rule: CategoryRule = {
      id: randomUUID(),
      name: input.name.trim() || 'Untitled rule',
      matchType: input.matchType,
      pattern: input.pattern.trim(),
      targetQueueId: input.targetQueueId,
      enabled: input.enabled,
      order: this.rules.length
    }
    this.rules.push(rule)
    this.persist()
    return structuredClone(rule)
  }

  async updateRule(id: string, patch: CategoryRulePatch): Promise<CategoryRule | null> {
    await this.initialization
    const rule = this.find(id)
    if (!rule) return null
    if (patch.name !== undefined) rule.name = patch.name.trim() || rule.name
    if (patch.matchType !== undefined) rule.matchType = patch.matchType
    if (patch.pattern !== undefined) rule.pattern = patch.pattern.trim()
    if (patch.targetQueueId !== undefined) rule.targetQueueId = patch.targetQueueId
    if (patch.enabled !== undefined) rule.enabled = patch.enabled
    if (patch.order !== undefined) rule.order = patch.order
    this.persist()
    return structuredClone(rule)
  }

  async removeRule(id: string): Promise<void> {
    await this.initialization
    this.rules = this.rules.filter((rule) => rule.id !== id)
    this.renumber()
    this.persist()
  }

  /** Reorders by a full list of ids, same convention as QueueManager.reorderItems — an id the
   * caller left out keeps its relative place rather than vanishing. */
  async reorderRules(ids: string[]): Promise<void> {
    await this.initialization
    const byId = new Map(this.rules.map((rule) => [rule.id, rule]))
    const reordered: CategoryRule[] = []
    for (const id of ids) {
      const rule = byId.get(id)
      if (rule) reordered.push(rule)
    }
    for (const rule of this.rules) {
      if (!ids.includes(rule.id)) reordered.push(rule)
    }
    this.rules = reordered
    this.renumber()
    this.persist()
  }

  /** The target queue id for `url`, or null if nothing matches — see
   * shared/categoryRules.ts's matchCategoryRule, the single implementation of the matching
   * rules shared with the renderer. */
  matchRule(url: string): string | null {
    return matchCategoryRule(url, this.rules)
  }

  /** Flushes any pending debounced save immediately — for app shutdown. */
  async flush(): Promise<void> {
    await this.initialization
    await flushCategoryRules(structuredClone(this.rules))
  }

  private renumber(): void {
    this.rules.forEach((rule, index) => {
      rule.order = index
    })
  }

  private find(id: string): CategoryRule | undefined {
    return this.rules.find((rule) => rule.id === id)
  }

  private persist(): void {
    saveCategoryRules(structuredClone(this.rules))
    this.emit()
  }

  private emit(): void {
    const window = this.getWindow()
    if (!window || window.isDestroyed()) return
    window.webContents.send(IpcChannels.categoryRulesUpdated, structuredClone(this.rules))
  }
}
