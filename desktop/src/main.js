// Yada Recorder : app menubar macOS (Electron). Pas de fenêtre au démarrage, pas d'icône Dock.
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, Notification, dialog, nativeImage, clipboard, shell } = require('electron');
const { Config } = require('./config');
const { Secrets } = require('./secrets');
const { CallStore } = require('./store');
const { Pipeline } = require('./pipeline');
const { createServer } = require('./server');

loadDotEnv();

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let pendingDeepLink = null;
let ready = false;
let tray = null;
let win = null;
let ctx = null;

// macOS : le deep link arrive par 'open-url', parfois avant 'ready'.
app.on('will-finish-launching', () => {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (ready) handleDeepLink(url);
    else pendingDeepLink = url;
  });
});
app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('yadarec://'));
  if (link) handleDeepLink(link);
  else openWindow();
});
app.on('window-all-closed', () => { /* reste dans la barre des menus */ });

if (process.env.YADAREC_DATA_DIR) { /* test : on n'enregistre pas le protocole */ }
else if (process.defaultApp) app.setAsDefaultProtocolClient('yadarec', process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient('yadarec');

// Tests : dossier de données et service Trousseau isolés.
if (process.env.YADAREC_DATA_DIR) app.setPath('userData', process.env.YADAREC_DATA_DIR);

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const dataDir = app.getPath('userData');
  const config = new Config(dataDir);
  const secrets = new Secrets(process.env.YADAREC_KEYCHAIN_SERVICE ? { service: process.env.YADAREC_KEYCHAIN_SERVICE } : {});
  const store = new CallStore(dataDir);
  const pipeline = new Pipeline({ store, config, secrets, notify: notifyReady });
  const srv = createServer({
    config, secrets, store, pipeline, version: app.getVersion(),
    hooks: {
      openWindow: () => openWindow(),
      confirmPair,
      onRecording: () => updateTray(),
      onSettingsChanged: (c) => applyLoginItem(c.launchAtLogin),
    },
  });
  ctx = { config, secrets, store, pipeline, srv };

  try {
    await srv.listen();
  } catch (e) {
    dialog.showErrorBox('Yada Recorder', `Impossible d’écouter sur 127.0.0.1:${config.get('port')} (${e.code || e.message}). Une autre instance tourne peut-être.`);
    app.quit();
    return;
  }

  if (!config.get('firstRunDone')) {
    applyLoginItem(config.get('launchAtLogin'));
    config.set({ firstRunDone: true });
  }

  createTray();
  pipeline.onChange(updateTray);
  await pipeline.start();
  ready = true;
  if (pendingDeepLink) handleDeepLink(pendingDeepLink);
  else if (!config.get('supabaseUrl') && !process.env.YADAREC_NO_WINDOW) openWindow('#/settings'); // premier lancement : réglages
});

// ------------------------------------------------------------------ fenêtre
function openWindow(hash = '') {
  if (!ctx) return;
  const url = ctx.srv.uiUrl(hash);
  if (win && !win.isDestroyed()) {
    if (hash) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    win.show();
    win.focus();
    app.focus({ steal: true });
    return;
  }
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'Yada Recorder',
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https:\/\//.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith(`http://127.0.0.1:${ctx.config.get('port')}/`)) e.preventDefault();
  });
  win.once('ready-to-show', () => { win.show(); app.focus({ steal: true }); });
  win.on('closed', () => { win = null; });
  win.loadURL(url);
}

function handleDeepLink(link) {
  try {
    const u = new URL(link);
    // yadarec://open  |  yadarec://call/<id>  |  yadarec://settings
    if (u.host === 'call' && u.pathname.length > 1) return openWindow(`#/call/${u.pathname.slice(1)}`);
    if (u.host === 'settings') return openWindow('#/settings');
  } catch (_) {}
  openWindow();
}

// ------------------------------------------------------------------ barre des menus
function trayIcon() {
  const p = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  const img = fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Yada Recorder');
  updateTray();
  setInterval(updateTray, 10000);
}

async function updateTray() {
  if (!tray || !ctx) return;
  const local = await ctx.store.list();
  const recording = local.filter((m) => m.state === 'recording' && Date.now() - (m.lastActivityAt || 0) < 30000).length;
  const waiting = local.filter((m) => m.state !== 'recording' && m.state !== 'error').length;
  const errors = local.filter((m) => m.state === 'error').length;
  tray.setTitle(recording ? ' REC' : errors ? ' !' : '');
  const status = recording ? '● Enregistrement en cours'
    : errors ? `${errors} appel(s) en erreur, nouvel essai automatique`
    : waiting ? `${waiting} appel(s) en traitement`
    : 'Actif : tous les appels sont traités';
  const login = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir les transcripts', click: () => openWindow() },
    { label: 'Réglages…', click: () => openWindow('#/settings') },
    { label: 'Copier le token d’appairage', click: async () => clipboard.writeText(await ctx.srv.token()) },
    { type: 'separator' },
    { label: 'Lancer au démarrage du Mac', type: 'checkbox', checked: login, click: (item) => { ctx.config.set({ launchAtLogin: item.checked }); applyLoginItem(item.checked); } },
    { label: 'Réessayer maintenant', enabled: errors > 0, click: () => ctx.pipeline.retryAll() },
    { type: 'separator' },
    { label: 'Quitter Yada Recorder', click: () => app.quit() },
  ]));
}

function applyLoginItem(on) {
  if (!app.isPackaged) return; // en dev, on n'inscrit pas le binaire Electron générique
  app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true });
}

// ------------------------------------------------------------------ dialogues, notifications
async function confirmPair() {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Autoriser', 'Refuser'],
    defaultId: 0,
    cancelId: 1,
    message: 'Autoriser l’extension Chrome Yada Recorder ?',
    detail: 'Elle pourra envoyer à cette app les enregistrements de tes appels Yadaphone.',
  });
  return response === 0;
}

function notifyReady(info) {
  if (!ctx || !ctx.config.get('notifications') || !Notification.isSupported()) return;
  const who = info.contactName || info.phoneNumber || 'Numéro inconnu';
  const min = info.duration ? ` · ${Math.max(1, Math.round(info.duration / 60))} min` : '';
  const n = new Notification({
    title: info.empty ? 'Appel sans parole détectée' : 'Transcript prêt',
    body: `${who}${min}`,
    silent: true,
  });
  n.on('click', () => openWindow(`#/call/${info.id}`));
  n.show();
}

// ------------------------------------------------------------------ .env (dev)
function loadDotEnv() {
  for (const p of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', '..', '.env')]) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    } catch (_) {}
  }
}
