#!/usr/bin/env node

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const args = process.argv.slice(2);
const children = new Set();
const clients = new Set();

const noBrowser = args.includes('--no-browser');
const requestedPort = Number(readArg('--port') || process.env.TIDL_DEV_PORT || 8787);
const requestedDebugPort = Number(readArg('--debug-port') || process.env.TIDL_CHROME_DEBUG_PORT || 9222);
const browserUrl = readArg('--url') || process.env.TIDL_DEV_URL || 'https://example.com/';
const requestedUserDataDir = readArg('--user-data-dir') || process.env.TIDL_CHROME_USER_DATA_DIR || '';
const requestedProfileDirectory = readArg('--profile-directory') || process.env.TIDL_CHROME_PROFILE_DIRECTORY || '';
const useDefaultProfile = args.includes('--default-profile') || process.env.TIDL_USE_DEFAULT_CHROME_PROFILE === '1';
const restartChrome = args.includes('--restart-chrome') || process.env.TIDL_RESTART_CHROME === '1';

let server;
let debugPort = null;
let distWatcher = null;

main().catch((err) => {
  console.error(`[dev] ${err.stack || err.message || err}`);
  cleanup(1);
});

async function main() {
  const devPort = await startDevServer(requestedPort);
  const devServerUrl = `http://127.0.0.1:${devPort}`;

  if (!noBrowser) {
    debugPort = await findAvailablePort(requestedDebugPort);
  }

  console.log(`[dev] Live reload server: ${devServerUrl}`);
  const build = startBuild(devServerUrl);

  let ready = false;
  build.stdout.on('data', (chunk) => {
    const text = String(chunk);
    process.stdout.write(prefixLines(text, '[build] '));
    if (!ready && text.includes('Watching...')) {
      ready = true;
      void onBuildReady(devServerUrl);
    }
  });

  build.stderr.on('data', (chunk) => {
    process.stderr.write(prefixLines(String(chunk), '[build] '));
  });

  build.on('exit', (code, signal) => {
    if (code || signal) {
      console.error(`[dev] Build watcher exited (${signal || code}).`);
      cleanup(code || 1);
    }
  });
}

async function onBuildReady(devServerUrl) {
  console.log('[dev] Build watcher is ready.');
  startDistWatcher();

  if (noBrowser) {
    console.log('[dev] Browser launch skipped. Load dist/ in Chrome manually.');
    return;
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    console.warn('[dev] Could not find Chrome. Re-run with --no-browser, or set CHROME_PATH.');
    return;
  }

  if (restartChrome) {
    if (useDefaultProfile || requestedUserDataDir) {
      await quitChrome(chromePath);
    } else {
      console.warn('[dev] --restart-chrome is only useful with --default-profile or --user-data-dir.');
    }
  }

  launchChrome(chromePath, devServerUrl);
}

function startBuild(devServerUrl) {
  const child = childProcess.spawn(process.execPath, ['build.js', '--watch'], {
    cwd: rootDir,
    env: {
      ...process.env,
      TIDL_DEV_SERVER_URL: devServerUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

async function startDevServer(preferredPort) {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
      });
      res.write(': tidl dev connected\n\n');

      const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
      }, 15000);

      clients.add(res);
      req.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('Not found');
  });

  const port = await findAvailablePort(preferredPort);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.removeAllListeners('error');
  return port;
}

function broadcast(message) {
  const payload = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

function startDistWatcher() {
  fs.mkdirSync(distDir, { recursive: true });

  const changed = new Set();
  let timer = null;
  let suppressUntil = Date.now() + 1000;

  try {
    distWatcher = fs.watch(distDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || Date.now() < suppressUntil) return;

      const file = String(filename).replaceAll(path.sep, '/');
      if (file.endsWith('.map')) return;

      changed.add(file);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const paths = [...changed];
        changed.clear();
        void handleDistChanges(paths);
      }, 250);
    });
  } catch (err) {
    console.warn(`[dev] Could not watch dist/: ${err.message || err}`);
    return;
  }

  console.log('[dev] Watching dist/ for extension reloads.');
}

async function handleDistChanges(paths) {
  if (!paths.length) return;

  const version = Date.now();
  const visiblePaths = paths.sort();

  if (visiblePaths.every((file) => file === 'content.css')) {
    console.log(`[dev] CSS changed: ${visiblePaths.join(', ')}`);
    broadcast({ type: 'content-css', version, paths: visiblePaths });
    return;
  }

  console.log(`[dev] Extension changed: ${visiblePaths.join(', ')}`);

  const cdpReloaded = debugPort ? await reloadExtensionViaCdp(debugPort) : false;
  broadcast({
    type: 'extension-reload',
    version,
    paths: visiblePaths,
    useContentFallback: !cdpReloaded,
  });

  if (debugPort) {
    setTimeout(() => {
      void reloadPagesViaCdp(debugPort);
    }, cdpReloaded ? 900 : 1400);
  }
}

function launchChrome(chromePath, devServerUrl) {
  const profileDir = getChromeProfileDir(chromePath);
  fs.mkdirSync(profileDir, { recursive: true });

  if ((useDefaultProfile || requestedUserDataDir) && !restartChrome && isProfileLikelyRunning(profileDir)) {
    console.warn('[dev] This Chrome profile appears to be in use.');
    console.warn('[dev] Close existing Chrome windows first, or use --restart-chrome so launch flags apply.');
  }

  const chromeArgs = [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--load-extension=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...(
      requestedProfileDirectory
        ? [`--profile-directory=${requestedProfileDirectory}`]
        : []
    ),
    browserUrl,
  ];

  const chrome = childProcess.spawn(chromePath, chromeArgs, {
    cwd: rootDir,
    stdio: 'ignore',
    detached: false,
  });

  children.add(chrome);
  chrome.on('exit', () => children.delete(chrome));

  console.log(`[dev] Chrome launched with dist/ loaded.`);
  console.log(`[dev] Profile: ${profileDir}`);
  if (requestedProfileDirectory) {
    console.log(`[dev] Profile directory: ${requestedProfileDirectory}`);
  }
  if (useDefaultProfile || requestedUserDataDir) {
    console.log('[dev] Using an existing Chrome profile, so installed extensions should be available.');
    console.log('[dev] If Chrome was already running, close it and rerun this command so launch flags apply.');
  } else {
    console.log('[dev] Using an isolated dev profile. Extensions installed in this profile will persist.');
  }
  console.log(`[dev] Debugging: http://127.0.0.1:${debugPort}`);
  console.log(`[dev] Test page: ${browserUrl}`);
  console.log(`[dev] Content CSS hot-swaps; JS rebuilds reload the extension and page.`);
  console.log(`[dev] Dev URL baked into build: ${devServerUrl}`);
}

function getChromeProfileDir(chromePath) {
  if (requestedUserDataDir) {
    return resolveUserPath(requestedUserDataDir);
  }

  if (useDefaultProfile) {
    return getDefaultUserDataDir(chromePath);
  }

  return path.join(rootDir, '.tidl-chrome-profile');
}

function getDefaultUserDataDir(chromePath) {
  if (process.platform === 'darwin') {
    const appName = path.basename(chromePath);
    if (appName.includes('Canary')) {
      return path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome Canary');
    }
    if (appName.includes('Chromium')) {
      return path.join(process.env.HOME || '', 'Library/Application Support/Chromium');
    }
    return path.join(process.env.HOME || '', 'Library/Application Support/Google/Chrome');
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
  }

  return path.join(process.env.HOME || '', '.config/google-chrome');
}

async function quitChrome(chromePath) {
  if (process.platform !== 'darwin') {
    console.warn('[dev] --restart-chrome currently quits Chrome automatically on macOS only.');
    return;
  }

  const appName = getMacChromeAppName(chromePath);
  if (!appName) {
    console.warn('[dev] Could not determine the Chrome app name to quit.');
    return;
  }

  console.log(`[dev] Quitting ${appName} so extension launch flags apply...`);
  try {
    childProcess.execFileSync('osascript', ['-e', `tell application "${appName}" to quit`], {
      stdio: 'ignore',
    });
  } catch {
    // The app may not have been running.
  }

  await delay(2500);
}

function getMacChromeAppName(chromePath) {
  const match = chromePath.match(/\/([^/]+\.app)\//);
  return match?.[1]?.replace(/\.app$/, '') || '';
}

function isProfileLikelyRunning(profileDir) {
  return ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
    .some((file) => fs.existsSync(path.join(profileDir, file)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUserPath(filePath) {
  if (filePath === '~') {
    return process.env.HOME || filePath;
  }
  if (filePath.startsWith('~/')) {
    return path.join(process.env.HOME || '', filePath.slice(2));
  }
  return path.resolve(filePath);
}

async function reloadExtensionViaCdp(port) {
  const targets = await listCdpTargets(port);
  const extensionTarget =
    targets.find((target) => target.webSocketDebuggerUrl && target.type === 'service_worker' && isExtensionUrl(target.url)) ||
    targets.find((target) => target.webSocketDebuggerUrl && isExtensionUrl(target.url));

  if (!extensionTarget) {
    return false;
  }

  return sendCdpCommand(extensionTarget.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: 'chrome.runtime.reload()',
  });
}

async function reloadPagesViaCdp(port) {
  const targets = await listCdpTargets(port);
  const pages = targets.filter((target) =>
    target.webSocketDebuggerUrl &&
    target.type === 'page' &&
    /^(https?|file):/.test(target.url || '')
  );

  await Promise.all(
    pages.map((page) => sendCdpCommand(page.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: true })),
  );

  if (pages.length) {
    console.log(`[dev] Reloaded ${pages.length} page${pages.length === 1 ? '' : 's'}.`);
  }
}

async function listCdpTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

function sendCdpCommand(webSocketUrl, method, params = {}) {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') {
      resolve(false);
      return;
    }

    const ws = new WebSocket(webSocketUrl);
    const id = 1;
    let opened = false;
    let settled = false;
    const timeout = setTimeout(() => finish(opened), 1500);

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      resolve(Boolean(value));
    }

    ws.addEventListener('open', () => {
      opened = true;
      ws.send(JSON.stringify({ id, method, params }));
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (msg.id === id) {
        finish(!msg.error && !msg.result?.exceptionDetails);
      }
    });

    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(opened));
  });
}

function isExtensionUrl(url) {
  return typeof url === 'string' && url.startsWith('chrome-extension://');
}

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    process.env.HOME && `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    process.env.HOME && `${process.env.HOME}/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found near ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });
}

function readArg(name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);

  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];

  return '';
}

function prefixLines(text, prefix) {
  return text
    .split(/(\n)/)
    .map((part, index, parts) => {
      if (part === '\n' || part === '') return part;
      const previous = parts[index - 1];
      return index === 0 || previous === '\n' ? `${prefix}${part}` : part;
    })
    .join('');
}

function cleanup(code = 0) {
  if (distWatcher) distWatcher.close();
  if (server) server.close();

  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Process already exited.
    }
  }

  process.exit(code);
}

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
process.on('exit', () => {
  if (distWatcher) distWatcher.close();
});
