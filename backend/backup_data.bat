@echo off
REM =====================================================
REM BACKUP SCRIPT - Sao lưu data để chuyển máy
REM =====================================================
REM Chạy: backup_data.bat
REM Output: backup_YYYY-MM-DD.zip
REM =====================================================

echo.
echo ====================================================
echo        NOTION DASHBOARD - BACKUP DATA
echo ====================================================
echo.

REM Tạo tên file backup với ngày tháng
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set datetime=%%I
set BACKUP_NAME=backup_%datetime:~0,4%-%datetime:~4,2%-%datetime:~6,2%_%datetime:~8,2%%datetime:~10,2%

set BACKUP_DIR=%~dp0backups
set BACKUP_FILE=%BACKUP_DIR%\%BACKUP_NAME%.zip

REM Tạo thư mục backups nếu chưa có
if not exist "%BACKUP_DIR%" mkdir "%BACKUP_DIR%"

echo [1/3] Đang nén data...
echo       Source: %~dp0data\
echo       Target: %BACKUP_FILE%
echo.

REM Sử dụng PowerShell để nén
powershell -Command "Compress-Archive -Path '%~dp0data\*' -DestinationPath '%BACKUP_FILE%' -Force"

if %ERRORLEVEL% EQU 0 (
    echo [2/3] Lấy thông tin backup...
    for %%A in ("%BACKUP_FILE%") do set BACKUP_SIZE=%%~zA
    
    echo [3/3] HOÀN THÀNH!
    echo.
    echo ====================================================
    echo  ✅ BACKUP THÀNH CÔNG!
    echo ====================================================
    echo  File: %BACKUP_FILE%
    echo  Size: %BACKUP_SIZE% bytes
    echo.
    echo  📋 Để chuyển sang máy khác:
    echo  1. Copy file %BACKUP_NAME%.zip
    echo  2. Giải nén vào thư mục backend/data/
    echo  3. Chạy: npm start
    echo ====================================================
) else (
    echo ❌ LỖI: Không thể tạo backup!
)

echo.
pause
