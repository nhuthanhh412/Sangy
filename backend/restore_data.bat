@echo off
REM =====================================================
REM RESTORE SCRIPT - Khôi phục data từ backup
REM =====================================================
REM Chạy: restore_data.bat [backup_file.zip]
REM =====================================================

echo.
echo ====================================================
echo        NOTION DASHBOARD - RESTORE DATA
echo ====================================================
echo.

set BACKUP_FILE=%1
set DATA_DIR=%~dp0data

if "%BACKUP_FILE%"=="" (
    echo ❌ Thiếu file backup!
    echo.
    echo Cách dùng: restore_data.bat [backup_file.zip]
    echo Ví dụ:     restore_data.bat backups\backup_2026-02-03.zip
    echo.
    echo Danh sách backup có sẵn:
    dir /b "%~dp0backups\*.zip" 2>nul || echo   (Không có backup nào)
    echo.
    goto :end
)

if not exist "%BACKUP_FILE%" (
    echo ❌ File không tồn tại: %BACKUP_FILE%
    goto :end
)

echo ⚠️  CẢNH BÁO: Thao tác này sẽ ghi đè data hiện tại!
echo.
set /p CONFIRM="Bạn có chắc chắn muốn tiếp tục? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Đã hủy.
    goto :end
)

echo.
echo [1/3] Backup data hiện tại...
set CURRENT_BACKUP=%DATA_DIR%_before_restore_%date:~-4%%date:~3,2%%date:~0,2%
if exist "%DATA_DIR%" (
    rename "%DATA_DIR%" "data_before_restore"
    echo       Đã backup sang: data_before_restore/
)

echo [2/3] Giải nén backup...
mkdir "%DATA_DIR%" 2>nul
powershell -Command "Expand-Archive -Path '%BACKUP_FILE%' -DestinationPath '%DATA_DIR%' -Force"

if %ERRORLEVEL% EQU 0 (
    echo [3/3] HOÀN THÀNH!
    echo.
    echo ====================================================
    echo  ✅ RESTORE THÀNH CÔNG!
    echo ====================================================
    echo  Data đã được khôi phục từ: %BACKUP_FILE%
    echo.
    echo  📋 Bước tiếp theo:
    echo  1. Chạy: npm start
    echo  2. Mở: http://localhost:3000
    echo ====================================================
) else (
    echo ❌ LỖI: Không thể giải nén backup!
    echo Đang khôi phục data cũ...
    if exist "%~dp0data_before_restore" (
        rmdir /s /q "%DATA_DIR%"
        rename "data_before_restore" "data"
    )
)

:end
echo.
pause
