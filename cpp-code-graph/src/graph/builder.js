'use strict';

// Turns per-file parse results into one graph:
//   nodes: folders, files, namespaces, classes/structs/unions, enums,
//          functions, methods, fields and global variables (with a parent link
//          forming the containment tree used for expand/collapse)
//   edges: includes, calls, inherits, overrides, uses (type dependencies)
//
// Names are resolved heuristically (no compiler), so edges that could point to
// several targets are marked `uncertain`.

const { parseFile, hashString } = require('../parser/cppParser');

const EDGE_SITE_LIMIT = 8;

function dirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}
function basename(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
function normalizePath(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

class GraphBuilder {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.classesByName = new Map(); // short name -> [classNode]
    this.classesByQname = new Map();
    this.methodsByClass = new Map(); // classId -> Map(name -> [fnNode])
    this.fieldsByClass = new Map(); // classId -> Map(fieldName -> typeName)
    this.basesOf = new Map(); // classId -> [classId]
    this.freeByName = new Map(); // name -> [fnNode]
    this.methodsByName = new Map(); // name -> [fnNode]
    this.functionsWithBodies = []; // {node, body, params, ownerClass}
  }

  addNode(n) {
    let id = n.id;
    if (this.nodes.has(id)) {
      let k = 2;
      while (this.nodes.has(id + '#' + k)) k++;
      id = id + '#' + k;
      n.id = id;
    }
    this.nodes.set(id, n);
    return n;
  }

  addEdge(s, t, kind, opts) {
    if (!s || !t || s === t) return;
    const key = s + '\u0001' + t + '\u0001' + kind;
    let e = this.edges.get(key);
    if (!e) {
      e = { s, t, kind, n: 0 };
      if (opts && opts.uncertain) e.uncertain = true;
      this.edges.set(key, e);
    } else if (e.uncertain && !(opts && opts.uncertain)) {
      delete e.uncertain;
    }
    e.n++;
    if (opts && opts.site) {
      if (!e.sites) e.sites = [];
      if (e.sites.length < EDGE_SITE_LIMIT) e.sites.push(opts.site);
    }
  }

  pushMap(map, key, val) {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    arr.push(val);
  }

  // ---- 1. folders and files ----------------------------------------------

  buildTree(files) {
    const dirs = new Set();
    for (const f of files) {
      let d = dirname(f.path);
      while (d) {
        dirs.add(d);
        d = dirname(d);
      }
    }
    // Compress chains of folders that hold exactly one sub-folder and no files.
    const childDirs = new Map();
    const hasFiles = new Set(files.map(f => dirname(f.path)));
    for (const d of dirs) this.pushMap(childDirs, dirname(d), d);
    const dirId = new Map(); // folder path -> node id it maps to ('' = root)
    const visit = (d, parentId, labelPrefix) => {
      const kids = childDirs.get(d) || [];
      if (d && kids.length === 1 && !hasFiles.has(d)) {
        // Merge with the only child.
        dirId.set(d, null);
        visit(kids[0], parentId, labelPrefix + basename(d) + '/');
        // Resolve after child is processed.
        dirId.set(d, dirId.get(kids[0]));
        return;
      }
      let id = parentId;
      if (d) {
        id = 'dir:' + d;
        this.addNode({ id, kind: 'dir', name: labelPrefix + basename(d), parent: parentId, file: d });
      }
      dirId.set(d, id);
      for (const k of kids.sort()) visit(k, id, '');
    };
    visit('', null, '');
    for (const f of files) {
      const parent = dirId.get(dirname(f.path)) || null;
      const name = basename(f.path);
      const isHeader = /\.(h|hh|hpp|hxx|h\+\+|inl|ipp|tpp)$/i.test(name);
      this.addNode({ id: 'file:' + f.path, kind: 'file', name, parent, file: f.path, line: 1, hash: f.hash, header: isHeader });
    }
  }

  // ---- 2. entities ------------------------------------------------------------

  addEntities(f) {
    const fileId = 'file:' + f.path;
    const nodeOf = new Array(f.entities.length);
    const parentNode = idx => (idx >= 0 && nodeOf[idx] ? nodeOf[idx].id : fileId);
    const deferred = [];

    f.entities.forEach((e, idx) => {
      const base = { file: f.path, line: e.line, endLine: e.endLine };
      switch (e.kind) {
        case 'namespace': {
          nodeOf[idx] = this.addNode({ id: 'ns:' + f.path + '#' + e.qname, kind: 'namespace', name: e.name, qname: e.qname, parent: parentNode(e.parent), ...base });
          break;
        }
        case 'class': {
          let id = 'class:' + e.qname;
          if (this.nodes.has(id)) id += '@' + f.path;
          const n = this.addNode({
            id, kind: e.key, name: e.name, qname: e.qname, parent: parentNode(e.parent), access: e.access,
            bases: e.bases, hash: e.headHash, ...base
          });
          nodeOf[idx] = n;
          this.pushMap(this.classesByName, e.name, n);
          if (!this.classesByQname.has(e.qname)) this.classesByQname.set(e.qname, n);
          this.methodsByClass.set(n.id, new Map());
          this.fieldsByClass.set(n.id, new Map());
          break;
        }
        case 'enum': {
          let id = 'enum:' + e.qname;
          if (this.nodes.has(id)) id += '@' + f.path;
          const n = this.addNode({ id, kind: 'enum', name: e.name, qname: e.qname, parent: parentNode(e.parent), values: e.values, hash: e.headHash, ...base });
          nodeOf[idx] = n;
          this.pushMap(this.classesByName, e.name, n);
          if (!this.classesByQname.has(e.qname)) this.classesByQname.set(e.qname, n);
          break;
        }
        case 'field': {
          const owner = nodeOf[e.parent];
          if (!owner) break;
          const n = this.addNode({
            id: 'field:' + owner.id.replace(/^class:/, '') + '::' + e.name, kind: 'field', name: e.name, parent: owner.id,
            signature: e.typeText + ' ' + e.name, access: e.access, isStatic: e.isStatic, typeName: e.typeName, typeIds: e.typeIds, hash: e.hash, ...base
          });
          nodeOf[idx] = n;
          const fm = this.fieldsByClass.get(owner.id);
          if (fm) fm.set(e.name, e.typeName);
          break;
        }
        case 'variable': {
          if (e.isExtern) break;
          const n = this.addNode({
            id: 'var:' + e.qname + '@' + f.path, kind: 'variable', name: e.name, qname: e.qname, parent: parentNode(e.parent),
            signature: e.typeText + ' ' + e.name, typeName: e.typeName, typeIds: e.typeIds, hash: e.hash, ...base
          });
          nodeOf[idx] = n;
          break;
        }
        case 'function': {
          if (e.inClass >= 0) {
            const owner = nodeOf[e.inClass];
            if (!owner) break;
            nodeOf[idx] = this.addMethod(owner, e, f.path);
          } else if (e.qual.length) {
            deferred.push(e);
          } else {
            nodeOf[idx] = this.addFreeFunction(e, f.path, parentNode(e.parent));
          }
          break;
        }
      }
    });
    return deferred;
  }

  addMethod(owner, e, path) {
    const id = 'fn:' + owner.qname + '::' + e.name + '(' + e.sig + ')';
    const n = this.addNode({
      id, kind: 'method', name: e.name, qname: owner.qname + '::' + e.name, parent: owner.id, file: path, line: e.line, endLine: e.endLine,
      signature: e.signature, access: e.access, isVirtual: e.isVirtual, isPure: e.isPure, isStatic: e.isStatic, sig: e.sig,
      hash: e.hash, declOnly: e.isDecl, retTypeName: e.retTypeName
    });
    if (!e.isDecl) {
      n.defFile = path;
      n.defLine = e.line;
    }
    this.registerMethod(owner, n);
    if (e.body) this.functionsWithBodies.push({ node: n, body: e.body, params: e.params, ownerClass: owner.id, nsPath: e.nsPath });
    else n._params = e.params;
    return n;
  }

  registerMethod(owner, n) {
    const mm = this.methodsByClass.get(owner.id);
    if (mm) this.pushMap(mm, n.name, n);
    this.pushMap(this.methodsByName, n.name, n);
  }

  addFreeFunction(e, path, parentId) {
    let id = 'fn:' + e.qname + '(' + e.sig + ')';
    if (e.isStatic || this.nodes.has(id)) id += '@' + path;
    const n = this.addNode({
      id, kind: 'function', name: e.name, qname: e.qname, parent: parentId, file: path, line: e.line, endLine: e.endLine,
      signature: e.signature, isStatic: e.isStatic, sig: e.sig, hash: e.hash, defFile: path, defLine: e.line, retTypeName: e.retTypeName
    });
    this.pushMap(this.freeByName, e.name, n);
    if (e.body) this.functionsWithBodies.push({ node: n, body: e.body, params: e.params, ownerClass: null, nsPath: e.nsPath });
    return n;
  }

  findClass(name, nsPath) {
    // Resolve a (possibly qualified) class name as seen from namespace path nsPath.
    if (!name) return null;
    const ns = nsPath || [];
    for (let i = ns.length; i >= 0; i--) {
      const qn = ns.slice(0, i).concat([name]).join('::');
      const c = this.classesByQname.get(qn);
      if (c) return c;
    }
    const short = name.split('::').pop();
    const cands = this.classesByName.get(short);
    if (!cands || !cands.length) return null;
    if (cands.length === 1) return cands[0];
    const suffix = '::' + name;
    const exact = cands.find(c => c.qname === name || c.qname.endsWith(suffix));
    if (exact) return exact;
    // Prefer the candidate sharing the longest namespace prefix.
    let best = cands[0];
    let bestScore = -1;
    for (const c of cands) {
      const parts = c.qname.split('::');
      let s = 0;
      while (s < ns.length && parts[s] === ns[s]) s++;
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    return best;
  }

  attachOutOfLine(e, path) {
    const owner = this.findClass(e.qual.join('::'), e.nsPath);
    if (!owner || owner.kind === 'enum') {
      // Qualified by a namespace: ns::foo() defined outside the namespace block.
      const fake = Object.assign({}, e, { qname: e.nsPath.concat(e.qual, [e.name]).join('::') });
      return this.addFreeFunction(fake, path, 'file:' + path);
    }
    const id = 'fn:' + owner.qname + '::' + e.name + '(' + e.sig + ')';
    let n = this.nodes.get(id);
    if (!n || !n.declOnly) {
      // Signature spelled differently: fall back to the single undefined declaration with this name.
      const mm = this.methodsByClass.get(owner.id);
      const same = mm ? (mm.get(e.name) || []).filter(m => m.declOnly) : [];
      n = same.length === 1 ? same[0] : null;
      if (!n && same.length > 1) n = same.find(m => (m._params || []).length === e.params.length) || null;
    }
    if (n) {
      n.declOnly = false;
      n.defFile = path;
      n.defLine = e.line;
      n.defEndLine = e.endLine;
      n.hash = hashString(n.hash + e.hash);
      if (!n.retTypeName) n.retTypeName = e.retTypeName;
    } else {
      n = this.addNode({
        id, kind: 'method', name: e.name, qname: owner.qname + '::' + e.name, parent: owner.id, file: path, line: e.line, endLine: e.endLine,
        signature: e.signature, sig: e.sig, hash: e.hash, defFile: path, defLine: e.line, defEndLine: e.endLine, retTypeName: e.retTypeName
      });
      this.registerMethod(owner, n);
    }
    if (e.body) this.functionsWithBodies.push({ node: n, body: e.body, params: e.params, ownerClass: owner.id, nsPath: owner.qname.split('::').slice(0, -1) });
    return n;
  }

  // ---- 3. relationships ------------------------------------------------------

  resolveBases() {
    for (const n of this.nodes.values()) {
      if (!n.bases || !n.bases.length) continue;
      const nsPath = (n.qname || '').split('::').slice(0, -1);
      const list = [];
      for (const b of n.bases) {
        const base = this.findClass(b.name, nsPath);
        if (base && base.id !== n.id) {
          list.push(base.id);
          this.addEdge(n.id, base.id, 'inherits', { site: { file: n.file, line: n.line } });
        }
      }
      this.basesOf.set(n.id, list);
    }
  }

  findMethodInHierarchy(classId, name, seen) {
    seen = seen || new Set();
    if (!classId || seen.has(classId)) return null;
    seen.add(classId);
    const mm = this.methodsByClass.get(classId);
    const found = mm && mm.get(name);
    if (found && found.length) return found;
    for (const b of this.basesOf.get(classId) || []) {
      const r = this.findMethodInHierarchy(b, name, seen);
      if (r) return r;
    }
    return null;
  }

  fieldTypeInHierarchy(classId, name, seen) {
    seen = seen || new Set();
    if (!classId || seen.has(classId)) return null;
    seen.add(classId);
    const fm = this.fieldsByClass.get(classId);
    if (fm && fm.has(name)) return fm.get(name);
    for (const b of this.basesOf.get(classId) || []) {
      const r = this.fieldTypeInHierarchy(b, name, seen);
      if (r) return r;
    }
    return null;
  }

  resolveOverrides() {
    for (const [classId, mm] of this.methodsByClass) {
      const bases = this.basesOf.get(classId) || [];
      if (!bases.length) continue;
      for (const [name, methods] of mm) {
        if (name.startsWith('~') || name === this.nodes.get(classId).name) continue;
        for (const m of methods) {
          for (const b of bases) {
            const baseMethods = this.findMethodInHierarchy(b, name);
            if (!baseMethods) continue;
            const target = baseMethods.find(x => x.sig === m.sig) || (baseMethods.length === 1 ? baseMethods[0] : null);
            if (target && (target.isVirtual || m.isVirtual)) {
              this.addEdge(m.id, target.id, 'overrides', { site: { file: m.file, line: m.line } });
              m.isVirtual = true;
            }
          }
        }
      }
    }
  }

  resolveCalls() {
    for (const fb of this.functionsWithBodies) {
      const { node, body, params, ownerClass } = fb;
      const nsPath = fb.nsPath || [];
      const site = line => ({ file: node.defFile || node.file, line });
      const varTypes = Object.assign({}, body.locals);
      for (const p of params || []) if (p.name && p.typeName) varTypes[p.name] = p.typeName;

      const classOfVar = name => {
        let t = varTypes[name];
        if (!t && ownerClass) t = this.fieldTypeInHierarchy(ownerClass, name);
        if (!t) {
          // global variable?
          return null;
        }
        if (t.startsWith('?')) {
          // auto x = Foo(...) or auto x = makeFoo(...)
          const n = t.slice(1);
          const c = this.findClass(n, nsPath);
          if (c) return c;
          const fns = this.freeByName.get(n);
          if (fns && fns.length && fns[0].retTypeName) return this.findClass(fns[0].retTypeName, nsPath);
          return null;
        }
        return this.findClass(t, nsPath);
      };

      const linkAll = (targets, line, uncertain) => {
        for (const t of targets) this.addEdge(node.id, t.id, 'calls', { site: site(line), uncertain });
      };
      const byNameFallback = (name, line) => {
        const cands = this.methodsByName.get(name);
        if (!cands || !cands.length) return false;
        const owners = new Set(cands.map(c => c.parent));
        if (owners.size === 1) {
          linkAll(cands, line, false);
          return true;
        }
        if (owners.size <= 3) {
          linkAll(cands, line, true);
          return true;
        }
        return false;
      };

      for (const c of body.calls) {
        if (c.isNew) {
          const cls = this.findClass(c.name, nsPath);
          if (cls) {
            const ctors = this.findMethodInHierarchy(cls.id, cls.name);
            if (ctors) linkAll(ctors, c.line, false);
            this.addEdge(node.id, cls.id, 'uses', { site: site(c.line) });
          }
          continue;
        }
        if (c.recv) {
          let cls = null;
          if (c.recv.this) cls = ownerClass ? this.nodes.get(ownerClass) : null;
          else if (c.recv.var) cls = classOfVar(c.recv.var);
          if (cls) {
            const m = this.findMethodInHierarchy(cls.id, c.name);
            if (m) {
              linkAll(m, c.line, false);
              continue;
            }
          }
          byNameFallback(c.name, c.line);
          continue;
        }
        if (c.qual.length) {
          const qualName = c.qual.join('::');
          const cls = this.findClass(qualName, nsPath);
          if (cls && cls.kind !== 'enum') {
            const m = this.findMethodInHierarchy(cls.id, c.name);
            if (m) {
              linkAll(m, c.line, false);
              continue;
            }
          }
          const suffix = qualName + '::' + c.name;
          const free = (this.freeByName.get(c.name) || []).filter(f => f.qname === suffix || f.qname.endsWith('::' + suffix));
          if (free.length) {
            linkAll(free, c.line, false);
            continue;
          }
          const nested = this.findClass(suffix, nsPath);
          if (nested) {
            this.addEdge(node.id, nested.id, 'uses', { site: site(c.line) });
            continue;
          }
          continue;
        }
        // Unqualified call: own class hierarchy first, then free functions, then constructors.
        if (ownerClass) {
          const m = this.findMethodInHierarchy(ownerClass, c.name);
          if (m) {
            linkAll(m, c.line, false);
            continue;
          }
        }
        const free = this.freeByName.get(c.name);
        if (free && free.length) {
          // Prefer functions visible from this namespace and, for statics, the same file.
          let pick = free.filter(f => !f.isStatic || f.file === node.file || f.file === node.defFile);
          const sameNs = pick.filter(f => {
            const fns = f.qname.split('::').slice(0, -1).join('::');
            return nsPath.join('::').startsWith(fns);
          });
          if (sameNs.length) pick = sameNs;
          if (pick.length) {
            linkAll(pick, c.line, new Set(pick.map(p => p.qname)).size > 1);
            continue;
          }
        }
        const cls = this.findClass(c.name, nsPath);
        if (cls) {
          this.addEdge(node.id, cls.id, 'uses', { site: site(c.line) });
          continue;
        }
      }

      // Type dependencies: referenced class/enum names, parameter and return types.
      const typeNames = new Set(body.idents);
      for (const p of params || []) for (const id of p.ids || []) typeNames.add(id);
      if (node.retTypeName) typeNames.add(node.retTypeName);
      for (const name of typeNames) {
        if (!this.classesByName.has(name)) continue;
        const cls = this.findClass(name, nsPath);
        if (!cls || cls.id === ownerClass) continue;
        this.addEdge(node.id, cls.id, 'uses');
      }
    }

    // Fields and globals depend on their types.
    for (const n of this.nodes.values()) {
      if ((n.kind !== 'field' && n.kind !== 'variable') || !n.typeIds) continue;
      const nsPath = (n.qname || this.nodes.get(n.parent)?.qname || '').split('::');
      for (const name of new Set(n.typeIds)) {
        if (!this.classesByName.has(name)) continue;
        const cls = this.findClass(name, nsPath);
        if (cls && cls.id !== n.parent) this.addEdge(n.id, cls.id, 'uses', { site: { file: n.file, line: n.line } });
      }
    }
  }

  resolveIncludes(files) {
    const byBase = new Map();
    const paths = new Set();
    for (const f of files) {
      this.pushMap(byBase, basename(f.path).toLowerCase(), f.path);
      paths.add(f.path);
    }
    for (const f of files) {
      for (const inc of f.includes) {
        const incPath = inc.path.replace(/\\/g, '/');
        let target = null;
        if (!inc.system) {
          const rel = normalizePath((dirname(f.path) ? dirname(f.path) + '/' : '') + incPath);
          if (paths.has(rel)) target = rel;
        }
        if (!target) {
          const cands = (byBase.get(basename(incPath).toLowerCase()) || []).filter(p => {
            const lp = p.toLowerCase();
            const li = normalizePath(incPath).toLowerCase();
            return lp === li || lp.endsWith('/' + li);
          });
          if (cands.length === 1) target = cands[0];
          else if (cands.length > 1) {
            // Closest to the including file.
            const dir = dirname(f.path);
            let best = cands[0];
            let bestScore = -1;
            for (const c of cands) {
              let s = 0;
              const a = dir.split('/');
              const b = dirname(c).split('/');
              while (s < a.length && s < b.length && a[s] === b[s]) s++;
              if (s > bestScore) {
                bestScore = s;
                best = c;
              }
            }
            target = best;
          }
        }
        if (target && target !== f.path) {
          this.addEdge('file:' + f.path, 'file:' + target, 'includes', { site: { file: f.path, line: inc.line } });
        }
      }
    }
  }

  // ---- build -------------------------------------------------------------------

  build(files) {
    this.buildTree(files);
    const deferred = [];
    for (const f of files) {
      for (const e of this.addEntities(f)) deferred.push({ e, path: f.path });
    }
    for (const { e, path } of deferred) this.attachOutOfLine(e, path);
    this.resolveBases();
    this.resolveOverrides();
    this.resolveCalls();
    this.resolveIncludes(files);

    // Classes changed if any field changed too.
    const classFieldHash = new Map();
    for (const n of this.nodes.values()) {
      if (n.kind === 'field' && n.parent) classFieldHash.set(n.parent, (classFieldHash.get(n.parent) || '') + n.hash);
    }
    const nodes = [];
    for (const n of this.nodes.values()) {
      if (classFieldHash.has(n.id)) n.hash = hashString((n.hash || '') + classFieldHash.get(n.id));
      delete n.bases;
      delete n._params;
      delete n.typeIds;
      delete n.sig;
      delete n.retTypeName;
      delete n.declOnly;
      nodes.push(n);
    }
    return { nodes, edges: [...this.edges.values()] };
  }
}

/**
 * @param {Array<{path:string, text:string}>} sources  path is workspace-relative with '/' separators
 * @param {(msg:string)=>void} [onProgress]
 */
function buildGraph(sources, parsedCache) {
  const files = [];
  const errors = [];
  for (const src of sources) {
    const hash = hashString(src.text);
    let parsed = parsedCache && parsedCache.get(src.path);
    if (!parsed || parsed.hash !== hash) {
      parsed = parseFile(src.path, src.text);
      parsed.hash = hash;
      if (parsedCache) parsedCache.set(src.path, parsed);
    }
    if (parsed.error) errors.push({ file: src.path, error: parsed.error });
    files.push(parsed);
  }
  const graph = new GraphBuilder().build(files);
  graph.stats = {
    files: files.length,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    errors
  };
  return graph;
}

module.exports = { buildGraph };
