import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readThemePreference, useThemePreference } from './useThemePreference';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('theme preference', () => {
  it('defaults to the system and restores an explicit preference on the next visit', () => {
    const first = renderHook(useThemePreference);
    expect(document.documentElement.dataset.theme).toBe('system');
    act(() => first.result.current[1]('dark'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    first.unmount();
    const second = renderHook(useThemePreference);
    expect(second.result.current[0]).toBe('dark');
    act(() => second.result.current[1]('system'));
    expect(localStorage.getItem('workspace.theme')).toBe('system');
  });

  it('uses the system for an invalid saved value', () => {
    localStorage.setItem('workspace.theme', 'invalid');
    expect(readThemePreference()).toBe('system');
  });

  it('still switches when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const theme = renderHook(useThemePreference);
    act(() => theme.result.current[1]('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
