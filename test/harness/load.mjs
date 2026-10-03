/**
 * Bundles TypeScript sources in memory and imports the result, so the tests
 * run the real modules under Node without a build step.
 *
 * `obsidian` resolves to a stub unless the caller passes its own module
 * source; the pure modules never import it, the plugin wiring does.
 */
import * as esbuild from 'esbuild';

const here = new URL('.', import.meta.url).pathname;

export async function loadTs(contents, { obsidian = 'export {};', resolveDir = new URL('../..', import.meta.url).pathname } = {}) {
  const build = await esbuild.build({
    stdin: { contents, resolveDir, loader: 'ts' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'mock-obsidian',
        setup(b) {
          b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock' }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: obsidian, loader: 'js', resolveDir: here }));
        },
      },
    ],
  });
  return import('data:text/javascript;base64,' + Buffer.from(build.outputFiles[0].text).toString('base64'));
}

/** The shared assertion helper: compares by JSON and counts what it checked. */
export function checker() {
  let checked = 0;
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label}: got ${a}, expected ${e}`);
    checked++;
  };
  const ok = (value, label) => eq(Boolean(value), true, label);
  return { eq, ok, count: () => checked };
}
