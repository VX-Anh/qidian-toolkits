@echo off
setlocal
where python >nul 2>nul
if %ERRORLEVEL%==0 (
    python "%~dp0qidian_screenshot_host.py"
) else (
    py -3 "%~dp0qidian_screenshot_host.py"
)
