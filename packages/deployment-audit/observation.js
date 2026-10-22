import { readHttp } from './http.js';

// Metadata and payload are separate observations, not an atomic snapshot.
export async function observeRelease({ metadataUrl, payloadUrl, timeoutMs = 8000, maxBytes = 1048576 }) {
  const metadata = await readHttp(metadataUrl, { timeoutMs, maxBytes });
  const observation = { metadata, runtime: null, payload: null };
  if (!metadata.complete || metadata.error || metadata.status !== 200) return observation;
  let value;
  try {
    value = JSON.parse(metadata.body);
  } catch {
    observation.interpretationError = 'Release metadata was not JSON.';
    return observation;
  }
  if (typeof value?.release !== 'string' || !value.release ||
      typeof value?.sourceRevision !== 'string' || !value.sourceRevision) {
    observation.interpretationError = 'Release metadata requires release and sourceRevision.';
    return observation;
  }
  observation.runtime = { release: value.release, sourceRevision: value.sourceRevision };
  if (payloadUrl !== undefined) {
    observation.payload = await readHttp(payloadUrl, { timeoutMs, maxBytes });
    if (observation.payload.complete && !observation.payload.error && observation.payload.status === 200) {
      observation.runtime.payloadSha256 = observation.payload.sha256;
    }
  }
  return observation;
}
