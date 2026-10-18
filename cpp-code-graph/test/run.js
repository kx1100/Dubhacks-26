// Runs the tests with TypeScript sources loadable and the tree-sitter parsers
// ready, so test files can require src/**/*.ts and call buildGraph directly.
//   node test/run.js                 every test, each in its own process
//   node test/run.js test/x.test.js  one test (or any script, e.g. test/dump.js)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const TESTS = ['highlight', 'graphTools', 'agent', 'summaries', 'impact', 'semantic'].map(n => `test/${n}.test.js`).concat(['test/smoke.js', 'test/ui.test.js']);

const script = process.argv[2];
if (!script) {
  let failed = 0;
  const check = (name, args) => {
    const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) {
      failed++;
      console.error(`FAILED: ${name}`);
    }
  };
  for (const t of TESTS) check(t, [__filename, t]);
  // The bundle VS Code loads, with plain node: catches what only breaks after bundling.
  require('../scripts/build-extension').build();
  check('test/smoke.js --bundle', ['test/smoke.js', '--bundle']);
  const total = TESTS.length + 1;
  console.log(failed ? `${failed} of ${total} checks failed` : `all ${total} checks passed`);
  process.exit(failed ? 1 : 0);
}

// Compile .ts on require (type checking is `npm run typecheck`).
const esbuild = require('esbuild');
require.extensions['.ts'] = (module, filename) => {
  const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node18', sourcefile: filename });
  module._compile(code, filename);
};

// The script sees its own arguments at process.argv[2...], as if run with node directly.
process.argv.splice(1, 1);
require('../scripts/build-extension').copyParsers();
require('../src/parser')
  .initParsers({ asAbsolutePath: p => path.join(root, p) })
  .then(() => require(path.resolve(root, script)))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
