// Builds JSON fixtures for the webview harness: the sample graph and a diff
// against a modified copy of the sample.
const fs = require('fs');
const path = require('path');
const { buildGraph } = require('../src/graph/builder');
const { diffGraphs } = require('../src/graph/diff');
const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'sample');
const exts = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx|inl)$/i;
function read(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (exts.test(e.name)) out.push({ path: path.relative(dir, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  })(dir);
  return out;
}
const toMap = list => Object.fromEntries(list.map(s => [s.path, s.text]));
const base = read(root);
const g = buildGraph(base);
// Simulated change: modify Circle::area, remove Canvas::line, add Triangle class.
const changed = base.map(s => ({ ...s }));
const shapeH = changed.find(s => s.path.endsWith('shape.h'));
if (shapeH) shapeH.text = shapeH.text.replace('std::unique_ptr<Shape> makeShape', 'class Triangle : public Shape {\npublic:\n  Triangle() : Shape("tri") {}\n  double area() const override { return 0.5; }\n};\n\nstd::unique_ptr<Shape> makeShape');
const shapeC = changed.find(s => s.path.endsWith('shape.cpp'));
if (shapeC) shapeC.text = shapeC.text.replace('return M_PI * radius_ * radius_;', 'return 3.14159 * radius_ * radius_;').replace('if (kind == "circle")', 'if (kind == "tri") return std::make_unique<Triangle>();\n    if (kind == "circle")');
const canvasC = changed.find(s => s.path.endsWith('canvas.cpp'));
if (canvasC) canvasC.text = canvasC.text.replace(/void Canvas::line[\s\S]*?\n}\n/, '');
const canvasH = changed.find(s => s.path.endsWith('canvas.h'));
if (canvasH) canvasH.text = canvasH.text.replace('    void line(Point a, Point b);\n', '');
const d = diffGraphs(g, buildGraph(changed));
const outDir = process.argv[3] ? path.resolve(process.argv[3]) : __dirname;
fs.writeFileSync(path.join(outDir, 'fixtures.js'), 'window.__FIXTURES = ' + JSON.stringify({ graph: g, diff: d, sources: toMap(base), diffSources: toMap(changed) }) + ';\n');
console.log('nodes', g.nodes.length, 'diff', JSON.stringify(d.stats.diff));
