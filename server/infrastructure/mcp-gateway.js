export function normalizeStructuredContent(result) {
  if (
    result &&
    typeof result === 'object' &&
    'structuredContent' in result &&
    result.structuredContent
  ) {
    return result.structuredContent;
  }
  if (result && typeof result === 'object' && 'toolResult' in result) {
    return result.toolResult;
  }
  return {};
}

export function contentToText(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
    return '';
  }
  return result.content
    .filter((item) => item && typeof item === 'object' && item.type === 'text')
    .map((item) => item.text || '')
    .join('\n')
    .trim();
}

function createToolError(structured, fallbackMessage, fallbackStatus) {
  const error = new Error(structured.message || fallbackMessage);
  error.code = structured.code || 'MCP_TOOL_ERROR';
  error.details = structured.details || '';
  error.status = Number(structured.status) || fallbackStatus;
  return error;
}

function requestOptions({ signal, timeout } = {}) {
  return {
    ...(signal ? { signal } : {}),
    ...(timeout !== undefined ? { timeout } : {})
  };
}

export function createMcpGateway({ sessionManager }) {
  const gateway = {
    connect() {
      return sessionManager.getSession();
    },

    async listTools(options = {}) {
      const session = await sessionManager.getSession();
      const sdkOptions = requestOptions(options);
      return Object.keys(sdkOptions).length
        ? session.client.listTools(undefined, sdkOptions)
        : session.client.listTools();
    },

    async callTool(name, args = {}, options = {}) {
      const session = await sessionManager.getSession();
      const sdkOptions = requestOptions(options);
      const raw = Object.keys(sdkOptions).length
        ? await session.client.callTool(
            { name, arguments: args },
            undefined,
            sdkOptions
          )
        : await session.client.callTool({ name, arguments: args });
      return {
        raw,
        structured: normalizeStructuredContent(raw),
        text: contentToText(raw),
        isError: raw?.isError === true
      };
    },

    async callToolOrThrow(name, args = {}, options = {}) {
      const result = await gateway.callTool(name, args, options);
      if (result.isError) {
        throw createToolError(
          result.structured,
          options.fallbackMessage || 'MCP 工具调用失败',
          options.fallbackStatus || 400
        );
      }
      return result;
    },

    close() {
      return sessionManager.close();
    }
  };
  return gateway;
}
