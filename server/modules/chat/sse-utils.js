/**
 * 从“可能只包含半个事件”的文本缓冲区中排出完整 SSE data payload。
 * 网络 ReadableStream 的 chunk 大小由传输层决定，不能假设一次 read 对应一次 SSE 事件。
 * 返回 remainder 让调用方拼到下一块；流真正 EOF 时传 flush=true，连末尾没有空行的
 * 最后一个事件也会被处理。多行 data 先用换行连接，再为本项目的 JSON/[DONE]
 * payload 执行 trim；因此这是项目协议解析器，不是会保留任意文本首尾空白的通用 SSE 实现。
 */
export function drainSseData(buffer, { flush = false } = {}) {
  const blocks = String(buffer || '').split(/\r?\n\r?\n/);
  const remainder = flush ? '' : (blocks.pop() || '');
  const completeBlocks = flush ? blocks : blocks;
  const data = [];

  for (const block of completeBlocks) {
    const lines = block.split(/\r?\n/);
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length) data.push(dataLines.join('\n').trim());
  }

  return { data, remainder };
}
