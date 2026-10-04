@echo off
rem Launch scrcpy GUI from this folder.
rem
rem pushd normalises the drive/path and sets %CD% to a path with no trailing
rem backslash, so the quoted argument below can never break argument parsing.
pushd "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    popd
    goto :missing
)

start "" "node_modules\electron\dist\electron.exe" "%CD%"
popd
exit /b 0

:missing
echo.
echo   [scrcpy GUI] Electron is not installed yet.
echo.
echo   Run this once inside the folder:
echo       npm install --registry=https://registry.npmmirror.com
echo.
echo   The default npm registry certificate has expired,
echo   so the mirror above is required.
echo.
pause
exit /b 1
