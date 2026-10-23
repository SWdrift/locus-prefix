import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Domain boundary: inspect this gateway, not a general object/operation runtime.
export async function inspectGateway(directory) {
  const service = JSON.parse(await readFile(join(directory, 'service.json'), 'utf8'));
  const diagnosticsResponse = await fetch(`${service.baseUrl}/diagnostics`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!diagnosticsResponse.ok) throw new Error(`diagnostics HTTP ${diagnosticsResponse.status}`);
  const diagnostics = await diagnosticsResponse.json();
  if (diagnostics.role !== service.role || typeof diagnostics.instanceId !== 'string' || !diagnostics.instanceId) {
    throw Object.assign(new Error('gateway identity does not match the requested role'), {
      code: 'WRONG_TARGET', expected: service.role, observed: diagnostics.role,
    });
  }
  const check = await fetch(`${service.baseUrl}/check`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  await check.arrayBuffer();
  return { ...diagnostics, requestStatus: check.status };
}
