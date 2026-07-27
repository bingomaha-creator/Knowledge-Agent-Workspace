export type MemoryType = 'profile' | 'preference' | 'fact' | 'event' | 'pitfall';
export type MemoryStatus = 'candidate' | 'confirmed' | 'corrected' | 'rejected';

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  details: Record<string, unknown>;
  confidence: number;
  status: MemoryStatus;
  sourceConversationId: string;
  sourceMessageIds: string[];
  sourceExcerpt: string;
  sourceExcerptTruncated?: boolean;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number | null;
  score?: number;
}

export type MemoryPatch = Partial<
  Pick<MemoryRecord, 'type' | 'title' | 'content' | 'details' | 'confidence'>
> & { status?: MemoryStatus };

export type MemoryCorrection = Partial<
  Pick<MemoryRecord, 'type' | 'title' | 'content' | 'details' | 'confidence'>
>;

export type MemoryCreateInput = Pick<MemoryRecord, 'type' | 'title' | 'content'>;

export interface MemoryApi {
  listAll(): Promise<MemoryRecord[]>;
  create(input: MemoryCreateInput): Promise<MemoryRecord>;
  update(id: string, patch: MemoryPatch): Promise<MemoryRecord>;
  remove(id: string): Promise<void>;
}
