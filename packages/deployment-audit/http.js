import { createHash } from 'node:crypto';

/**
 * 部署验收：有限、只读、不猜语义的 HTTP 证据采集。
 *
 * 只做一次原生 fetch GET，redirect: 'manual'，不重试、不绕过 TLS、不跟随跳转。
 * 超时覆盖响应头与响应体阶段；maxBytes 限制保留的响应体字节数。
 * 返回值只记录传输层观察：status 为 null 表示未拿到响应头；complete 只表示
 * 响应体是否完整读完，不表示 HTTP 成功；语义判定（如 200 的 SPA/HTML 回退）
 * 由领域编排负责。
 *
 * @param {string} url 绝对 http(s) URL
 * @param {{timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{
 *   url: string,
 *   observedAt: string,
 *   status: number|null,
 *   contentType: string|null,
 *   body: string,
 *   complete: boolean,
 *   sha256: string|null,
 *   error: null|{kind: string, message: string},
 *   elapsedMs: number,
 * }>}
 */
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 262144;

export async function readHttp(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : DEFAULT_MAX_BYTES;

  const startedAt = Date.now();
  const evidence = {
    url: String(url),
    observedAt: new Date(startedAt).toISOString(),
    status: null,
    contentType: null,
    body: '',
    complete: false,
    sha256: null,
    error: null,
    elapsedMs: 0,
  };

  let target;
  try {
    target = new URL(evidence.url);
  } catch {
    return rejected(evidence, startedAt, 'invalid-url', 'url is not an absolute URL');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return rejected(evidence, startedAt, 'invalid-url', `unsupported protocol: ${target.protocol}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response;
    try {
      response = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      return rejected(
        evidence,
        startedAt,
        timedOut ? 'timeout' : 'network',
        timedOut ? `no response within ${timeoutMs}ms` : errorText(error),
      );
    }

    evidence.status = response.status;
    evidence.contentType = response.headers.get('content-type');
    const hash = createHash('sha256');

    if (response.body === null) {
      evidence.complete = true;
      evidence.sha256 = hash.digest('hex');
      return evidence;
    }

    const decoder = new TextDecoder('utf-8');
    const reader = response.body.getReader();
    let received = 0;
    let capped = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxBytes - received;
        if (value.byteLength > remaining) {
          if (remaining > 0) {
            const kept = value.subarray(0, remaining);
            evidence.body += decoder.decode(kept, { stream: true });
            received += kept.byteLength;
          }
          capped = true;
          break;
        }
        hash.update(value);
        evidence.body += decoder.decode(value, { stream: true });
        received += value.byteLength;
      }
    } catch (error) {
      evidence.body += decoder.decode();
      evidence.error = timedOut
        ? { kind: 'timeout', message: `response body did not finish within ${timeoutMs}ms` }
        : { kind: 'body', message: errorText(error) };
      await reader.cancel().catch(() => {});
      return evidence;
    }

    evidence.body += decoder.decode();
    if (capped) {
      evidence.error = {
        kind: 'truncated',
        message: `body exceeded maxBytes (${maxBytes}); kept ${received} bytes`,
      };
      await reader.cancel().catch(() => {});
    } else {
      evidence.complete = true;
      evidence.sha256 = hash.digest('hex');
    }
    return evidence;
  } finally {
    clearTimeout(timer);
    evidence.elapsedMs = Date.now() - startedAt;
  }
}

function rejected(evidence, startedAt, kind, message) {
  evidence.error = { kind, message };
  evidence.elapsedMs = Date.now() - startedAt;
  return evidence;
}

function errorText(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
