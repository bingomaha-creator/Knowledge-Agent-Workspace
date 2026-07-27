/**
 * Agent 可观测性的纯计算工具。
 *
 * 这里统一不同 OpenAI-compatible 服务的 usage 字段、从环境配置解析价格并估算
 * 单次调用成本，同时定义模型请求的最小重试边界。它不读写 run 数据库，也不执行
 * 重试；调用者仍需为每次 attempt 建立 span，并决定最终 run 状态。
 */

/**
 * 将 prompt/completion 与 input/output 两套常见字段归一化。
 * 模型没返回 usage、返回字符串数字或返回负值时均安全收敛为非负数。
 */
export function normalizeUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return { inputTokens: Math.max(0, inputTokens), outputTokens: Math.max(0, outputTokens) };
}

/**
 * 解析类似 { "model": { "inputPerMillion": 1, "outputPerMillion": 2 } } 的
 * 价格表。环境变量属于不可信输入，格式错误时返回空表，让成本显示 0 而不中断回答。
 */
export function parsePricing(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 按“每一百万 token”的输入/输出单价估算成本。找不到当前模型价格时明确返回 0；
 * 这是可观测性降级值，不表示模型真的免费。返回值保留八位小数。
 */
export function estimateCost(model, usage, pricing) {
  const rates = pricing?.[model];
  if (!rates) return 0;
  const normalized = normalizeUsage(usage);
  const input = Number(rates.inputPerMillion ?? rates.input ?? 0) || 0;
  const output = Number(rates.outputPerMillion ?? rates.output ?? 0) || 0;
  return Number(((normalized.inputTokens * input + normalized.outputTokens * output) / 1_000_000).toFixed(8));
}

/**
 * 只允许瞬时基础设施错误进入重试：网络、限流、上游 5xx/超时有机会自行恢复；
 * 参数错误、鉴权失败等确定性错误不应重试，以免增加延迟和费用。
 */
export function shouldRetryModelError(error) {
  return new Set(['NETWORK_UNREACHABLE', 'RATE_LIMITED', 'QWEN_HTTP_ERROR', 'UPSTREAM_TIMEOUT'])
    .has(error?.code);
}
