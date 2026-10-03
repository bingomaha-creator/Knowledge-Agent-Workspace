export function encodeChatEvent(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}
