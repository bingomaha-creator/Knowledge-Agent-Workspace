export function appendToolPlanningChoice(messages, choice, toolCalls) {
  if (!toolCalls.length) {
    return false;
  }

  messages.push({
    role: 'assistant',
    content: choice?.content || '',
    tool_calls: toolCalls
  });

  return true;
}

export function getLatestUserContent(messages) {
  return [...messages].reverse().find((message) => message?.role === 'user' && message.content?.trim())?.content.trim() || '';
}

export function shouldAutoRetrieveKnowledge({ ragEnabled, hasKnowledge, query }) {
  return Boolean(ragEnabled && hasKnowledge && query?.trim());
}

export function createAutoRetrieveToolCall(query) {
  return {
    id: 'auto-retrieve-knowledge',
    type: 'function',
    function: {
      name: 'retrieve_knowledge',
      arguments: JSON.stringify({
        query,
        topK: 4
      })
    }
  };
}
