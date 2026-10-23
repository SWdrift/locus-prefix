import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readGitSource } from '@locus/deployment-audit';

const execFileAsync = promisify(execFile);

export function gatewayConsumers(inspectGateway) {
  return {
    async overview(directory) {
      const observed = await inspectGateway(directory);
      return { role: observed.role, instanceId: observed.instanceId,
        configurationSource: observed.configuration.source,
        upstream: observed.configuration.effectiveUpstreamUrl };
    },
    async verify(directory) {
      const observed = await inspectGateway(directory);
      if (observed.requestStatus !== 200) {
        throw Object.assign(new Error(`gateway request HTTP ${observed.requestStatus}`), {
          code: 'NOT_READY', observation: observed,
        });
      }
      return { role: observed.role, instanceId: observed.instanceId, requestStatus: observed.requestStatus };
    },
  };
}

export async function inspectSource(directory) {
  const source = join(directory, 'lab', 'source');
  const git = await readGitSource(source);
  await execFileAsync(process.execPath, ['--check', join(source, 'worker.mjs')], {
    timeout: 15000, windowsHide: true,
  });
  return { ...git, syntax: 'valid' };
}
