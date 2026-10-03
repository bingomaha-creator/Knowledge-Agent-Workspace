import { useLayoutEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'workspace.theme';

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function useThemePreference() {
  const [preference, setPreference] = useState(readThemePreference);

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = preference;
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch {
      // 浏览器禁用存储时，本次阅读仍可切换外观。
    }
  }, [preference]);

  return [preference, setPreference] as const;
}
