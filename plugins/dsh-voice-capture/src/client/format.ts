/** Display formatting shared by the recording controls. */
import type { AudioInputDevice } from './capture.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slots.ts'

/**
 * Clock text for a duration.
 * @param ms - milliseconds.
 * @returns `m:ss` (or `h:mm:ss` past one hour).
 */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/**
 * Human label for an input device.
 * @param t - namespace translator.
 * @param device - device entry.
 * @param index - position among inputs (1-based label for unnamed devices).
 * @returns label text.
 */
export function deviceText(t: TranslateNS<'voiceCapture'>, device: AudioInputDevice, index: number): string {
  if (device.id === '') return t('device.default')
  return device.label === '' ? t('device.unnamed', { index: index + 1 }) : device.label
}

/**
 * Join truthy class names.
 * @param names - class names or falsy placeholders.
 * @returns space-separated class attribute value.
 */
export function cx(...names: readonly (string | false | undefined)[]): string {
  return names.filter(Boolean).join(' ')
}
