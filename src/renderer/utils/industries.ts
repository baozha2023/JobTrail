import type { CascaderOption } from 'naive-ui'
import type { Industry } from '../../shared/types'

export type IndustryTreeRow = Industry & { children?: IndustryTreeRow[] }

export function buildIndustryTree(industries: Industry[]): IndustryTreeRow[] {
  const roots = industries
    .filter((item) => item.parentId === null)
    .map((item) => ({ ...item, children: [] as IndustryTreeRow[] }))
  const byId = new Map(roots.map((item) => [item.id, item]))
  for (const item of industries) {
    if (item.parentId !== null) byId.get(item.parentId)!.children.push({ ...item })
  }
  return roots
}

export function industryPath(industry: Industry, industries: Industry[]): string {
  if (industry.parentId === null) return industry.name
  return `${industries.find((item) => item.id === industry.parentId)!.name} / ${industry.name}`
}

export function industryCascaderOptions(
  industries: Industry[],
  childrenOnly = false,
): CascaderOption[] {
  return buildIndustryTree(industries).map((root) => ({
    value: root.id,
    label: root.name,
    disabled: childrenOnly && root.children!.length === 0,
    children: root.children!.map((child) => ({
      value: child.id,
      label: child.name,
    })),
  }))
}
