/**
 * 判据报告里用的「常量表位置」标签（冲突消息要能定位到是哪张表）
 *
 * 单独成文件的原因：criterion-checks.ts（C1..C7）与 criterion-cross-table.ts（C8）
 * 都要用同一份标签。放任何一边都会形成 import 环（入口 criterion-consistency.ts
 * 已经 import criterion-checks.ts）。这里没有任何逻辑，只是常量。
 */
export const WHERE_SYNONYMS = 'ai/synonyms.SYNONYMS'
export const WHERE_QUICK = 'quick-parser.HIGH_CONFIDENCE_MAP'
export const WHERE_IMPORT = 'import-matcher.CATEGORY_RULES'
export const WHERE_NOISE = 'ai/noise-terms.NOISE_TERMS'
export const WHERE_PROMPT = 'prompts.PROMPT_NOISE_EXAMPLES'