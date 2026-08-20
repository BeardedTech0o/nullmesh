@echo off
title Nullmesh Builder
pushd "%~dp0"

if not exist "package.json" (
  echo ERROR: Run this from the nullmesh folder. Current: %CD%
  pause & popd & exit /b 1
)

echo.
echo  ===================================
echo   Nullmesh - Building installer
echo  ===================================
echo  Folder: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 ( echo ERROR: Node.js not installed & pause & popd & exit /b 1 )
for /f %%v in ('node --version') do echo Node: %%v

where pnpm >nul 2>&1
if errorlevel 1 (
  echo  pnpm not found - installing it globally via npm...
  call npm install -g pnpm
  if errorlevel 1 ( echo ERROR: could not install pnpm & pause & popd & exit /b 1 )
)
for /f %%v in ('pnpm --version') do echo pnpm: %%v

REM Clean everything
echo  Cleaning...
if exist "dist" rmdir /s /q dist
if exist "server.bundle.cjs" del /q server.bundle.cjs
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
  rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
)

REM Verify main.js exists
if not exist "main.js" (
  echo ERROR: main.js not found in %CD%
  pause & popd & exit /b 1
)
echo  main.js found OK

REM Install
echo  Installing dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 ( echo pnpm install failed & pause & popd & exit /b 1 )

REM Bundle
echo.
echo  Bundling server code...
call node bundle.mjs
if errorlevel 1 ( echo Bundle failed & pause & popd & exit /b 1 )

if not exist "server.bundle.cjs" (
  echo ERROR: server.bundle.cjs was not created
  pause & popd & exit /b 1
)
echo  server.bundle.cjs created OK

REM Build
echo.
echo  Building installer...
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set CSC_LINK=
call node_modules\.bin\electron-builder.cmd --win --x64
if errorlevel 1 ( echo Build failed - scroll up for the error & pause & popd & exit /b 1 )

echo.
echo  ===================================
echo   Done! Installer is in dist\
echo  ===================================
explorer "%~dp0dist"
pause
popd
