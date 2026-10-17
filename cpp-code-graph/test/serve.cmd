@echo off
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" "%~dp0serve.js" %*
