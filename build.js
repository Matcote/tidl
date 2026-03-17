const esbuild = require('esbuild');
const fs = require('fs');

const watch = process.argv.includes('--watch');

const entryPoints = [
  { in: 'src/background.ts',      out: 'dist/background' },
  { in: 'src/content.ts',         out: 'dist/content' },
  { in: 'src/options/options.ts', out: 'dist/options/options' },
  { in: 'src/results/results.ts', out: 'dist/results/results' },
];

function copyStaticAssets() {
  ['dist/options', 'dist/results', 'dist/icons'].forEach(d => fs.mkdirSync(d, { recursive: true }));
  [
    ['options/options.html', 'dist/options/options.html'],
    ['options/options.css',  'dist/options/options.css'],
    ['results/results.html', 'dist/results/results.html'],
    ['results/results.css',  'dist/results/results.css'],
    ['content.css',          'dist/content.css'],
    ['manifest.json',        'dist/manifest.json'],
  ].forEach(([src, dst]) => fs.copyFileSync(src, dst));
  fs.cpSync('icons', 'dist/icons', { recursive: true });
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
  });
  if (watch) {
    await ctx.watch();
    console.log('Watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

build().catch(() => process.exit(1));
