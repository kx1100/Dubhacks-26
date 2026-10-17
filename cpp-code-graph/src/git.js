'use strict';

// Reads C/C++ sources at a given git revision (or the working tree) so two
// graphs can be built and compared. Uses the git CLI; no extra dependencies.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKTREE = 'WORKTREE';
const SOURCE_RE = /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i;

function git(args, cwd, opts) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 512, encoding: (opts && opts.encoding) || 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.message = (stderr && stderr.toString()) || err.message;
        reject(err);
      } else resolve(stdout);
    });
  });
}

async function repoRoot(cwd) {
  const out = await git(['rev-parse', '--show-toplevel'], cwd);
  return path.normalize(out.trim());
}

async function listCommits(root, max) {
  const out = await git(['log', '-n', String(max || 200), '--date=relative', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ad'], root);
  return out
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [hash, short, subject, author, date] = l.split('\x1f');
      return { hash, short, subject, author, date };
    });
}

async function changedFiles(root, base, target) {
  const args = target === WORKTREE ? ['diff', '--name-only', '-z', base] : ['diff', '--name-only', '-z', base, target];
  const out = await git(args, root);
  return out.split('\0').filter(p => p && SOURCE_RE.test(p));
}

/** Converts the codeGraph.exclude glob into a list of excluded folder-name patterns. */
function excludedDirMatcher(excludeGlob) {
  const names = [];
  const m = /\{([^}]*)\}/.exec(excludeGlob || '');
  if (m) names.push(...m[1].split(','));
  else if (excludeGlob) {
    const single = /\*\*\/([^/*{}]+)\/\*\*/.exec(excludeGlob);
    if (single) names.push(single[1]);
  }
  const res = names.map(n => new RegExp('^' + n.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
  return p => p.split('/').slice(0, -1).some(seg => res.some(r => r.test(seg)));
}

function catFileBatch(root, specs) {
  // Streams "rev:path" specs into `git cat-file --batch` and parses the binary output.
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true });
    const chunks = [];
    proc.stdout.on('data', d => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error('git cat-file exited with ' + code));
      const buf = Buffer.concat(chunks);
      const results = [];
      let off = 0;
      for (let i = 0; i < specs.length && off < buf.length; i++) {
        const nl = buf.indexOf(10, off);
        if (nl < 0) break;
        const header = buf.slice(off, nl).toString();
        off = nl + 1;
        const parts = header.split(' ');
        if (parts[1] === 'missing' || parts.length < 3) {
          results.push(null);
          continue;
        }
        const size = parseInt(parts[2], 10);
        results.push(buf.slice(off, off + size).toString('utf8'));
        off += size + 1;
      }
      resolve(results);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(specs.map(s => s + '\n').join(''));
  });
}

/**
 * Returns [{path, text}] of C/C++ sources at `rev` (paths relative to the repo root).
 */
async function readRevision(root, rev, excludeGlob, maxFiles) {
  const isExcluded = excludedDirMatcher(excludeGlob);
  let paths;
  if (rev === WORKTREE) {
    const out = await git(['ls-files', '-co', '--exclude-standard', '-z'], root);
    paths = out.split('\0');
  } else {
    const out = await git(['ls-tree', '-r', '-z', '--name-only', rev], root);
    paths = out.split('\0');
  }
  paths = paths.filter(p => p && SOURCE_RE.test(p) && !isExcluded(p)).sort();
  if (maxFiles && paths.length > maxFiles) paths.length = maxFiles;

  if (rev === WORKTREE) {
    const sources = [];
    for (const p of paths) {
      try {
        sources.push({ path: p, text: fs.readFileSync(path.join(root, p), 'utf8') });
      } catch {
        // deleted but still in the index
      }
    }
    return sources;
  }
  const texts = await catFileBatch(root, paths.map(p => rev + ':' + p));
  const sources = [];
  paths.forEach((p, i) => {
    if (texts[i] != null) sources.push({ path: p, text: texts[i] });
  });
  return sources;
}

async function showFile(root, rev, relPath) {
  return git(['show', rev + ':' + relPath], root);
}

module.exports = { WORKTREE, repoRoot, listCommits, readRevision, showFile, changedFiles };
