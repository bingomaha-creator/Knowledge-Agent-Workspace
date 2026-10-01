import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { BugReviewWorkspace } from './BugReviewWorkspace';
import { bugReviewApi, type BugReview } from '@/services/bugReviewApi';
import { BugReview as BugReviewPage } from '@/pages/BugReview';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

it('opens the published snapshot instead of an unpublished working draft', async () => {
  const document = {title:'工作稿新标题',symptom:'尚未发布的现象',root_cause:{content:'待确认',basis:'inference',source:{}},impact:{scope:'upload',severity:'P2'},fix_solution:'处理异常',prevention:'建议增加测试',related_modules:[],keywords:[],source_refs:[],completeness:'incomplete',gaps:['根因待确认'],human_notes:''};
  const review = {id:'demo',identity:{owner:'a',repo:'b',number:1,url:'https://github.com/a/b/pull/1'},revision:2,status:'draft',document,candidate:null,material:{sources:[],gaps:[]},history:[],published:{document:{...document,title:'已发布的复盘',symptom:'已发布的现象'},material:{sources:[],gaps:[]},published_at:'2026-10-01T10:00:00Z',revision:1},task:{id:'t',status:'completed',error:null,operation:'import'}} as unknown as BugReview;
  review.material = {sources:[{id:'pr',type:'pr_body',url:review.identity.url,text:'重新采集的新材料'}],gaps:['最新材料仍有缺口']};
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'get').mockResolvedValue(review);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><BugReviewWorkspace section="review" selectedId="demo" query="" onNavigate={vi.fn()} /></QueryClientProvider>);
  expect(await screen.findByRole('heading',{name:'已发布的复盘'})).toBeInTheDocument();
  expect(screen.getByText('已发布的现象')).toBeInTheDocument();
  expect(screen.queryByText('尚未发布的现象')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox',{name:'标题'})).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByText('证据缺口与人工修订记录（1）'));
  expect(screen.getByText('根因待确认')).toBeVisible();
  await user.click(screen.getByText('材料更新与重新生成'));
  await user.click(screen.getByText('查看采集材料、diff 与来源（1）'));
  expect(screen.getByText('重新采集的新材料')).toBeVisible();
  expect(screen.getByText('最新材料仍有缺口')).toBeVisible();
  vi.restoreAllMocks();
});

it('keeps incomplete evidence visible and requires saving edits before approval', async () => {
  const document = {title:'Upload error',symptom:'上传失败',root_cause:{content:'待确认',basis:'inference',source:{}},impact:{scope:'upload',severity:'P2'},fix_solution:'处理异常',prevention:'建议增加测试',validation:'未提供',related_modules:[],keywords:['upload'],source_refs:[],completeness:'incomplete',gaps:['根因待确认'],human_notes:''} as const;
  const review = {id:'demo',identity:{owner:'a',repo:'b',number:1,url:'https://github.com/a/b/pull/1'},revision:1,status:'draft',document,candidate:document,material:{sources:[],gaps:[]},history:[],published:null,task:{id:'t',status:'failed',error:{code:'MODEL_FAILED',message:'生成失败，原稿保留'},operation:'import'}} as unknown as BugReview;
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  let currentReview = review;
  vi.spyOn(bugReviewApi,'get').mockImplementation(async()=>currentReview);
  vi.spyOn(bugReviewApi,'library').mockResolvedValue([]);
  const action = vi.spyOn(bugReviewApi,'action').mockImplementation(async (_id,_operation,body) => {
    currentReview = {...review,document:body.document || review.document,revision:2};
    return currentReview;
  });
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  render(<QueryClientProvider client={client}><RouterProvider router={createMemoryRouter([{path:'/bug-review/:section?/:reviewId?',element:<BugReviewPage/>}],{initialEntries:['/bug-review/review/demo']})}/></QueryClientProvider>);
  expect(await screen.findByText(/工作稿.*证据不完整/)).toBeInTheDocument();
  expect(screen.queryByRole('textbox',{name:'标题'})).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button',{name:'编辑复盘'}));
  await user.clear(screen.getByLabelText('标题'));
  await user.type(screen.getByLabelText('标题'),'人工修订');
  expect(screen.queryByRole('button',{name:'审核通过'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'丢弃新结果'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'重试采集与生成'})).not.toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'保存草稿'}));
  await waitFor(() => expect(action).toHaveBeenCalledWith('demo','edit',expect.objectContaining({document:expect.objectContaining({title:'人工修订'})})));
  expect(await screen.findByRole('heading',{name:'人工修订'})).toBeInTheDocument();
  expect(screen.queryByRole('textbox',{name:'标题'})).not.toBeInTheDocument();
  vi.restoreAllMocks();
});

it('starts the module in the published library', async () => {
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  const library = vi.spyOn(bugReviewApi,'library').mockResolvedValue([]);
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  render(<QueryClientProvider client={client}><RouterProvider router={createMemoryRouter([{path:'/bug-review/:section?/:reviewId?',element:<BugReviewPage/>}],{initialEntries:['/bug-review']})}/></QueryClientProvider>);
  expect(await screen.findByRole('heading',{name:'选择案例开始阅读'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'案例库'})).toHaveAttribute('aria-pressed','true');
  expect(library).toHaveBeenCalledWith('');
  vi.restoreAllMocks();
});

it('edits the latest working draft from the library and retains input after a failed save', async () => {
  const document = {title:'尚未发布的新标题',symptom:'工作稿现象',root_cause:{content:'待确认',basis:'inference',source:{}},impact:{scope:'upload',severity:'P2'},fix_solution:'处理异常',prevention:'建议增加测试',related_modules:[],keywords:[],source_refs:[],completeness:'incomplete',gaps:[],human_notes:''};
  const review = {id:'demo',identity:{owner:'a',repo:'b',number:1,url:'https://github.com/a/b/pull/1'},revision:2,status:'draft',document,candidate:null,material:{sources:[],gaps:[]},history:[],published:{document:{...document,title:'已发布的旧标题',symptom:'已发布的现象'},material:{sources:[],gaps:[]},published_at:'2026-10-01T10:00:00Z',revision:1},task:{id:'t',status:'completed',error:null,operation:'import'}} as unknown as BugReview;
  review.material!.sources = [
    {id:'comments:1',type:'pr_comment',url:'https://github.com/a/b/pull/1#comment1',text:'第一条讨论证据'},
    {id:'comments:2',type:'pr_comment',url:'https://github.com/a/b/pull/1#comment2',text:'第二条讨论证据'}
  ];
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'library').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'get').mockResolvedValue(review);
  vi.spyOn(bugReviewApi,'published').mockResolvedValue({id:review.id,identity:review.identity,...review.published!});
  const action = vi.spyOn(bugReviewApi,'action').mockRejectedValue(new Error('保存失败，请重试'));
  const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
  const router = createMemoryRouter([{path:'/bug-review/:section?/:reviewId?',element:<BugReviewPage/>}],{initialEntries:['/bug-review/library/demo']});
  render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);
  expect(await screen.findByRole('heading',{name:'已发布的旧标题'})).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button',{name:'编辑复盘'}));
  expect(await screen.findByRole('textbox',{name:'标题'})).toHaveValue('尚未发布的新标题');
  await user.click(screen.getByText('编辑根因依据与原文引用'));
  expect(screen.getByRole('option',{name:'PR 评论 1'})).toBeInTheDocument();
  expect(screen.getByRole('option',{name:'PR 评论 2'})).toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox',{name:'根因来源'}),'comments:2');
  await user.click(screen.getByText('查看所选来源原文'));
  expect(screen.getByText('第二条讨论证据')).toBeVisible();
  await user.clear(screen.getByRole('textbox',{name:'标题'}));
  await user.type(screen.getByRole('textbox',{name:'标题'}),'需要审核的修改');
  await user.click(screen.getByRole('button',{name:'保存草稿'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败，请重试');
  expect(screen.getByRole('textbox',{name:'标题'})).toHaveValue('需要审核的修改');
  expect(action).toHaveBeenCalledTimes(1);
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal('confirm',confirm);
  await act(async()=>{await router.navigate(-1);});
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('textbox',{name:'标题'})).toHaveValue('需要审核的修改');
  await user.click(screen.getByRole('button',{name:'案例库'}));
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('textbox',{name:'标题'})).toHaveValue('需要审核的修改');
  await user.click(screen.getByRole('button',{name:'放弃修改，返回阅读'}));
  expect(await screen.findByRole('heading',{name:'已发布的旧标题'})).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  vi.restoreAllMocks();
});

it.each(['success','failure'])('keeps a newly selected case visible when an old candidate adoption ends with %s', async result => {
  const document = {title:'案例 A',symptom:'A 的现象',root_cause:{content:'待确认',basis:'inference',source:{}},impact:{scope:'upload',severity:'P2'},fix_solution:'处理异常',prevention:'建议增加测试',related_modules:[],keywords:[],source_refs:[],completeness:'incomplete',gaps:[],human_notes:''};
  const first = {id:'a',identity:{owner:'a',repo:'b',number:1,url:'https://github.com/a/b/pull/1'},revision:2,status:'draft',document,candidate:{...document,title:'A 的新结果'},material:{sources:[],gaps:[]},history:[],published:null,task:{id:'t',status:'completed',error:null,operation:'regenerate'}} as unknown as BugReview;
  const second = {...first,id:'b',document:{...first.document!,title:'案例 B'},candidate:null};
  vi.spyOn(bugReviewApi,'list').mockResolvedValue([]);
  vi.spyOn(bugReviewApi,'get').mockImplementation(async id=>id==='a'?first:second);
  let finish!: (review:BugReview)=>void;
  let fail!: (error:Error)=>void;
  const action = vi.spyOn(bugReviewApi,'action').mockImplementation(()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;}));
  const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const navigate = vi.fn();
  const wrap = (id:string) => <QueryClientProvider client={client}><BugReviewWorkspace section="review" selectedId={id} query="" onNavigate={navigate}/></QueryClientProvider>;
  const rendered = render(wrap('a'));
  expect(await screen.findByRole('heading',{name:'案例 A'})).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByText('新生成结果尚未采用 · 证据不完整 · 查看候选'));
  await user.click(screen.getByRole('button',{name:'采用新结果'}));
  await waitFor(()=>expect(action).toHaveBeenCalledTimes(1));
  rendered.rerender(wrap('b'));
  expect(await screen.findByRole('heading',{name:'案例 B'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'编辑复盘'})).not.toBeDisabled();
  await act(async()=>{if(result==='success')finish({...first,document:first.candidate,candidate:null,revision:3});else fail(new Error('旧案例操作失败'));});
  await waitFor(()=>expect(screen.getByRole('button',{name:'编辑复盘'})).not.toBeDisabled());
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.queryByText('旧案例操作失败')).not.toBeInTheDocument();
  expect(screen.getByRole('heading',{name:'案例 B'})).toBeInTheDocument();
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
