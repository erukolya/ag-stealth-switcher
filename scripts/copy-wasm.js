const fs = require('fs');
const path = require('path');

const candidates = [
  path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm')
];

let src = candidates.find(p => fs.existsSync(p));

const targetDirs = [
  path.join(__dirname, '..', 'dist'),
  path.join(__dirname, '..', 'dist', 'core'),
  path.join(__dirname, '..', 'dist', 'cli')
];

if (src) {
  for (const dstDir of targetDirs) {
    if (!fs.existsSync(dstDir)) {
      fs.mkdirSync(dstDir, { recursive: true });
    }
    fs.copyFileSync(src, path.join(dstDir, 'sql-wasm.wasm'));
  }
  console.log('[+] sql-wasm.wasm copied successfully to dist targets.');
} else {
  console.warn('[!] Warning: sql-wasm.wasm not found in node_modules yet. Run npm install first.');
}
