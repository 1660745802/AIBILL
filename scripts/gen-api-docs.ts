/**
 * API 文档自动生成脚本
 *
 * 从 server/src/routes/*.ts 解析 app.get/post/put/delete 调用，
 * 生成 docs/API.md 的端点表格草稿。
 *
 * 使用：
 *   cd server && npx tsx ../scripts/gen-api-docs.ts
 *
 * 输出：stdout 打印 Markdown 表格，可粘贴到 docs/API.md。
 * 复杂响应示例仍需手动维护。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTES_DIR = join(process.cwd(), 'server/src/routes')

interface Route {
  method: string
  path: string
  file: string
  line: number
}

function parseRoutesFromFile(filePath: string): Route[] {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const routes: Route[] = []
  const file = filePath.split('/').pop()!.replace('.ts', '')

  // 匹配 app.method('path', ...) 或 app.method('path', ..., ...)
  // 允许跨行（path 在多行）
  const regex = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g
  const lineRegex = /app\.(get|post|put|delete|patch)\(/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!lineRegex.test(line)) continue
    lineRegex.lastIndex = 0

    // 尝试匹配本行 path，若失败则合并下一行（最多往后看 3 行）
    let combined = line
    for (let j = 1; j <= 3 && !combined.includes("'", 100); j++) {
      combined += '\n' + (lines[i + j] || '')
    }

    regex.lastIndex = 0
    let match
    while ((match = regex.exec(combined)) !== null) {
      routes.push({
        method: match[1].toUpperCase(),
        path: match[2],
        file,
        line: i + 1,
      })
    }
  }

  return routes
}

function main() {
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')

  const allRoutes: Route[] = []
  for (const file of files) {
    const routes = parseRoutesFromFile(join(ROUTES_DIR, file))
    allRoutes.push(...routes)
  }

  // 按路径前缀分组
  const grouped = new Map<string, Route[]>()
  for (const route of allRoutes) {
    // /api/auth/register → auth
    const prefix = route.path.replace(/^\/+/, '').split('/')[1] || route.path
    const key = prefix === 'health' ? 'health' : prefix
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(route)
  }

  // 输出 Markdown 表格
  console.log('# 自动生成的 API 端点表\n')
  console.log(`> 共 ${allRoutes.length} 个端点\n`)
  console.log('| Method | Path | File | Line |')
  console.log('|--------|------|------|------|')

  const sortedGroups = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [group, routes] of sortedGroups) {
    console.log(`\n## ${group}\n`)
    for (const r of routes.sort((a, b) => a.path.localeCompare(b.path))) {
      console.log(`| ${r.method} | \`${r.path}\` | ${r.file}.ts | ${r.line} |`)
    }
  }
}

main()