export function toTextContent(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

export function toErrorContent(error) {
  return {
    content: [{
      type: 'text',
      text: error.details ? `${error.message}\n${error.details}` : error.message
    }],
    structuredContent: {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message,
      details: error.details || '',
      status: error.status || 500
    },
    isError: true
  };
}

export function withToolErrors(handler) {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return toErrorContent(error);
    }
  };
}
