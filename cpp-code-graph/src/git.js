'use strict';

// Reads C/C++ sources at a git revision (or the working tree), so two graphs
// can be built and compared. Uses the git CLI; no extra dependencies.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/** The revision name for the working tree (uncommitted files included). */
const WORKTREE = 'WORKTREE';
const SOURCE_RE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i;

/** @typedef {{path: string, text: string}} Source */
/** @typedef {{hash: string, short: string, subject: string, author: string, date: string}} Commit */

/** Runs git and resolves with its output; on failure the error message is git's stderr. */
function git(/** @type {string[]} */ args, /** @type {string} */ cwd) {
  return /** @type {Promise<string>} */ (
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 512 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (stderr) err.message = stderr.trim();
        reject(err);
      });
    })
  );
}

/** The top folder of the repository that contains `cwd`. */
async function repoRoot(/** @type {string} */ cwd) {
  return path.normalize((await git(['rev-parse', '--show-toplevel'], cwd)).trim());
}

/** The latest `max` commits, newest first. */
async function listCommits(/** @type {string} */ root, max = 200) {
  const out = await git(['log', '-n', String(max), '--date=relative', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad'], root);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, subject, author, date] = line.split('\x1f');
      return /** @type {Commit} */ ({ hash, short, subject, author, date });
    });
}

/**
 * A test for paths inside an excluded folder, from the codeGraph.exclude glob.
 * Only the folder-name form of that setting is understood, which is what its
 * default uses: `**\/{build,out,cmake-build-*}/**` or `**\/build/**`.
 */
function excludedFolders(/** @type {string | undefined} */ glob) {
  const m = /\*\*\/(?:\{([^}]*)\}|([^/*{}]+))\/\*\*/.exec(glob || '');
  const names = m ? (m[1] ?? m[2]).split(',') : [];
  const patterns = names.map((n) => new RegExp('^' + n.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  return (/** @type {string} */ p) => p.split('/').slice(0, -1).some((dir) => patterns.some((r) => r.test(dir)));
}

/** The text of each "rev:path" spec, or null where git has no such file, read in one `git cat-file --batch`. */
function catFiles(/** @type {string} */ root, /** @type {string[]} */ specs) {
  return /** @type {Promise<Array<string | null>>} */ (
    new Promise((resolve, reject) => {
      const proc = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true });
      /** @type {Buffer[]} */
      const chunks = [];
      proc.stdout.on('data', (d) => chunks.push(d));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`git cat-file exited with ${code}`));
        // Each answer is "<sha> <type> <size>\n<content>\n", or "<spec> missing\n".
        const buf = Buffer.concat(chunks);
        let at = 0;
        resolve(
          specs.map(() => {
            const nl = buf.indexOf(10, at);
            if (nl < 0) return null;
            const [, type, size] = buf.subarray(at, nl).toString().split(' ');
            at = nl + 1;
            if (type === 'missing' || size === undefined) return null;
            const text = buf.subarray(at, at + Number(size)).toString('utf8');
            at += Number(size) + 1;
            return text;
          }),
        );
      });
      proc.stdin.on('error', () => {}); // git exits early on a bad revision; 'close' reports it
      proc.stdin.end(specs.map((s) => s + '\n').join(''));
    })
  );
}

/** The C/C++ sources at `rev`, or in the working tree for WORKTREE, with paths relative to the repo root. */
async function readRevision(/** @type {string} */ root, /** @type {string} */ rev, /** @type {string | undefined} */ exclude, /** @type {number | undefined} */ maxFiles) {
  const list = rev === WORKTREE ? ['ls-files', '-co', '--exclude-standard', '-z'] : ['ls-tree', '-r', '-z', '--name-only', rev];
  const excluded = excludedFolders(exclude);
  const paths = (await git(list, root))
    .split('\0')
    .filter((p) => p && SOURCE_RE.test(p) && !excluded(p))
    .sort()
    .slice(0, maxFiles || undefined);

  const texts =
    rev === WORKTREE
      ? paths.map((p) => {
          try {
            return fs.readFileSync(path.join(root, p), 'utf8');
          } catch {
            return null; // deleted, but still in the index
          }
        })
      : await catFiles(root, paths.map((p) => `${rev}:${p}`));
  /** @type {Source[]} */
  const sources = [];
  paths.forEach((p, i) => {
    const text = texts[i];
    if (text != null) sources.push({ path: p, text });
  });
  return sources;
}

/** One file's text at `rev`. */
function showFile(/** @type {string} */ root, /** @type {string} */ rev, /** @type {string} */ relPath) {
  return git(['show', `${rev}:${relPath}`], root);
}

module.exports = { WORKTREE, repoRoot, listCommits, readRevision, showFile };