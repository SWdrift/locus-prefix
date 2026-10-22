import { runOperationsScenario } from '../tests/11-operations-loop/scenario.js';

const result = await runOperationsScenario({ keepArtifacts: true });
console.log(JSON.stringify(result.summary, null, 2));
if (!result.summary.repaired || !result.summary.knowledgeReused ||
    !result.summary.knowledgeSurvivedGitCheckout || !result.summary.resourcesStopped) process.exitCode = 1;
