/**
 * CLI for the Orbit LLM eval harness.
 *
 * Separate from `harness.mjs` on purpose. The harness imports the engine's
 * TypeScript sources, so it must be run through a loader — and under a loader
 * `process.argv[1]` is the loader's own entry, not this file, which makes the
 * usual "am I the entry module?" check silently report false. A dedicated CLI
 * file has no such ambiguity: importing it runs it, which is exactly what a
 * command is supposed to do.
 *
 * Usage:
 *   npx vite-node llm/eval/run.mjs -- --provider mock
 *   npx vite-node llm/eval/run.mjs -- --provider anthropic --attempts 3
 *   npx vite-node llm/eval/run.mjs -- --provider mock --json
 */
import { anthropicProvider, mockProvider, runEval } from './harness.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const providerName = flag('provider', 'mock');
const provider = providerName === 'mock' ? mockProvider() : anthropicProvider();

const summary = await runEval({
  provider,
  maxRepairs: Number(flag('attempts', '2')),
  only: flag('task', undefined),
});

if (argv.includes('--json')) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  const pct = (n) => `${(n * 100).toFixed(0)}%`;
  process.stdout.write(`\nprovider: ${summary.provider}\n\n`);
  for (const r of summary.results) {
    const mark = r.passed ? (r.firstTry ? 'PASS' : 'PASS*') : 'FAIL';
    process.stdout.write(`  ${mark.padEnd(6)} ${r.id.padEnd(20)} ${r.attempts} attempt(s)\n`);
    if (!r.passed && r.failure) {
      process.stdout.write(`         ${r.failure.split('\n')[0]}\n`);
    }
  }
  process.stdout.write(
    `\n  first try:    ${summary.firstTry}/${summary.total} (${pct(summary.firstTryRate)})\n` +
      `  after repair: ${summary.passed}/${summary.total} (${pct(summary.passRate)})\n` +
      `  * = needed the compiler's diagnostics to get there\n\n`,
  );
}

process.exitCode = summary.passed === summary.total ? 0 : 1;
