import { createWorkspaceTasks } from '@locus/workspace';
import { createDeploymentTasks } from '@locus/deployment-audit';

// Explicit composition of trusted modules; no resource scan or plugin lifecycle.
export default ({ root }) => [
  ...createWorkspaceTasks({ root }),
  ...createDeploymentTasks(),
];
