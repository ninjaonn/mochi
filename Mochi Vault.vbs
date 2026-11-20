' Starts Mochi Vault without a console window.
' Put a shortcut to this file in shell:startup to launch it at login.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Environment("Process").Remove "ELECTRON_RUN_AS_NODE"
shell.Run """node_modules\electron\dist\electron.exe"" .", 0, False
