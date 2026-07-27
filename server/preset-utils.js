/**
 * Agent 角色（preset）的服务端定义、配置归一化与请求解析。
 *
 * preset 是一组可预期的行为边界：系统提示词、模型参数、few-shot、默认知识库范围
 * 以及 MCP 工具白名单。此模块不负责真正调用模型或工具；上层必须继续用这里产出的
 * toolWhitelist 过滤实际暴露给模型的工具，不能把前端按钮是否显示当成安全控制。
 */
import { listToolSpecs } from './tool-capabilities.js';

const DEFAULT_CHAT_TOOL_NAMES = listToolSpecs()
  .filter((item) => item.autonomous && item.allowedCallers.includes('chat'))
  .map((item) => item.name);
const DEFAULT_CHAT_TOOL_NAME_SET = new Set(DEFAULT_CHAT_TOOL_NAMES);

// 内置角色同时充当可靠默认值：外部配置只能覆盖这些已知 id，不能动态注入新角色。
const BUILT_IN_PRESETS = [
  {
    id: 'general',
    name: '通用助手',
    description: '适合日常问答与通用协作。',
    systemPrompt: '保持准确、清晰、简洁；不确定时明确说明。',
    modelParameters: { temperature: 0.4 },
    toolWhitelist: [...DEFAULT_CHAT_TOOL_NAMES],
    defaultKnowledgeBaseIds: ['kb-default'],
    fewShot: []
  },
  {
    id: 'documents',
    name: '资料助手',
    description: '优先在选定知识库中查证和引用。',
    systemPrompt: '优先依据已选择知识库回答，区分资料事实与推断，并明确资料不足之处。',
    modelParameters: { temperature: 0.2 },
    toolWhitelist: [...DEFAULT_CHAT_TOOL_NAMES],
    defaultKnowledgeBaseIds: ['kb-default'],
    fewShot: [
      {
        user: '资料里没有回答这个问题怎么办？',
        assistant: '我会明确说明资料未覆盖，而不是把一般知识伪装成资料结论。'
      }
    ]
  },
  {
    id: 'code',
    name: '代码助手',
    description: '关注可执行实现、边界和验证。',
    systemPrompt: '给出可执行、可验证的代码建议，优先解释数据流、失败边界和测试方法。',
    modelParameters: { temperature: 0.2 },
    toolWhitelist: [...DEFAULT_CHAT_TOOL_NAMES],
    defaultKnowledgeBaseIds: [],
    fewShot: [
      {
        user: '请修复一个 bug。',
        assistant: '我会先定位可复现原因，再给最小修复并说明验证结果。'
      }
    ]
  },
  {
    id: 'research',
    name: '研究助手',
    description: '拆分问题、组织证据并标记推断。',
    systemPrompt: '先拆解问题，再区分证据、推断和待验证项；引用不足时降低结论强度。',
    modelParameters: { temperature: 0.3 },
    toolWhitelist: [...DEFAULT_CHAT_TOOL_NAMES],
    defaultKnowledgeBaseIds: ['kb-default'],
    fewShot: [
      {
        user: '请研究一个复杂问题。',
        assistant: '我会先列子问题和证据需求，再组织结论，并单独标注尚未验证的部分。'
      }
    ]
  }
];

// 所有自由文本统一裁剪，防止配置错误把超长提示词或显示字段带进每次模型请求。
function cleanString(value, fallback = '', limit = 2000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, limit)
    : fallback;
}

/**
 * 把某个内置角色与外部 override 合并成完整、安全的 preset。
 *
 * 不变量：id 始终来自内置定义；temperature/topP/maxTokens 均有硬边界；工具名必须
 * 属于 ToolSpec 的 chat/autonomous 集合；知识库 id 去重限量；few-shot 必须成对且最多四组。
 * 非对象、数组或字段类型不正确的 override 都回退到内置值，而不是污染运行配置。
 */
function normalizePreset(base, override = {}) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    override = {};
  }
  const modelParameters = override.modelParameters && typeof override.modelParameters === 'object'
    ? override.modelParameters
    : {};
  const temperature = Number(modelParameters.temperature ?? override.temperature ?? base.modelParameters.temperature);
  const topP = Number(modelParameters.topP);
  const maxTokens = Number(modelParameters.maxTokens);
  const normalizedParameters = {
    temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : base.modelParameters.temperature
  };
  if (Number.isFinite(topP)) normalizedParameters.topP = Math.max(0, Math.min(1, topP));
  if (Number.isInteger(maxTokens) && maxTokens > 0) normalizedParameters.maxTokens = Math.min(maxTokens, 32_000);

  // 先采用配置请求的列表，再与服务端许可集合求交集；这里限定的是
  // 服务端愿意暴露的能力上限，不是面向用户/租户身份的 ACL 授权。
  const requestedTools = Array.isArray(override.toolWhitelist)
    ? override.toolWhitelist
    : base.toolWhitelist;
  const toolWhitelist = [...new Set(requestedTools
    .filter((name) => typeof name === 'string' && DEFAULT_CHAT_TOOL_NAME_SET.has(name)))]
    .slice(0, DEFAULT_CHAT_TOOL_NAME_SET.size);
  const defaultKnowledgeBaseIds = [...new Set(
    (Array.isArray(override.defaultKnowledgeBaseIds)
      ? override.defaultKnowledgeBaseIds
      : base.defaultKnowledgeBaseIds)
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim().slice(0, 160))
  )].slice(0, 20);
  const rawFewShot = Array.isArray(override.fewShot) ? override.fewShot : base.fewShot;
  const fewShot = rawFewShot
    .filter((example) => example && typeof example === 'object')
    .map((example) => ({
      user: cleanString(example.user, '', 1000),
      assistant: cleanString(example.assistant, '', 2000)
    }))
    .filter((example) => example.user && example.assistant)
    .slice(0, 4);

  return {
    id: base.id,
    name: cleanString(override.name, base.name, 80),
    description: cleanString(override.description, base.description, 240),
    systemPrompt: cleanString(override.systemPrompt, base.systemPrompt, 4000),
    modelParameters: normalizedParameters,
    toolWhitelist,
    defaultKnowledgeBaseIds,
    fewShot
  };
}

export function loadPresets(value) {
  // AGENT_PRESETS_JSON 是可选增强项：单个坏配置不应让服务无法启动。
  let overrides = {};
  try {
    const parsed = value ? JSON.parse(value) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) overrides = parsed;
  } catch {
    overrides = {};
  }
  return BUILT_IN_PRESETS.map((base) => normalizePreset(base, overrides[base.id]));
}

/** 未识别的 presetId 稳定回退到首个内置角色（当前为 general）。 */
export function resolvePreset(presets, id) {
  return presets.find((preset) => preset.id === id) || presets[0];
}

// few-shot 在发送给模型前展开为标准聊天消息，保持 user/assistant 的配对顺序。
export function buildPresetFewShotMessages(preset) {
  return (preset.fewShot || []).flatMap((example) => [
    { role: 'user', content: example.user },
    { role: 'assistant', content: example.assistant }
  ]);
}

/**
 * 解析本轮知识库范围。返回的是去重、裁剪且限量的 id 数组。
 *
 * 这里必须区分“字段缺失”和“显式空数组”：前者表示沿用角色默认范围，后者是用户
 * 主动关闭所有知识库。若用 requestedIds || defaults，会错误地把空范围重新打开。
 */
export function resolvePresetKnowledgeScope(preset, requestedIds) {
  // undefined 表示请求没有提供范围，此时才使用 preset 默认值。
  // 显式 [] 表示用户不选择任何知识库，必须保留空范围。
  const source = Array.isArray(requestedIds)
    ? requestedIds
    : preset.defaultKnowledgeBaseIds || [];
  return [...new Set(source
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim().slice(0, 160)))]
    .slice(0, 20);
}
