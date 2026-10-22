import { assessRelease } from './assessment.js';
import { observeRelease } from './observation.js';

export function createDeploymentTasks() {
  return [{
    name: 'deployment.audit',
    description: '核对期望发布、制品见证及当前运行版本；缺少证据不判定为一致，不执行部署。',
    input: {
      description: 'expected={release,sourceRevision}，metadataUrl；可选 artifact 和 payloadUrl。制品见证必须独立采集，不能从期望值复制。',
      example: {
        expected: { release: 'release-a', sourceRevision: 'a'.repeat(40) },
        metadataUrl: 'https://service-a.example.invalid/_release.json',
      },
    },
    permissions: ['deployment:inspect'],
    effects: ['network:read'],
    validate(input) {
      if (!input || typeof input.expected?.release !== 'string' || !input.expected.release ||
          typeof input.expected?.sourceRevision !== 'string' || !input.expected.sourceRevision) {
        throw new Error('expected.release and expected.sourceRevision are required.');
      }
      for (const key of ['metadataUrl', 'payloadUrl']) {
        if (key === 'payloadUrl' && input[key] === undefined) continue;
        const url = new URL(input[key]);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
          throw new Error(`${key} must be an HTTP(S) URL without credentials.`);
        }
      }
    },
    async run(input, context) {
      const observation = await context.step('observe-runtime', () => observeRelease({
        metadataUrl: input.metadataUrl,
        payloadUrl: input.payloadUrl,
      }));
      return {
        assessment: assessRelease({
          expected: input.expected,
          artifact: input.artifact,
          runtime: observation.runtime,
        }),
        observation,
      };
    },
  }];
}
