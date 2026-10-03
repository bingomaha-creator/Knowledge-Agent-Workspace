const CALLERS = new Set(['chat', 'research', 'internal']);
const INVOCATIONS = new Set(['autonomous', 'orchestrated', 'explicit']);

function spec(definition) {
  return Object.freeze({
    allowedInResearch: false,
    requiresExplicitAction: false,
    forcedScopeArg: undefined,
    ...definition,
    effects: Object.freeze([...definition.effects]),
    allowedCallers: Object.freeze([...definition.allowedCallers])
  });
}

const TOOL_SPECS = [
  spec({
    name: 'retrieve_knowledge',
    description: '从后端向量知识库检索与用户问题最相关的文档片段',
    effects: ['knowledge.read'],
    autonomous: true,
    allowedInResearch: true,
    allowedCallers: ['chat', 'research'],
    forcedScopeArg: 'knowledgeBaseIds'
  }),
  spec({
    name: 'read_knowledge_document',
    description: '读取当前授权资料库中一份已发布知识文档的正文；仅在需要查看、分析或对比指定文档内容时使用，长文档按 nextOffset 继续读取',
    effects: ['knowledge.read'],
    autonomous: true,
    allowedCallers: ['chat'],
    forcedScopeArg: 'knowledgeBaseIds'
  }),
  spec({
    name: 'list_knowledge_documents',
    description: '列出当前后端知识库中的文档',
    effects: ['knowledge.read'],
    autonomous: true,
    allowedCallers: ['chat', 'internal'],
    forcedScopeArg: 'knowledgeBaseIds'
  }),
  spec({
    name: 'ingest_knowledge_documents',
    description: '导入知识草稿并在后台建立预索引；发布前不参与检索',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'get_knowledge_document_preview',
    description: '预览知识文档的正文摘要、标题结构和分块结果',
    effects: ['knowledge.read'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'publish_knowledge_document',
    description: '发布已就绪的知识草稿，使其可被 Chat、Research 和 RAG 检索',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'withdraw_knowledge_document',
    description: '撤回已发布知识并保留预索引，使其不再参与检索',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'delete_knowledge_document',
    description: '删除指定的知识文档以及对应的向量索引',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'clear_knowledge_documents',
    description: '清空知识库中的所有文档与向量索引',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'list_knowledge_bases',
    description: '列出知识库工作区',
    effects: ['knowledge.read'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'create_knowledge_base',
    description: '创建一个知识库工作区',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'update_knowledge_base',
    description: '更新知识库工作区',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'delete_knowledge_base',
    description: '删除知识库工作区；非空库需要 force=true',
    effects: ['knowledge.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'retrieve_memory',
    description: '检索与当前问题相关、且已经由用户确认或纠正的长期记忆',
    effects: ['memory.read'],
    autonomous: false,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'create_memory',
    description: '根据用户显式填写的内容创建一条已确认长期记忆',
    effects: ['memory.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'propose_memory',
    description: '保存一条待用户审查的长期记忆候选；候选不会参与召回',
    effects: ['memory.write'],
    autonomous: false,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'list_memories',
    description: '列出长期记忆及待审查候选',
    effects: ['memory.read'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'update_memory',
    description: '确认、纠正、拒绝或编辑一条长期记忆',
    effects: ['memory.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'delete_memory',
    description: '删除指定长期记忆或候选',
    effects: ['memory.write'],
    autonomous: false,
    requiresExplicitAction: true,
    allowedCallers: ['internal']
  }),
  spec({
    name: 'get_current_time',
    description: '获取当前系统时间',
    effects: ['clock.read'],
    autonomous: true,
    allowedCallers: ['chat']
  }),
  spec({
    name: 'search_web',
    description: '通过受控、可替换的外部检索 provider 搜索公开网页；未配置时会结构化降级',
    effects: ['network.read'],
    autonomous: false,
    allowedInResearch: true,
    allowedCallers: ['research']
  })
];

const TOOL_SPECS_BY_NAME = new Map(TOOL_SPECS.map((item) => [item.name, item]));

export function getToolSpec(name) {
  return TOOL_SPECS_BY_NAME.get(name);
}

export function listToolSpecs() {
  return [...TOOL_SPECS];
}

function allowedNameContains(allowedToolNames, name) {
  if (allowedToolNames instanceof Set) return allowedToolNames.has(name);
  return Array.isArray(allowedToolNames) && allowedToolNames.includes(name);
}

function rejected(specification, code, reason) {
  return { allowed: false, code, reason, spec: specification };
}

export function evaluateToolCall(name, context = {}) {
  const specification = getToolSpec(name);
  if (!specification) {
    return rejected(undefined, 'UNKNOWN_TOOL', `未知工具 ${name}`);
  }
  if (!CALLERS.has(context.caller) || !INVOCATIONS.has(context.invocation)) {
    return rejected(specification, 'UNTRUSTED_TOOL_CONTEXT', '工具调用缺少可信执行上下文');
  }
  if (!specification.allowedCallers.includes(context.caller)) {
    return rejected(
      specification,
      'CALLER_NOT_ALLOWED',
      `${context.caller} 不能调用工具 ${name}`
    );
  }
  if (context.caller === 'research' && !specification.allowedInResearch) {
    return rejected(specification, 'RESEARCH_TOOL_NOT_ALLOWED', `研究流程不能调用工具 ${name}`);
  }
  if (specification.requiresExplicitAction && context.invocation !== 'explicit') {
    return rejected(specification, 'EXPLICIT_ACTION_REQUIRED', `工具 ${name} 需要显式用户动作`);
  }
  if (context.invocation === 'autonomous' && !specification.autonomous) {
    return rejected(specification, 'AUTONOMOUS_TOOL_NOT_ALLOWED', `工具 ${name} 不允许自主执行`);
  }
  if (
    context.allowedToolNames !== undefined &&
    !allowedNameContains(context.allowedToolNames, name)
  ) {
    return rejected(specification, 'TOOL_NOT_IN_REQUEST_SCOPE', `工具 ${name} 不在本轮允许集合中`);
  }
  if (context.knowledgeScopeEnabled === false && specification.forcedScopeArg) {
    return rejected(specification, 'KNOWLEDGE_SCOPE_DISABLED', '本轮未启用知识库范围');
  }
  return { allowed: true, code: '', reason: '', spec: specification };
}

export function filterTools(tools, context) {
  return tools.filter((tool) => evaluateToolCall(tool.name, context).allowed);
}

export function applyTrustedToolArguments(name, args = {}, context = {}) {
  const specification = getToolSpec(name);
  if (!specification?.forcedScopeArg || !Array.isArray(context.knowledgeBaseIds)) {
    return { ...args };
  }
  return {
    ...args,
    [specification.forcedScopeArg]: [...context.knowledgeBaseIds]
  };
}

function createPolicyError(name, decision) {
  const error = new Error(`工具 ${name} 不在本轮服务端白名单中`);
  error.code = 'TOOL_NOT_ALLOWED';
  error.details = decision.reason;
  error.status = 403;
  return error;
}

export function createToolExecutor({ gateway }) {
  function prepare(name, args, context) {
    const decision = evaluateToolCall(name, context);
    if (!decision.allowed) throw createPolicyError(name, decision);
    return applyTrustedToolArguments(name, args, context);
  }

  return {
    async callTool(name, args, context, options = {}) {
      return gateway.callTool(name, prepare(name, args, context), options);
    },
    async callToolOrThrow(name, args, context, options = {}) {
      return gateway.callToolOrThrow(name, prepare(name, args, context), options);
    }
  };
}
