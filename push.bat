@echo off
chcp 65001 >nul
echo ========================================
echo   DashNotion - Push with fresh cache
echo ========================================
echo.

cd /d %~dp0

:: 1. Add all code changes
echo [1/4] Adding code changes...
git add -A

:: 2. Force-add cache + metadata (overrides .gitignore if needed)
echo [2/4] Updating cache data in git...
git add -f backend/data/cache/*.json
git add -f backend/data/metadata.json
git add -f backend/data/config.json

:: 3. Commit
echo [3/4] Committing...
if "%~1"=="" (
    set /p MSG="Commit message: "
) else (
    set "MSG=%*"
)
git commit -m "%MSG%"

:: 4. Push
echo [4/4] Pushing to remote...
git push

echo.
echo ✅ Done! Render will deploy with fresh cache data.
pause
