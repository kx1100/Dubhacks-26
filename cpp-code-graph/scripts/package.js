// Builds cpp-code-graph-<version>.vsix without npm/vsce: a VSIX is a zip with a
// manifest, a content-types file and the extension under extension/.
// Usage: node scripts/package.js   (uses the system `tar`, which can write zips)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const include = ['package.json', 'README.md', 'out', 'media'];
// The extension (out/extension.js) and the webview (media/dist/graph.js) ship as bundles, not sources.
const skip = ['media/webview', 'media/layout.js'].map(p => path.join(root, p));
require('./build-extension').build({ sourcemap: false, minify: true });
require('./build-webview').build({ sourcemap: false, minify: true });
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-'));
const ext = path.join(stage, 'extension');
fs.mkdirSync(ext);
for (const item of include) fs.cpSync(path.join(root, item), path.join(ext, item), { recursive: true, filter: src => !skip.includes(src) && !src.endsWith('.map') });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(ext, 'LICENSE.txt'));

const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${xmlEsc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEsc(pkg.description)}</Description>
    <Tags>${xmlEsc(pkg.keywords.join(','))}</Tags>
    <Categories>${xmlEsc(pkg.categories.join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`);
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".vsixmanifest" ContentType="text/xml" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".css" ContentType="text/css" /><Default Extension=".svg" ContentType="image/svg+xml" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".txt" ContentType="text/plain" /><Default Extension=".wasm" ContentType="application/wasm" /></Types>
`);

const out = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
fs.rmSync(out, { force: true });
const entries = ['[Content_Types].xml', 'extension.vsixmanifest', 'extension'];
if (process.platform === 'win32') {
  // Windows ships bsdtar, which writes zip archives (Git Bash's GNU tar does not).
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['--format', 'zip', '-c', '-f', out, ...entries], { cwd: stage, stdio: 'inherit' });
} else {
  execFileSync('zip', ['-q', '-r', '-X', out, ...entries], { cwd: stage, stdio: 'inherit' });
}
fs.rmSync(stage, { recursive: true, force: true });
console.log('Wrote ' + out);
