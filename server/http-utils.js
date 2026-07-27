// Express/API 边界共享的小型转换函数。这里不创建 Store、Worker、MCP 或网络客户端，
// 因而 route factory 可以在测试里只注入它真正需要的外部依赖。
export function createAppError(code, message, details = '', status = 500) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.status = status;
  return error;
}

export function getErrorPayload(error, fallbackMessage) {
  if (error && typeof error === 'object' && 'message' in error) {
    return {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || fallbackMessage,
      details: error.details || '',
      status: error.status || 500
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: fallbackMessage,
    details: '',
    status: 500
  };
}

export function queryList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function createRouteMcpCaller({ toolExecutor, caller = 'internal' }) {
  return async function callMcpTool(name, args = {}, options = {}) {
    // caller 在组合根构造 route 时固定，绝不从 body/query/tool arguments 推导。
    const context = { caller, invocation: 'explicit' };
    const result = options.requireSuccess === false
      ? await toolExecutor.callTool(name, args, context, options)
      : await toolExecutor.callToolOrThrow(name, args, context, options);
    return result.structured;
  };
}
