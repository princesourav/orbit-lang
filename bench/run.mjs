/**
 * CLI for the Orbit benchmark harness.
 *
 * Separate from bench.mjs for the same reason the eval CLI is separate: the
 * harness imports TypeScript sources and runs under a loader, where an
 * "am I the entry module?" check cannot distinguish itself from the loader.
 *
 * Usage:
 *   npx vite-node bench/run.mjs -- [--iterations N] [--json]
 */
import { runBench } from './bench.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const summary = runBench({ iterations: Number(flag('iterations', '500')) });

if (argv.includes('--json')) {
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
} else {
  const ms = (n) => `${n.toFixed(3)} ms`;
  process.stdout.write(
    `\nOrbit benchmark — ${summary.scenario}\n` +
      `  output      ${summary.outputBytes.toLocaleString()} bytes\n` +
      `  runtime     ${summary.runtime}\n` +
      `  platform    ${summary.platform}\n` +
      `  cpu         ${summary.cpu}\n\n` +
      `  ${'operation'.padEnd(28)}${'median'.padStart(11)}${'p95'.padStart(11)}${'p99'.padStart(11)}\n`,
  );
  for (const r of summary.results) {
    process.stdout.write(
      `  ${r.label.padEnd(28)}${ms(r.medianMs).padStart(11)}${ms(r.p95Ms).padStart(11)}${ms(r.p99Ms).padStart(11)}\n`,
    );
  }
  process.stdout.write(
    '\n  One scenario, one engine, no cross-engine comparison. See bench/README.md\n' +
      '  for why, and for what this number does and does not license you to claim.\n\n',
  );
}
