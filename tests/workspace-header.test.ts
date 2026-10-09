// @vitest-environment jsdom
import fs from 'node:fs'
import { compile, computed, defineComponent, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { NButton, NSpace } from 'naive-ui'
import { expect, it, vi } from 'vitest'
import type { ViewKey } from '../src/renderer/types'

// Render the actual shared header with real Naive UI components: shallow stubs
// cannot reproduce stale DOM left by dynamic slot children during navigation.
const source = fs.readFileSync('src/renderer/views/WorkspaceView.vue', 'utf8')
const header = source.match(/<header class="page-header">[\s\S]*?<\/header>/)?.[0]
if (!header) throw new Error('Workspace header template was not found')

it('keeps exactly the current view actions and their handlers across repeated navigation', async () => {
  const activeView = ref<ViewKey>('opportunities')
  const actions = {
    openAccounts: vi.fn(),
    openHistory: vi.fn(),
    newOpportunity: vi.fn(),
    openStatusEditor: vi.fn(),
    openIndustryEditor: vi.fn(),
    importResume: vi.fn(),
    openCompanyEditor: vi.fn(),
  }
  const expected: Record<ViewKey, { label: string; action: keyof typeof actions }[]> = {
    discovery: [
      { label: 'discovery.accounts', action: 'openAccounts' },
      { label: 'discovery.history', action: 'openHistory' },
    ],
    opportunities: [{ label: 'common.add', action: 'newOpportunity' }],
    statuses: [{ label: 'common.add', action: 'openStatusEditor' }],
    industries: [{ label: 'common.add', action: 'openIndustryEditor' }],
    resumes: [{ label: 'common.import', action: 'importResume' }],
    companies: [{ label: 'common.add', action: 'openCompanyEditor' }],
    calendar: [],
    agent: [],
    settings: [],
  }
  const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const wrapper = mount(
    defineComponent({
      components: { NButton, NSpace },
      setup: () => ({
        ...actions,
        activeView,
        pageTitle: computed(() => activeView.value),
        t: (key: string) => key,
        discoveryView: actions,
      }),
      render: compile(header),
    }),
  )
  try {
    const route: ViewKey[] = [
      'opportunities',
      'discovery',
      'resumes',
      'opportunities',
      'companies',
      'statuses',
      'industries',
      'discovery',
      'calendar',
      'agent',
      'settings',
      'resumes',
    ]
    for (const view of [...route, ...route, ...route]) {
      activeView.value = view
      await nextTick()
      expect(wrapper.get('h1').text()).toBe(view)
      const buttons = wrapper.findAll('button')
      expect(
        buttons.map((button) => button.text()),
        `Actions for ${view}`,
      ).toEqual(expected[view].map((item) => item.label))
      for (const [index, button] of buttons.entries()) {
        Object.values(actions).forEach((action) => action.mockClear())
        await button.trigger('click')
        for (const [name, action] of Object.entries(actions))
          expect(action).toHaveBeenCalledTimes(name === expected[view][index].action ? 1 : 0)
      }
    }
    expect(warnings.mock.calls.filter((call) => /Duplicate keys/.test(String(call[0])))).toEqual([])
  } finally {
    wrapper.unmount()
    warnings.mockRestore()
  }
})
