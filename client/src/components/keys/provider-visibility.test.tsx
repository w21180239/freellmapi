// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { AddKeyForm } from './add-key-form'
import { AddModelDialog } from './add-model-dialog'
import { LISTED_PLATFORMS, PLATFORMS } from './shared'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(async () => []) }))
vi.mock('@/components/model-combobox', () => ({
  ModelCombobox: ({ options, ariaLabel }: { options: { value: string; label: string }[]; ariaLabel: string }) => (
    <select aria-label={ariaLabel}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
  ),
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

let root: Root, container: HTMLDivElement, client: QueryClient
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })
async function mount(component: ReactNode) {
  await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}>
    <I18nProvider initialLocale="en">{component}</I18nProvider>
  </QueryClientProvider></MemoryRouter>))
}

// Local fork: aclide and waterfall stay pickable (server UNLISTED_PLATFORMS still hides them on the Keys list when unconfigured).
it.each(['aclide', 'waterfall'])('keeps %s pickable for new keys in the local fork', platform => {
  expect(PLATFORMS.find(p => p.value === platform)).toMatchObject({ label: expect.any(String), url: expect.any(String) })
  expect(PLATFORMS.find(p => p.value === platform)?.hidden).toBeFalsy()
  expect(LISTED_PLATFORMS.some(p => p.value === platform)).toBe(true)
  expect(LISTED_PLATFORMS.some(p => p.value === 'clod')).toBe(true)
})

it('lists Waterfall and ACLIDE in the add-key provider picker', async () => {
  await mount(<AddKeyForm onSuccess={() => {}} />)
  const options = [...container.querySelectorAll('option')].map(option => option.value)
  expect(options).toContain('groq')
  expect(options).toContain('rime')
  expect(options).toContain('freetts')
  expect(PLATFORMS.find(p => p.value === 'freetts')?.label).toMatch(/personal use only.*watermarked/i)
  expect(options).toContain('waterfall')
  expect(options).toContain('aclide')
})

it('offers Varosity without promising a recurring daily credit', async () => {
  await mount(<AddKeyForm onSuccess={() => {}} />)
  const option = container.querySelector('option[value="varosity"]')
  expect(option).not.toBeNull()
  expect(option?.textContent).toContain('Varosity')
  expect(option?.textContent).not.toMatch(/daily/i)
})

it('lists Waterfall and ACLIDE in the add-model provider picker', async () => {
  await mount(<AddModelDialog open onOpenChange={() => {}} />)
  const options = [...container.querySelectorAll('#provider-platform-select option')].map(option => (option as HTMLOptionElement).value)
  expect(options).toContain('groq')
  expect(options).toContain('waterfall')
  expect(options).toContain('aclide')
})
