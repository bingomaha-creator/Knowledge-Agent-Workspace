import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { BugReviewWorkspace } from './BugReviewWorkspace';
import { bugReviewApi, type BugReview } from '@/services/bugReviewApi';

it('keeps incomplete evidence visible and requires saving edits before approval', async () => {
  const document = {title:'Upload error',symptom:'上传失败',root_cause:{content:'待确认',basis:'inference',source:{}},impact:{scope:'upload',severity:'P2'},fix_solution:'处理异常',prevention:'建议增加测试',validation:'未提供',related_modules:[],keywords:['upload'],source_refs:[],completeness:'incomplete',gaps:['根因待确认'],human_notes:''} as const;
  const review = {id:'demo',identity:{owner:'a',repo:'b',number:1,url:'https://github.com/a/b/pull/1'},revision:1,status:'draft',document,candidate:document,material:{sources:[],gaps:[]},history:[],published:null,task:{id:'t',status:'failed',error:{code:'MODEL_FAILED',message:'生成失败，原稿保留'},operation:'import'}} as unknown as BugReview;
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'get').mockResolvedValue(review);
  vi.spyOn(bugReviewApi,'library').mockResolvedValue([]);
  const action = vi.spyOn(bugReviewApi,'action').mockImplementation(async (_id,_operation,body) => ({...review,document:body.document || review.document,revision:2}));
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><BugReviewWorkspace section="review" selectedId="demo" query="" onNavigate={vi.fn()} /></QueryClientProvider>);
  await screen.findAllByRole('heading',{name:'证据不完整'});
  expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('标题'));
  await user.type(screen.getByLabelText('标题'),'人工修订');
  expect(screen.getByRole('button',{name:'审核通过'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'丢弃新结果'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'重试采集与生成'})).toBeDisabled();
  await user.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(() => expect(action).toHaveBeenCalledWith('demo','edit',expect.objectContaining({document:expect.objectContaining({title:'人工修订'})})));
  vi.restoreAllMocks();
});

it('restores search input when URL query changes', async () => {
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'library').mockResolvedValue([]);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const onNavigate = vi.fn();
  const wrap = (query:string) => <QueryClientProvider client={client}><BugReviewWorkspace section="library" query={query} onNavigate={onNavigate}/></QueryClientProvider>;
  const view = render(wrap('upload'));
  expect(screen.getByLabelText('搜索修复经验')).toHaveValue('upload');
  view.rerender(wrap('ETag'));
  await waitFor(()=>expect(screen.getByLabelText('搜索修复经验')).toHaveValue('ETag'));
  vi.restoreAllMocks();
});
