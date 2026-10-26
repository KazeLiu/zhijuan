import type { LibraryFileDTO, Paginated } from '#shared/types'

export function useBankCatalog() {
  return useAsyncData('zj-bank-catalog', async () => {
    const [knowledgePoints, library] = await Promise.all([
      apiFetch<string[]>('/api/admin/question-bank/knowledge-points', { silent: true }),
      apiFetch<Paginated<LibraryFileDTO>>('/api/admin/library', { query: { pageSize: 100 }, silent: true }),
    ])
    return { knowledgePoints, files: library.items.filter((file) => file.status === 'parsed') }
  }, { server: false })
}
