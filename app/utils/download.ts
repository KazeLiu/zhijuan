/**
 * 浏览器端文件下载（管理端 Excel 导出用，契约 §10.5）。
 * 用 fetch 取流而不是 window.location，便于把 4xx/5xx 的错误信息展示出来。
 */
import type { ApiErrorBody } from '#shared/types'

function parseFileName(disposition: string): string | null {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1])
    } catch {
      return utf8[1]
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)
  return plain?.[1] ?? null
}

/**
 * 下载接口返回的文件流。
 * @param path 接口路径（同源，带 Cookie）
 * @param fallbackName 服务端未提供文件名时的兜底名称
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const response = await fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  })

  if (!response.ok) {
    let message = `下载失败（HTTP ${response.status}）`
    try {
      const body = (await response.json()) as ApiErrorBody
      if (body?.error?.message) message = body.error.message
    } catch {
      // 响应不是 JSON，保留默认提示
    }
    throw new Error(message)
  }

  const blob = await response.blob()
  const fileName = parseFileName(response.headers.get('content-disposition') ?? '') ?? fallbackName
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // 给浏览器一点时间开始下载再回收
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 2000)
}
