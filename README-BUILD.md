# nullmesh — Building the Installer

## To build the Windows installer (.exe)

**Requirements:** Node.js 18+ installed (https://nodejs.org)

1. Open this folder
2. Double-click **BUILD.bat**
3. Wait ~2 minutes for dependencies to download
4. The installer appears in the `dist/` folder as `nullmesh-setup-1.0.0.exe`

## Sharing

Send people the single `nullmesh-setup-1.0.0.exe` file.
They double-click it, click through the installer, done.
No Node.js, no command line, nothing else needed.

## What the installer includes

- The full nullmesh app
- Bundled Node.js runtime (users don't need it installed)
- Creates a Start Menu shortcut and optional Desktop shortcut
- Adds an Add/Remove Programs entry for clean uninstall

## Running in dev (without building)

```
npm install
npm start
```
