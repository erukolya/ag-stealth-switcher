const fs = require('fs');
const path = require('path');

const candidatesWasm = [
  path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
];

const candidatesJs = [
  path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js'),
  path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.js')
];

const srcWasm = candidatesWasm.find(p => fs.existsSync(p));
const srcJs = candidatesJs.find(p => fs.existsSync(p));

const targetDirs = [
  path.join(__dirname, '..', 'dist'),
  path.join(__dirname, '..', 'dist', 'core'),
  path.join(__dirname, '..', 'dist', 'cli')
];

for (const dstDir of targetDirs) {
  if (!fs.existsSync(dstDir)) {
    fs.mkdirSync(dstDir, { recursive: true });
  }

  if (srcWasm) {
    fs.copyFileSync(srcWasm, path.join(dstDir, 'sql-wasm.wasm'));
  }
  if (srcJs) {
    fs.copyFileSync(srcJs, path.join(dstDir, 'sql-wasm.js'));
  }
}

if (srcWasm && srcJs) {
  console.log('[+] sql-wasm.wasm and sql-wasm.js copied successfully to all dist targets.');
} else {
  console.warn('[!] Warning: sql-wasm files not fully found in node_modules. Run npm install first.');
}
