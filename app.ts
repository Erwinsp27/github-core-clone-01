// app.ts — the forge's HTTP server: a health probe, the GraphQL and MCP
// endpoints, REST v3, and git smart HTTP. Routing order matters: the git pattern
// (/{owner}/{repo}.git/...) is checked last, so it can never shadow an API route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createCtx, sendJson, sendError, pathOf } from './src/util.ts';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const ctx = createCtx();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, ctx, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          await handleGraphQL(req, res, ctx);
          return;
        }

        if (path === '/mcp') {
          await handleMcp(req, res, ctx);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await handleRest(req, res, ctx);
          return;
        }

        if (await handleGit(req, res, ctx)) return;

        // Everything else, every method: GitHub's 404 body.
        sendError(res, ctx, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, ctx, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          try {
            res.end();
          } catch {
            // The response is already gone; nothing left to do.
          }
        }
      }
    })().catch((err: unknown) => {
      process.stderr.write(`[entry] unhandled request error: ${err instanceof Error ? err.message : String(err)}\n`);
      try {
        if (!res.headersSent) sendError(res, ctx, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // Ignore: the socket is already gone.
      }
    });
  });
}
