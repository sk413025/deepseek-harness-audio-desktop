/** Browser-side file saving shared by result cards. */

/**
 * Save a Blob under a file name through a temporary object URL.
 * @param blob - content.
 * @param name - suggested file name.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 10_000)
}

/**
 * Fetch an authenticated route and save the response body.
 * @param url - absolute same-origin URL.
 * @param name - suggested file name.
 * @returns whether the download succeeded.
 */
export async function saveRoute(url: string, name: string): Promise<boolean> {
  try {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) return false
    saveBlob(await response.blob(), name)
    return true
  } catch {
    // Network failure or aborted navigation: the caller shows the unavailable state.
    return false
  }
}
