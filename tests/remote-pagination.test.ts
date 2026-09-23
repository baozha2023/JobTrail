// @vitest-environment jsdom

import { shallowMount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { i18n } from '../src/renderer/i18n'
import CompaniesView from '../src/renderer/views/CompaniesView.vue'
import OpportunitiesView from '../src/renderer/views/OpportunitiesView.vue'

const pagination = { page: 1, pageSize: 10, itemCount: 577 }
const global = {
  plugins: [i18n],
  stubs: { Card: { template: '<div><slot /></div>' } },
}

describe('remote table pagination', () => {
  it('keeps the opportunity pager driven by the database total', () => {
    const wrapper = shallowMount(OpportunitiesView, {
      props: {
        columns: [],
        data: [],
        loading: false,
        pagination,
        search: '',
        selectedStatusId: null,
        selectedCompanyId: null,
        statusOptions: [],
        companyOptions: [],
        filterCompanyOption: () => true,
      },
      global,
    })

    expect(wrapper.find('data-table-stub').attributes('remote')).toBe('true')
  })

  it('keeps the company pager driven by the database total', () => {
    const wrapper = shallowMount(CompaniesView, {
      props: {
        columns: [],
        data: [],
        loading: false,
        pagination,
        search: '',
        selectedIndustryId: null,
        industryOptions: [],
      },
      global,
    })

    expect(wrapper.find('data-table-stub').attributes('remote')).toBe('true')
  })
})
