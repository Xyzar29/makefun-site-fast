// Driver for the makefun-site entry: the harness runs `node /bot/main.ts` on
// Node 22. It reads every case from the input directory, answers each one
// alone with run() from solve.js, and writes the answers array to the output
// directory as answers.json. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Turn V8's incremental marking off before solve.js is imported, so all of
// its work runs under the same setting the house baseline runs with.
setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));

const answersPath = join(outDir, 'answers.json');
writeFileSync(answersPath, JSON.stringify(answers));
// The grader collects the outputs as another user, so leave the file
// readable by everyone whatever the process umask is.
chmodSync(answersPath, 0o644);
