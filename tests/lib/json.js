// Stable demo utility: every persistence experiment crosses a JSON boundary.
export function jsonRoundtrip(value) {
  return JSON.parse(JSON.stringify(value));
}
