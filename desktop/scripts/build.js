// Construit dist/Yada Recorder-darwin-<arch>/Yada Recorder.app (menubar, deep link yadarec://),
// puis le signe ad hoc (obligatoire sur Apple Silicon une fois l'Info.plist modifié).
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

(async () => {
  const root = path.join(__dirname, '..');
  const arch = process.env.ARCH || process.arch;
  const [appDir] = await packager({
    dir: root,
    name: 'Yada Recorder',
    executableName: 'Yada Recorder',
    platform: 'darwin',
    arch,
    out: path.join(root, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    appBundleId: 'com.yadarecorder.app',
    appCategoryType: 'public.app-category.productivity',
    protocols: [{ name: 'Yada Recorder', schemes: ['yadarec'] }],
    extendInfo: { LSUIElement: true, NSMicrophoneUsageDescription: 'Yada Recorder n’utilise pas le micro.' },
    ignore: [/^\/test($|\/)/, /^\/scripts($|\/)/, /^\/dist($|\/)/, /^\/\.env/],
  });
  const app = path.join(appDir, 'Yada Recorder.app');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`\nOK : ${app}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
