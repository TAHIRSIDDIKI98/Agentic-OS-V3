import type { Context } from "hono";
import { env } from "./env.js";

/**
 * Create payload limit middleware Hono.
 * @param maxBytes Maximum payload size in bytes (default from env)
 * @returns Hono middleware function
 */
export function createPayloadLimitMiddleware(maxBytes?: number) {
  const limit = maxBytes ?? (Number(env.NEXUS_MAX_BODY_BYTES) || 5 * 1024 * 1024);
  
  return async function payloadLimit(c: Context, next: () => Promise<void>): Promise<Response | void> {
    const contentLength = c.req.header('content-length');
    if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > limit) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: `Payload too large. Maximum size allowed is ${limit} bytes.`,
          },
        },
        413,
      );
    }

    const reader = c.req.raw.clone().body?.getReader();
    if (reader) {
      let bytesRead = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesRead += value.length;
          if (bytesRead > limit) {
            // Cancellation on a cloned Fetch body can wait for the unconsumed
            // sibling branch forever (ReadableStream.tee semantics). Begin
            // cancellation without blocking the 413 response.
            void reader.cancel().catch(() => {});
            return c.json(
              {
                ok: false,
                error: {
                  code: 'PAYLOAD_TOO_LARGE',
                  message: `Payload too large. Maximum size allowed is ${limit} bytes.`,
                },
              },
              413
            );
          }
        }
      } catch {
        // ignore
      }
    }
    return await next();
  };
}
