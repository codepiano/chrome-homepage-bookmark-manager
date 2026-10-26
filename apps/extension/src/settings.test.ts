import { describe, expect, it } from 'vitest';
import { settingsUpdate } from './settings';
import { defaultSettings } from './types';

describe('settings update compatibility', () => {
  it('keeps writable response values and removes server metadata', () => {
    const response = { ...defaultSettings, theme: 'dark' as const, textColor: null, updatedAt: '2026-10-26', futureMetadata: true };
    expect(settingsUpdate(response)).toEqual({ ...defaultSettings, theme: 'dark', textColor: null });
  });
  it('keeps partial updates partial, including false and zero', () => {
    expect(settingsUpdate({ compact: false, gap: 0 })).toEqual({ compact: false, gap: 0 });
  });
});
