import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function createMcpSessionManager({
  clientInfo,
  transportOptions,
  createClient = (info) => new McpClient(info),
  createTransport = (options) => new StdioClientTransport(options),
  logger = console
}) {
  let sessionPromise = null;
  let generation = 0;

  function getSession() {
    if (sessionPromise) return sessionPromise;

    const sessionGeneration = ++generation;
    const pending = (async () => {
      const client = createClient(clientInfo);
      const transport = createTransport(transportOptions);

      transport.onclose = () => {
        if (sessionGeneration === generation) {
          sessionPromise = null;
        }
        logger.error?.('[mcp-server] connection closed; the next request will reconnect');
      };
      transport.onerror = (error) => {
        logger.error?.(`[mcp-server] transport error: ${error.message}`);
      };

      if (transport.stderr?.on) {
        transport.stderr.on('data', (chunk) => {
          const message = chunk.toString().trim();
          if (message) logger.error?.(`[mcp-server] ${message}`);
        });
      }

      await client.connect(transport);

      return {
        client,
        transport,
        async close() {
          if (sessionGeneration === generation) {
            sessionPromise = null;
          }
          await client.close().catch(() => {});
          await transport.close().catch(() => {});
        }
      };
    })();

    sessionPromise = pending.catch((error) => {
      if (sessionGeneration === generation) {
        sessionPromise = null;
      }
      throw error;
    });
    return sessionPromise;
  }

  async function close() {
    const pending = sessionPromise;
    sessionPromise = null;
    if (!pending) return;
    const session = await pending.catch(() => null);
    await session?.close();
  }

  return { getSession, close };
}
