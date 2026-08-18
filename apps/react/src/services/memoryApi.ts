import type { ChatMemoryCandidate, MemoryStatus, MemoryType } from '@/features/chat/chat.types';
import { readJson, type Fetcher } from './sseClient';

export type MemoryPatch = Partial<Pick<
  ChatMemoryCandidate,
  'title' | 'content'
>> & {
  type?: MemoryType;
  status?: MemoryStatus;
};

export function createMemoryApi(fetcher: Fetcher = fetch) {
  return {
    async update(memoryId: string, patch: MemoryPatch) {
      const data = await readJson<{ memory: ChatMemoryCandidate }>(
        `/api/memories/${encodeURIComponent(memoryId)}`,
        {
          method: 'PATCH',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        },
        fetcher
      );
      return data.memory;
    }
  };
}

export const memoryApi = createMemoryApi((input, init) => fetch(input, init));
