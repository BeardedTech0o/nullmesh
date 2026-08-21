const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path  = require('path');
const net   = require('net');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const { spawn } = require('child_process');

let mainWindow = null;
let tray = null;
let appPort = 3000;

// ── UPDATE CHECK ───────────────────────────────────────────────────
// Plain GitHub Releases check — no extra runtime dependency, no extra
// release artifacts (electron-updater would need latest.yml published
// alongside the installer and would add weight to the packaged app).
const UPDATE_REPO = 'BeardedTech0o/nullmesh';
const UPDATE_ASSET_RE = /^nullmesh-setup-.*\.exe$/i;   // matches build.nsis.artifactName

function ghHeaders() {
  const headers = {
    'User-Agent': 'nullmesh-updater',
    'Accept': 'application/vnd.github+json',
  };
  // Public repos need no token; support one anyway so a private repo just works later.
  const token = process.env.NULLMESH_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function httpsGetJson(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: ghHeaders(), timeout: 10000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return httpsGetJson(res.headers.location, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 2e6) req.destroy(new Error('Response too large')); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

function downloadTo(url, destPath, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...ghHeaders(), Accept: 'application/octet-stream' }, timeout: 60000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Too many redirects'));
        return downloadTo(res.headers.location, destPath, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(destPath)));
      file.on('error', err => { try { fs.unlinkSync(destPath); } catch {} reject(err); });
    });
    req.on('timeout', () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}

// Returns > 0 when `a` is newer than `b`. Tolerates a leading "v" and pre-release suffixes.
function compareVersions(a, b) {
  const parse = v => String(v || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function checkForUpdates() {
  // Never let the update check affect startup — log and give up on any problem.
  try {
    if (process.platform !== 'win32') return;
    const current = app.getVersion();
    const release = await httpsGetJson(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    const latest = release?.tag_name || release?.name;
    if (!latest) { console.log('[update] No release found'); return; }
    if (compareVersions(latest, current) <= 0) {
      console.log(`[update] Up to date (running ${current}, latest ${latest})`);
      return;
    }
    const asset = (release.assets || []).find(a => UPDATE_ASSET_RE.test(a.name || ''))
               || (release.assets || []).find(a => /\.exe$/i.test(a.name || ''));
    if (!asset) { console.log('[update] Release has no Windows installer asset'); return; }

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Download & Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'nullmesh update available',
      message: `nullmesh ${String(latest).replace(/^v/i, '')} is available.`,
      detail: `You are running ${current}. Download the installer (${Math.round((asset.size || 0) / 1048576)} MB) and run it now?\n\nnullmesh will close so the installer can replace its files.`,
      noLink: true,
    });
    if (response !== 0) { console.log('[update] User deferred update'); return; }

    const dest = path.join(os.tmpdir(), asset.name.replace(/[^\w.\-]/g, '_'));
    console.log('[update] Downloading', asset.browser_download_url, '->', dest);
    await downloadTo(asset.url || asset.browser_download_url, dest);

    console.log('[update] Launching installer');
    const child = spawn(dest, [], { detached: true, stdio: 'ignore' });
    child.unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 800);
  } catch (err) {
    console.log('[update] Check skipped:', err?.message || err);
  }
}

function findFreePort(start) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', () => resolve(findFreePort(start + 1)));
  });
}

function startServer(port) {
  process.env.NULLMESH_PORT = String(port);
  try {
    require('./server.bundle.cjs');
    console.log('[main] Server started on port', port);
  } catch (err) {
    dialog.showErrorBox('nullmesh Error', 'The server failed to start.\n\n' + err.message);
    console.error('[main] Server error:', err.stack);
    app.quit();
  }
}

function waitForWS(port, retries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = n => {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        if (n <= 0) return reject(new Error('Server did not start on port ' + port));
        setTimeout(() => attempt(n - 1), 200);
      });
    };
    attempt(retries);
  });
}

function createWindow(port) {
  const indexPath = path.join(__dirname, 'index.html');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#e6e9ee',
    frame: true,
    title: 'nullmesh',
    webPreferences: {
      nodeIntegration: false,           // Never expose Node.js to renderer
      contextIsolation: true,           // Renderer isolated from main process
      webSecurity: true,                // Same-origin policy enforced
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      devTools: false,                  // No devtools in production
      additionalArguments: [`--ws-port=${port}`],
    },
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    show: false,
  });

  mainWindow.setMenuBarVisibility(false);


  // Pass the port in the URL too — the renderer has no Node access, so
  // process.argv is not always readable there.
  mainWindow.loadFile(indexPath, { query: { wsPort: String(port) } });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    console.log('[main] Window shown');
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] Page loaded OK');
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error('[main] Load failed:', code, desc, url);
    dialog.showErrorBox('Load Failed',
      `Code: ${code}\nDesc: ${desc}\nURL: ${url}\nindex.html: ${indexPath}`);
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('[main] Renderer crashed:', details.reason);
    dialog.showErrorBox('Renderer Crashed', JSON.stringify(details));
  });

  mainWindow.webContents.on('console-message', (e, level, msg, line, src) => {
    const levels = ['verbose','info','warning','error'];
    console.log(`[renderer:${levels[level]||level}] ${msg}`);
  });

  // Validate URLs before opening externally — prevent file://, javascript: etc
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const allowed = /^https?:\/\//i.test(url);
    if (allowed) shell.openExternal(url);
    return { action: 'deny' }; // always deny Electron opening a new window
  });

  // Block navigation away from the local file
  mainWindow.webContents.on('will-navigate', (e, navUrl) => {
    if (!navUrl.startsWith('file://')) {
      e.preventDefault();
      console.warn('[main] Blocked navigation to:', navUrl);
    }
  });

  // Block new window creation from renderer
  mainWindow.webContents.on('new-window', (e) => {
    e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.ico'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
    tray.setToolTip('nullmesh');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'nullmesh', enabled: false }, { type: 'separator' },
      { label: 'Show', click: () => mainWindow?.show() },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => mainWindow?.show());
  } catch (e) { console.error('[main] Tray:', e.message); }
}

// Required for Windows taskbar pinning — keeps icon linked to the installed app
app.setAppUserModelId('com.nullmesh.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mainWindow?.show());

  app.whenReady().then(async () => {
    appPort = await findFreePort(3000);
    startServer(appPort);

    try { await waitForWS(appPort); }
    catch (e) {
      dialog.showErrorBox('nullmesh', 'Server did not start:\n\n' + e.message);
      app.quit(); return;
    }

    createWindow(appPort);
    createTray();

    // Ask GitHub whether a newer installer exists — non-blocking, best effort
    setTimeout(() => { checkForUpdates(); }, 5000);
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!mainWindow) createWindow(appPort); else mainWindow.show(); });
  app.on('before-quit', () => { app.isQuitting = true; });
}
