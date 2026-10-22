import { runSourceBindingScenario } from '../tests/10-source-binding/scenario.js';

const result = await runSourceBindingScenario();
console.log(JSON.stringify(result, null, 2));
if (result.wrong?.assessment?.verdict !== 'mismatch' ||
    result.corrected?.assessment?.verdict !== 'consistent') {
  process.exitCode = 1;
}
