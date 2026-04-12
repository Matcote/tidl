const esbuild = require('esbuild');
const fs = require('fs');

const watch = process.argv.includes('--watch');

function loadEnv() {
  const env = {};
  if (fs.existsSync('.env')) {
    fs.readFileSync('.env', 'utf8').split('\n').forEach(line => {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx).trim();
        const val = line.slice(eqIdx + 1).trim();
        if (key) env[key] = val;
      }
    });
  }
  return env;
}

const env = loadEnv();

const sharedConfig = {
  bundle: true,
  outdir: '.',
  platform: 'browser',
  target: ['chrome120'],
  sourcemap: true,
  define: {
    'process.env.TIDAL_CLIENT_ID':     JSON.stringify(env.TIDAL_CLIENT_ID || ''),
    'process.env.TIDAL_CLIENT_SECRET': JSON.stringify(env.TIDAL_CLIENT_SECRET || ''),
  },
};

// Entry points that do NOT use the player SDK — classic IIFE scripts
const iifeEntryPoints = [
  { in: 'src/background.ts',     out: 'dist/background' },
  { in: 'src/options/options.ts', out: 'dist/options/options' },
];

// Entry points that import @tidal-music/player (which uses top-level await).
// Chrome content scripts are classic scripts, so we wrap ESM output in an
// async IIFE to make top-level await valid.
const playerEntryPoints = [
  { in: 'src/content.ts',         out: 'dist/content' },
  { in: 'src/results/results.ts', out: 'dist/results/results' },
];

function copyStaticAssets() {
  ['dist/options', 'dist/results', 'dist/icons', 'dist/fonts'].forEach(d => fs.mkdirSync(d, { recursive: true }));
  [
    ['options/options.html', 'dist/options/options.html'],
    ['options/options.css',  'dist/options/options.css'],
    ['results/results.html', 'dist/results/results.html'],
    ['results/results.css',  'dist/results/results.css'],
    ['content.css',          'dist/content.css'],
    ['manifest.json',        'dist/manifest.json'],
  ].forEach(([src, dst]) => fs.copyFileSync(src, dst));
  fs.cpSync('icons', 'dist/icons', { recursive: true });
  fs.cpSync('fonts', 'dist/fonts', { recursive: true });
}

// esbuild plugin: strip ESM export statements from output.
// Content scripts are classic scripts and can't use `export`.
// The exports only exist so tests can import functions directly.
const stripExportsPlugin = {
  name: 'strip-exports',
  setup(build) {
    build.onEnd(result => {
      for (const ep of playerEntryPoints) {
        const file = ep.out + '.js';
        if (!fs.existsSync(file)) continue;
        let code = fs.readFileSync(file, 'utf8');
        const stripped = code.replace(/export \{[\s\S]*?\};\n?/g, '');
        if (stripped !== code) fs.writeFileSync(file, stripped);
      }
    });
  },
};

async function build() {
  copyStaticAssets();

  const iifeCtx = await esbuild.context({
    ...sharedConfig,
    entryPoints: iifeEntryPoints,
    format: 'iife',
  });

  const playerCtx = await esbuild.context({
    ...sharedConfig,
    entryPoints: playerEntryPoints,
    format: 'esm',
    banner: { js: '(async () => {' },
    footer: { js: '})();' },
    plugins: [stripExportsPlugin],
  });

  if (watch) {
    await Promise.all([iifeCtx.watch(), playerCtx.watch()]);
    console.log('Watching...');
    const staticSources = [
      'options/options.html', 'options/options.css',
      'results/results.html', 'results/results.css',
      'content.css', 'manifest.json', 'icons',
    ];
    for (const src of staticSources) {
      fs.watch(src, { recursive: true }, () => {
        console.log(`[static] ${src} changed, copying...`);
        copyStaticAssets();
      });
    }
    fs.watch('fonts', { recursive: true }, () => {
      console.log('[static] fonts changed, copying...');
      copyStaticAssets();
    });
  } else {
    await Promise.all([iifeCtx.rebuild(), playerCtx.rebuild()]);
    await Promise.all([iifeCtx.dispose(), playerCtx.dispose()]);
  }
}

build().catch(() => process.exit(1));
