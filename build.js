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

const entryPoints = [
  { in: 'src/background.ts',      out: 'dist/background' },
  { in: 'src/content.ts',         out: 'dist/content' },
  { in: 'src/options/options.ts', out: 'dist/options/options' },
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

async function build() {
  copyStaticAssets();
  const ctx = await esbuild.context({
    entryPoints,
    bundle: true,
    outdir: '.',
    platform: 'browser',
    target: ['chrome120'],
    format: 'iife',
    sourcemap: true,
    define: {
      'process.env.TIDAL_CLIENT_ID':     JSON.stringify(env.TIDAL_CLIENT_ID || ''),
      'process.env.TIDAL_CLIENT_SECRET': JSON.stringify(env.TIDAL_CLIENT_SECRET || ''),
    },
  });
  if (watch) {
    await ctx.watch();
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
    await ctx.rebuild();
    await ctx.dispose();
  }
}

build().catch(() => process.exit(1));
