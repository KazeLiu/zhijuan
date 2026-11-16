import type { LibraryFileDTO, Paginated } from '#shared/types'

export function useBankCatalog() {
  return useAsyncData('zj-bank-catalog', async () => {
    const [knowledgePoints, library, sourceGroups] = await Promise.all([
      apiFetch<string[]>('/api/admin/question-bank/knowledge-points', { silent: true }),
      apiFetch<Paginated<LibraryFileDTO>>('/api/admin/library', { query: { pageSize: 100 }, silent: true }),
      apiFetch<string[]>('/api/admin/question-bank/source-groups', { silent: true }),
    ])
    return { knowledgePoints, files: library.items.filter((file) => file.status === 'parsed'), sourceGroups }
  }, { server: false })
}
