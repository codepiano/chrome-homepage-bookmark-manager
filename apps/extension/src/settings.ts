import { defaultSettings, type Settings } from './types';

// Server responses may carry metadata (for example updatedAt) that the strict
// settings update endpoint does not accept. Preserve only writable fields.
export function settingsUpdate(value: Partial<Settings>): Partial<Settings> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(defaultSettings, key)));
}
