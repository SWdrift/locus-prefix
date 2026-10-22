// Stable fixtures shared by demos. Keep this surface small: demos depend on it.
export function makeMachine(overrides = {}) {
  return {
    id: 'machine:a',
    name: 'worker',
    address: 'direct-address',
    connectionRevision: 1,
    routes: ['direct', 'via-jump'],
    ...overrides,
  };
}

export function makeJump(overrides = {}) {
  return makeMachine({
    id: 'machine:b',
    name: 'jump',
    address: 'jump-address',
    ...overrides,
  });
}
