@echo off
echo.
echo  Nullmesh - Installing dependencies
echo  This only needs to run once.
echo.

node --version >nul 2>&1
if errorlevel 1 (
  echo  ERROR: Node.js not found.
  echo  Download and install from: https://nodejs.org
  echo  Then run this script again.
  pause
  exit /b 1
)

echo  Node.js found. Installing packages...
npm install

echo.
echo  Done! Run START.bat to launch Nullmesh.
pause
