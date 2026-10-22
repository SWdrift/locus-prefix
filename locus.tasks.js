import { createWorkspaceTasks } from '@locus/workspace';

// Explicit composition of trusted modules; no resource scan or plugin lifecycle.
export default ({ root }) => createWorkspaceTasks({ root });
