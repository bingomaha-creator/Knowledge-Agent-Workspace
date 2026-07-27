export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  isDefault: boolean;
  documentCount: number;
  publishedDocumentCount: number;
  draftDocumentCount: number;
  createdAt: number;
  updatedAt: number;
}

export type KnowledgeDocumentStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type KnowledgePublicationStatus = 'draft' | 'published';

export interface KnowledgeDocument {
  id: string;
  name: string;
  knowledgeBaseId: string;
  status: KnowledgeDocumentStatus;
  publicationStatus: KnowledgePublicationStatus;
  publishedAt?: number | null;
  error?: string | null;
  createdAt: number;
  updatedAt?: number;
}

export interface KnowledgePreview {
  excerpt: string;
  truncated: boolean;
  characterCount: number;
  chunkCount: number;
  headings: string[];
}

export interface KnowledgeDocumentPreview {
  document: KnowledgeDocument;
  preview: KnowledgePreview;
}

export interface CreateKnowledgeBaseInput {
  name: string;
  description?: string;
}

export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string;
}

export interface KnowledgeApi {
  listBases(): Promise<KnowledgeBase[]>;
  createBase(input: CreateKnowledgeBaseInput): Promise<KnowledgeBase>;
  updateBase(id: string, input: UpdateKnowledgeBaseInput): Promise<KnowledgeBase>;
  deleteBase(id: string, force?: boolean): Promise<void>;
  listDocuments(knowledgeBaseId: string): Promise<KnowledgeDocument[]>;
  uploadDocuments(
    files: FileList | File[],
    knowledgeBaseId: string
  ): Promise<KnowledgeDocument[]>;
  getDocumentPreview(id: string, knowledgeBaseId: string): Promise<KnowledgeDocumentPreview>;
  publishDocument(id: string, knowledgeBaseId: string): Promise<KnowledgeDocument>;
  withdrawDocument(id: string, knowledgeBaseId: string): Promise<KnowledgeDocument>;
  deleteDocument(id: string, knowledgeBaseId: string): Promise<void>;
  clearDocuments(knowledgeBaseId: string): Promise<void>;
}
