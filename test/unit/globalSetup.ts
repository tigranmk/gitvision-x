import { execFileSync } from 'node:child_process';

/** The worker pool tests load the real bundled worker. */
export default function setup() {
  execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
}
