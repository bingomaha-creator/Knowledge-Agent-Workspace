import { useQuery } from '@tanstack/react-query';
import { Thinking, type ThinkingStatus } from 'matthew-ui/thinking';
import { ToolCall, type ToolCallStatus } from 'matthew-ui/tool-call';
// 第三方组件通过编译后、按需 CSS 接入；主题由 GlobalStyles 的公开变量映射提供。
import 'matthew-ui/thinking/style.css';
import 'matthew-ui/tool-call/style.css';
import styled from 'styled-components';
import { chatApi } from '@/services/chatApi';
import { Button } from '@/ui/Button';
import { Feedback } from '@/ui/Feedback';
import { chatQueryKeys } from './chatQueries';
import type { AgentRun, ChatMessage } from './chat.types';

const Execution = styled.section`
  display: grid;
  width: min(100%, 46rem);
  min-width: 0;
  gap: var(--space-2);

  .matthew-tool-call__header {
    min-height: var(--matthew-ui-control-height-md);
    gap: 0.625rem;
    padding: 0.5rem 0.75rem;
    font-size: var(--matthew-ui-font-size-md);
    font-weight: 500;
  }
  .matthew-tool-call__summary {
    flex: 0 1 auto;
    font-size: inherit;
    text-align: right;
  }
  .matthew-tool-call__status { width: 0.75rem; height: 0.75rem; }
  .matthew-tool-call__arrow {
    border-top: 0;
    border-bottom: 1.5px solid currentColor;
  }
  .matthew-tool-call__header[aria-expanded='true'] .matthew-tool-call__arrow {
    transform: rotate(225deg);
  }
`;

const ToolDetails = styled.div`
  min-width: 0;
  p { margin: var(--space-2) 0; }
  pre {
    max-width: 100%;
    margin: var(--space-2) 0;
    padding: var(--space-3);
    border-radius: var(--radius-control);
    background: var(--color-background);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
  }
`;

const RunDetails = styled.div`
  min-width: 0;
  p { margin: var(--space-2) 0; }
  ul { padding-left: var(--space-5); }
  li { margin: var(--space-2) 0; overflow-wrap: anywhere; }
`;

const toolLabels: Record<ToolCallStatus, string> = {
  pending: '等待执行', running: '执行中', completed: '已完成', error: '执行失败', stopped: '未完成，结果未确认'
};
const runLabels: Record<ThinkingStatus, string> = {
  running: '执行中', completed: '已完成', error: '执行异常', stopped: '已停止'
};
const stepNames: Record<string, string> = {
  mcp_connect: '连接工具服务', mcp_tool_discovery: '发现可用工具',
  knowledge_scope_check: '检查资料范围', retrieve_memory: '检索长期记忆',
  retrieve_knowledge: '检索资料库', read_knowledge_document: '读取知识文档',
  knowledge_evidence_gate: '评估资料证据', tool_planning: '规划工具调用',
  generation: '生成最终回答', memory_candidate_extraction: '提取记忆候选'
};
const toolNames: Record<string, string> = {
  retrieve_knowledge: '检索资料库', read_knowledge_document: '读取知识文档',
  list_knowledge_documents: '列出资料库文档', get_current_time: '获取当前时间'
};
const runTitles: Record<AgentRun['status'], string> = {
  running: '正在执行…', success: '执行详情', cancelled: '已停止 · 执行详情',
  error: '执行失败 · 查看详情', interrupted: '执行中断 · 查看详情'
};
const runStatuses: Record<AgentRun['status'], ThinkingStatus> = {
  running: 'running', success: 'completed', cancelled: 'stopped', error: 'error', interrupted: 'error'
};
const spanLabels: Record<AgentRun['status'], string> = {
  running: '执行中', success: '已完成', cancelled: '已停止', error: '执行失败', interrupted: '执行中断'
};

type Props = {
  message: ChatMessage;
  expandedDetails: ReadonlySet<string>;
  onDetailsChange: (key: string, open: boolean) => void;
};

export function ChatExecutionDetails({ message, expandedDetails, onDetailsChange }: Props) {
  const runQuery = useQuery({
    queryKey: chatQueryKeys.run(message.runId || ''),
    queryFn: () => chatApi.getRun(message.runId!),
    enabled: Boolean(message.runId && !message.run),
    staleTime: Number.POSITIVE_INFINITY
  });
  const run = message.run || runQuery.data;
  // 消息终态优先收敛旧快照，避免停止/断流后历史 running 仍持续动画。
  const status: AgentRun['status'] = message.status === 'streaming'
    ? run?.status || 'running'
    : message.status === 'done' ? (run?.status === 'running' ? 'success' : run?.status || 'success')
      : message.status;
  const runKey = `${message.id}:run`;

  return (
    <>
      {message.tools.length ? (
        <Execution aria-label="工具调用">
          {message.tools.map((tool) => {
            const unfinished = tool.status === 'pending' || tool.status === 'running';
            const toolStatus: ToolCallStatus = unfinished && status !== 'running'
              ? 'stopped' : tool.status === 'success' ? 'completed' : tool.status;
            const key = `${message.id}:tool:${tool.id}`;
            return (
              <ToolCall
                key={tool.id}
                name={toolNames[tool.name] || tool.name}
                status={toolStatus}
                summary={toolLabels[toolStatus]}
                statusLabels={toolLabels}
                open={expandedDetails.has(key)}
                onOpenChange={(open) => onDetailsChange(key, open)}
              >
                <ToolDetails>
                  <p>参数</p><pre>{JSON.stringify(tool.args, null, 2)}</pre>
                  {tool.result !== undefined ? <><p>结果</p><pre>{typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}</pre></> : null}
                  {toolStatus === 'stopped' ? <p>本轮已结束，未收到该工具的完成结果。</p> : null}
                </ToolDetails>
              </ToolCall>
            );
          })}
        </Execution>
      ) : null}
      {message.role === 'assistant' && (message.status === 'streaming' || run || message.runId) ? (
        <Execution aria-label="执行过程">
          <Thinking
            title={runTitles[status]}
            status={runStatuses[status]}
            statusLabels={runLabels}
            open={expandedDetails.has(runKey)}
            onOpenChange={(open) => onDetailsChange(runKey, open)}
          >
            <RunDetails>
              <p>{spanLabels[status]}</p>
              {run ? <>
                <p>输入 {run.inputTokens || 0} · 输出 {run.outputTokens || 0} tokens</p>
                <ul>{(run.spans || []).map((span) => (
                  <li key={span.id}>
                    {stepNames[span.name] || span.name} · {span.status === 'running' && status !== 'running' ? '未完成，结果未确认' : spanLabels[span.status]}
                    {span.durationMs != null ? ` · ${span.durationMs}ms` : ''}
                    {span.errorMessage ? ` · ${span.errorMessage}` : ''}
                  </li>
                ))}</ul>
              </> : runQuery.isError ? (
                <Feedback tone="danger" role="alert" action={<Button size="sm" onClick={() => void runQuery.refetch()}>重试读取详情</Button>}>
                  执行详情读取失败，回答正文仍可阅读。
                </Feedback>
              ) : <p>{message.runId ? '正在读取执行详情…' : '等待执行步骤更新…'}</p>}
            </RunDetails>
          </Thinking>
        </Execution>
      ) : null}
    </>
  );
}
