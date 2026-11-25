// Sizzle Station — the entrypoint that hands the game to the make.fun scorer.
//
// What it does, in plain terms: it takes the playable game in this repo's
// game/ folder plus the screenshots/ renders, lays them out in a fresh output
// directory, and asks the vendored make.fun library to summarise that layout
// as dossier.json, the file the judge reads first. Nothing here fetches
// anything from the network and nothing here needs a package install: the
// Node standard library is all it imports, apart from the vendored library.
//
// Run it outside the grader's container with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Inside the grader the output directory is /output, which is the default
// when MAKEFUN_OUTPUT_DIR is unset.
//
// Safety note on the output directory: the program empties the *contents* of
// the output directory and never removes the directory itself, so a mounted
// /output stays mounted and only stale files from an earlier run disappear.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The folder this file lives in: game/ and screenshots/ sit beside it.
const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

// The scorer's caps, taken from the bounty's gate: at most 163,840 bytes of
// source text in the dossier, at most 4 screenshots of 256 KiB each, and a
// game tree of at most 993 entries totalling 48 MiB, with no path over
// 1,000 bytes. Passing them here makes this program refuse exactly where
// the scorer would refuse, instead of handing in something doomed.
const DOSSIER_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
} as const;

/** The dossier the scorer will read must stay under 1.5 MiB. */
const DOSSIER_MAX_BYTES = 1572864;

/** Where the finished entry goes: the env override, else the grader's /output. */
function pickOutputDir(): string {
  const override = (process.env.MAKEFUN_OUTPUT_DIR ?? '').trim();
  return override === '' ? '/output' : resolve(override);
}

/**
 * Empty a directory without deleting it. Every entry inside is removed
 * (recursively for folders), the directory itself is left standing, so a
 * mount point or a pre-created folder survives the wipe.
 */
function emptyContents(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/** Copy one top-level folder of the repo into the output directory, if present. */
function handOverFolder(name: 'game' | 'screenshots', from: string, to: string): void {
  const source = join(from, name);
  if (!existsSync(source)) {
    if (name === 'game') throw new Error('game/: no such directory beside main.ts');
    return;
  }
  cpSync(source, join(to, name), { recursive: true });
}

function main(): void {
  const out = pickOutputDir();
  // Never wipe the repo itself, the filesystem root, or the user's home:
  // a mistyped MAKEFUN_OUTPUT_DIR must fail loudly instead of deleting work.
  const forbidden = [resolve(REPO_ROOT), '/', process.env.HOME ?? ''].map((p) => resolve(p));
  if (forbidden.includes(resolve(out))) {
    throw new Error(`refusing to use ${out} as the output directory`);
  }
  emptyContents(out);
  handOverFolder('game', REPO_ROOT, out);
  handOverFolder('screenshots', REPO_ROOT, out);
  const dossier = buildDossier(out, DOSSIER_CAPS);
  if (dossier.length > DOSSIER_MAX_BYTES) {
    throw new Error(`dossier.json is ${dossier.length} bytes, over the ${DOSSIER_MAX_BYTES} cap`);
  }
  writeFileSync(join(out, 'dossier.json'), dossier);
  console.log(`entry written to ${out} (dossier.json: ${dossier.length} bytes)`);
}

main();
