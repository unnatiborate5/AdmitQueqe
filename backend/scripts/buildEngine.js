'use strict';
/**
 * Compiles the C++ queue engine (cpp_engine/) with the system C++ compiler.
 * Called automatically by `npm start` / `npm test` (and lazily by the server if the binary is missing),
 * so no manual build step is needed. Rebuilds only when a source file is newer than the binary.
 *
 *   node scripts/buildEngine.js            build the engine        -> cpp_engine/build/queue_engine
 *   node scripts/buildEngine.js --tests    build the C++ unit tests -> cpp_engine/build/test_engine
 *   CXX=clang++ node scripts/buildEngine.js  use another compiler
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE_DIR = path.join(__dirname, '..', '..', 'cpp_engine');
const BUILD_DIR = path.join(ENGINE_DIR, 'build');
const EXE = process.platform === 'win32' ? '.exe' : '';

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

function findCompiler() {
  const candidates = [process.env.CXX, 'g++', 'c++', 'clang++'].filter(Boolean);
  for (const cc of candidates) {
    const r = spawnSync(cc, ['--version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return cc;
  }
  throw new Error(
    'No C++ compiler found. The queue engine is written in C++ and needs GCC (g++) or Clang.\n'
    + '  Windows: install MinGW-w64 / MSYS2 (https://www.msys2.org) and make sure g++ is on PATH.\n'
    + '  macOS:   xcode-select --install      Linux: sudo apt install g++\n'
    + 'Then run the command again.'
  );
}

function build(name, sources) {
  const out = path.join(BUILD_DIR, `${name}${EXE}`);
  const inputs = [...sources, ...walk(path.join(ENGINE_DIR, 'include'))];
  const newest = Math.max(...inputs.map((f) => fs.statSync(f).mtimeMs));
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= newest) return out;

  const cc = findCompiler();
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;   // compile to a temp name, then rename: safe if two processes build at once
  const args = ['-std=c++17', '-O2', '-Wall', '-Wextra', '-Iinclude', ...sources.map((f) => path.relative(ENGINE_DIR, f)), '-o', tmp];
  const r = spawnSync(cc, args, { cwd: ENGINE_DIR, encoding: 'utf8' });
  if (r.status !== 0) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw new Error(`Could not compile the C++ queue engine with ${cc}:\n${r.stderr || r.error}`);
  }
  fs.renameSync(tmp, out);
  return out;
}

const src = (...names) => names.map((n) => path.join(ENGINE_DIR, 'src', n));
const ensureEngineBinary = () => build('queue_engine', src('queue_engine.cpp', 'protocol.cpp', 'main.cpp'));
const ensureTestBinary = () => build('test_engine', [...src('queue_engine.cpp', 'protocol.cpp'), path.join(ENGINE_DIR, 'tests', 'test_engine.cpp')]);

module.exports = { ensureEngineBinary, ensureTestBinary, ENGINE_DIR, BUILD_DIR };

if (require.main === module) {
  try {
    const out = process.argv.includes('--tests') ? ensureTestBinary() : ensureEngineBinary();
    console.log(`C++ engine ready: ${path.relative(process.cwd(), out)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
