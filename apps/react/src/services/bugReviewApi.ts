import { readJson, type Fetcher } from './sseClient';

export type ReviewSource = { type?: string; location?: string; source_id?: string; snippet?: string; url?: string };
export type ReviewDocument = {
  title: string; human_edits?: string[]; symptom?: string; root_cause: { content: string; basis: 'fact' | 'inference' | 'human'; source: ReviewSource };
  impact: { scope: string; severity: string; affected_users?: string | null };
  fix_solution: string; prevention: string; validation?: string;
  related_modules: string[]; keywords: string[]; source_refs: ReviewSource[];
  completeness: 'complete' | 'incomplete'; gaps: string[]; human_notes: string;
};
export type ReviewMaterial = { sources: { id: string; type: string; url: string; text: string }[]; gaps: string[]; collected_at?: string; head_sha?: string; model_gaps?: string[] };
export type ReviewIdentity = { owner: string; repo: string; number: number; url: string };
export type ReviewTask = { id: string; status: 'queued' | 'collecting' | 'generating' | 'completed' | 'failed'; error: {code:string;message:string} | null; operation: string };
export type ReviewSummary = {id:string; identity:ReviewIdentity; revision:number; title:string; status: 'draft' | 'pending' | 'approved' | 'rejected' | 'published'; task:ReviewTask; updated_at:string};
export type PublishedReview = {id:string; identity:ReviewIdentity; document:ReviewDocument; material:ReviewMaterial; published_at:string; revision:number};
export type BugReview = Omit<ReviewSummary,'title'> & { document:ReviewDocument | null; material:ReviewMaterial | null; document_material?:ReviewMaterial | null; candidate:ReviewDocument | null; published:Omit<PublishedReview,'id'|'identity'> | null; history:{action:string;reviewer:string;notes?:string;created_at:string}[] };
export type ReviewOperation = 'edit' | 'approve' | 'reject' | 'publish' | 'retry' | 'refresh' | 'regenerate' | 'adopt' | 'discard';

export function createBugReviewApi(fetcher:Fetcher = fetch) {
  const request = <T>(path:string, body?:unknown) => readJson<T>('/api/bug-review'+path, {
    method: body === undefined ? 'GET' : 'POST', headers:{Accept:'application/json', ...(body === undefined ? {} : {'Content-Type':'application/json'})},
    ...(body === undefined ? {} : {body:JSON.stringify(body)})
  },fetcher);
  return {
    list: async () => (await request<{reviews:ReviewSummary[]}>('/reviews')).reviews,
    get: async (id:string) => (await request<{review:BugReview}>('/reviews/'+encodeURIComponent(id))).review,
    import: async (url:string) => request<{review:BugReview;existing:boolean}>('/import',{url}),
    action: async (id:string, operation:ReviewOperation, body:{revision:number;document?:ReviewDocument;notes?:string}) =>
      (await request<{review:BugReview}>(`/reviews/${encodeURIComponent(id)}/${operation}`,body)).review,
    library: async (q:string) => (await request<{reviews:PublishedReview[]}>('/library?q='+encodeURIComponent(q))).reviews,
    published: async (id:string) => (await request<{review:PublishedReview}>('/library/'+encodeURIComponent(id))).review
  };
}
export const bugReviewApi = createBugReviewApi((input,init) => fetch(input,init));
