/**
 * 持久化 Chat 模块。
 *
 * openReply 在发送 SSE Header 前完成输入校验、幂等检查与首轮原子写入，再返回
 * accepted 快照和一次性 runtime。runtime 从数据库构造 Orchestrator 输入，并把领域
 * 事件聚合回 assistant 消息；路由只需要映射 HTTP/SSE，不接触会话状态机。
 */

const DEFAULT_CHECKPOINT_INTERVAL_MS = 750;

function createServiceError(code, message, status = 400, details = '') {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function mergeTool(tools, incoming) {
  if (!incoming || typeof incoming !== 'object') return tools;
  const index = tools.findIndex((tool) => tool.id === incoming.id);
  if (index < 0) return [...tools, incoming];
  return tools.map((tool, toolIndex) => (
    toolIndex === index ? { ...tool, ...incoming } : tool
  ));
}

function completedConversationMessages(messages, currentUserMessageId) {
  const completedRequests = new Set(
    messages
      .filter((message) => message.role === 'assistant' && message.status === 'done')
      .map((message) => message.requestId)
  );
  return messages.flatMap((message) => {
    const isCurrentUser = message.id === currentUserMessageId;
    const belongsToCompletedTurn = completedRequests.has(message.requestId);
    if (!isCurrentUser && !belongsToCompletedTurn) return [];
    if (message.role === 'assistant' && message.status !== 'done') return [];
    return [{ id: message.id, role: message.role, content: message.content }];
  });
}

function replayEvent(message) {
  if (message.status === 'error') {
    return {
      type: 'error',
      data: {
        code: message.errorCode || 'CHAT_REPLY_FAILED',
        message: message.errorMessage || '回答生成失败',
        details: '',
        messageRecord: message
      }
    };
  }
  return {
    type: 'done',
    data: {
      citations: message.citations,
      tools: message.tools,
      run: message.runId ? { id: message.runId, status: message.status } : null,
      message,
      replayed: true
    }
  };
}

export function createChatService({
  store,
  orchestrator,
  checkpointIntervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (!store || !orchestrator?.run) {
    throw new TypeError('Chat service requires a store and orchestrator.');
  }

  const checkpointDelay = Math.max(0, Number(checkpointIntervalMs) || 0);
  let activeRuntime = null;

  function openReply(input = {}) {
    if (activeRuntime) {
      throw createServiceError(
        'CHAT_STREAM_ACTIVE',
        '当前已有正在生成的回答',
        409
      );
    }

    const started = store.startTurn(input);
    const accepted = {
      reused: started.reused,
      session: started.session,
      userMessage: started.userMessage,
      assistantMessage: started.assistantMessage
    };

    if (started.reused && started.assistantMessage.status === 'streaming') {
      throw createServiceError(
        'CHAT_STREAM_ACTIVE',
        '该请求仍在生成中',
        409
      );
    }

    if (started.reused) {
      let replayed = false;
      return {
        accepted,
        async run({ emit }) {
          if (replayed) {
            throw createServiceError('CHAT_RUNTIME_USED', '该流式 runtime 已使用', 409);
          }
          replayed = true;
          emit(replayEvent(started.assistantMessage));
          return {
            status: started.assistantMessage.status,
            message: started.assistantMessage,
            replayed: true
          };
        }
      };
    }

    const runtimeIdentity = Symbol(started.assistantMessage.id);
    activeRuntime = runtimeIdentity;
    let runtimeUsed = false;

    return {
      accepted,
      async run({ signal, emit }) {
        if (runtimeUsed) {
          throw createServiceError('CHAT_RUNTIME_USED', '该流式 runtime 已使用', 409);
        }
        runtimeUsed = true;

        const messageId = started.assistantMessage.id;
        let snapshot = started.assistantMessage;
        let content = snapshot.content;
        let citations = snapshot.citations;
        let tools = snapshot.tools;
        let memoryCandidate = snapshot.memoryCandidate;
        let runId = snapshot.runId;
        let latestRun = null;
        let checkpointTimer = null;
        let terminalMessage = null;
        let terminalError = null;

        function clearCheckpoint() {
          if (checkpointTimer === null) return;
          clearTimer(checkpointTimer);
          checkpointTimer = null;
        }

        function persist(status = 'streaming', error = null) {
          clearCheckpoint();
          snapshot = store.updateAssistantMessage(messageId, {
            content,
            status,
            citations,
            tools,
            memoryCandidate,
            runId,
            errorCode: error?.code || '',
            errorMessage: error?.message || ''
          });
          if (status !== 'streaming') terminalMessage = snapshot;
          return snapshot;
        }

        function scheduleCheckpoint() {
          if (terminalMessage || checkpointTimer !== null) return;
          if (checkpointDelay === 0) {
            persist('streaming');
            return;
          }
          checkpointTimer = setTimer(() => {
            checkpointTimer = null;
            if (!terminalMessage) persist('streaming');
          }, checkpointDelay);
        }

        function forward(event) {
          const data = event?.data || {};
          if (event?.type === 'token') {
            content += typeof data.token === 'string' ? data.token : '';
            scheduleCheckpoint();
            emit(event);
            return;
          }
          if (event?.type === 'tool') {
            tools = mergeTool(tools, data);
            scheduleCheckpoint();
            emit(event);
            return;
          }
          if (event?.type === 'citations') {
            citations = Array.isArray(data.citations) ? data.citations : citations;
            scheduleCheckpoint();
            emit(event);
            return;
          }
          if (event?.type === 'memory_candidate') {
            memoryCandidate = data.candidate && typeof data.candidate === 'object'
              ? data.candidate
              : memoryCandidate;
            scheduleCheckpoint();
            emit(event);
            return;
          }
          if (event?.type === 'run') {
            latestRun = data.run || latestRun;
            runId = data.run?.id || runId;
            scheduleCheckpoint();
            emit(event);
            return;
          }
          if (event?.type === 'done') {
            citations = Array.isArray(data.citations) ? data.citations : citations;
            tools = Array.isArray(data.tools) ? data.tools : tools;
            latestRun = data.run || latestRun;
            runId = data.run?.id || runId;
            const message = persist('done');
            emit({ type: 'done', data: { ...data, message } });
            return;
          }
          if (event?.type === 'error') {
            terminalError = {
              code: data.code || 'CHAT_REPLY_FAILED',
              message: data.message || '回答生成失败',
              details: data.details || ''
            };
            const message = persist('error', terminalError);
            emit({ type: 'error', data: { ...data, message } });
            return;
          }
          emit(event);
        }

        try {
          const page = store.listMessages(started.session.id);
          const messages = completedConversationMessages(
            page.messages,
            started.userMessage.id
          );
          const result = await orchestrator.run({
            messages,
            hasKnowledge: started.session.knowledgeBaseIds.length > 0,
            ragEnabled: started.session.ragEnabled,
            knowledgeBaseIds: started.session.knowledgeBaseIds,
            conversationId: started.session.id,
            sourceMessageIds: [started.userMessage.id, started.assistantMessage.id],
            presetId: started.session.presetId
          }, { signal, emit: forward });

          latestRun = result?.run || latestRun;
          runId = result?.run?.id || runId;
          if (!terminalMessage && result?.status === 'success') {
            const message = persist('done');
            emit({
              type: 'done',
              data: { citations, tools, run: latestRun, message }
            });
          } else if (!terminalMessage && result?.status === 'cancelled') {
            persist('cancelled', {
              code: 'REQUEST_ABORTED',
              message: '请求已取消'
            });
          } else if (!terminalMessage && result?.status === 'error') {
            terminalError = {
              code: result.error?.code || 'CHAT_REPLY_FAILED',
              message: result.error?.message || '回答生成失败',
              details: result.error?.details || ''
            };
            const message = persist('error', terminalError);
            emit({ type: 'error', data: { ...terminalError, message } });
          }
          return { ...result, message: terminalMessage || snapshot };
        } catch (error) {
          const cancelled = Boolean(signal?.aborted || error?.code === 'REQUEST_ABORTED');
          terminalError = {
            code: cancelled ? 'REQUEST_ABORTED' : error?.code || 'CHAT_REPLY_FAILED',
            message: cancelled ? '请求已取消' : error?.message || '回答生成失败',
            details: error?.details || ''
          };
          if (!terminalMessage) {
            const message = persist(cancelled ? 'cancelled' : 'error', terminalError);
            if (!cancelled) {
              emit({ type: 'error', data: { ...terminalError, message } });
            }
          }
          return {
            status: cancelled ? 'cancelled' : 'error',
            run: latestRun,
            error: terminalError,
            message: terminalMessage
          };
        } finally {
          clearCheckpoint();
          if (activeRuntime === runtimeIdentity) activeRuntime = null;
        }
      }
    };
  }

  return {
    openReply,
    listSessions: (options) => store.listSessions(options),
    getSession: (id) => store.getSession(id),
    listMessages: (id, options) => store.listMessages(id, options),
    getMessage: (id) => store.getMessage(id),
    updateSession: (id, patch) => store.updateSession(id, patch),
    deleteSession: (id) => store.deleteSession(id)
  };
}
