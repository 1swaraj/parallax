// Rebuild the fixed proxy artifact. Requires network access to fetch this pinned solc compiler.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const path = 'packages/protocol/src/router/InstanceSponsorRouter.sol';
const input = {
  language: 'Solidity',
  sources: { [path]: { content: readFileSync(path, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const output = execFileSync('pnpm', ['dlx', 'solc@0.8.28', '--standard-json'], {
  input: JSON.stringify(input),
  encoding: 'utf8',
  maxBuffer: 1024 * 1024,
});
const result = JSON.parse(output.slice(output.indexOf('{')));
if (result.errors?.some((e) => e.severity === 'error'))
  throw new Error(JSON.stringify(result.errors));
const contract = result.contracts[path].InstanceSponsorRouter;
writeFileSync(
  'packages/protocol/src/router/artifact.json',
  JSON.stringify(
    {
      compiler: 'solc 0.8.28',
      evmVersion: 'cancun',
      optimizerRuns: 200,
      bytecode: `0x${contract.evm.bytecode.object}`,
    },
    null,
    2
  ) + '\n'
);
