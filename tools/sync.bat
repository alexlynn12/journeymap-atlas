@echo off
rem  Rebuild the atlas from JourneyMap and push it to GitHub.
rem  Run from anywhere; it operates on the repo this file lives in.
rem  Does nothing if the map hasn't changed.
setlocal enabledelayedexpansion

cd /d "%~dp0.." || exit /b 1

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY where py >nul 2>&1 && set "PY=py"
if not defined PY (
  echo ERROR: Python is not on PATH.
  exit /b 1
)

where git >nul 2>&1 || (
  echo ERROR: git is not on PATH.
  exit /b 1
)

if "%JOURNEYMAP%"=="" set "JOURNEYMAP=%APPDATA%\.minecraft\journeymap"
if not exist "%JOURNEYMAP%" (
  echo ERROR: JourneyMap folder not found: %JOURNEYMAP%
  exit /b 1
)

rem  nbtlib is only needed to read waypoints; the map builds without it.
%PY% -c "import nbtlib" >nul 2>&1 || %PY% -m pip install --quiet --user nbtlib

git pull --quiet --rebase --autostash

%PY% "tools\build.py" --journeymap "%JOURNEYMAP%" --out "." || exit /b 1

set "CHANGED="
for /f "delims=" %%i in ('git status --porcelain') do set "CHANGED=1"
if not defined CHANGED (
  echo No map changes to publish.
  exit /b 0
)

git add -A
git commit -q -m "Sync map %DATE% %TIME%"
git push -q || (
  echo ERROR: push failed. If this is the first push, run tools\sync.bat by hand
  echo once so GitHub can ask you to sign in.
  exit /b 1
)

echo Published. The site refreshes in a minute or two:
echo   https://alexlynn12.github.io/journeymap-atlas/
exit /b 0
