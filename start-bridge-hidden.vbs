' Start the WhatsApp bridge with no visible window.
'
' Double-click this file to run the bridge in the background. Nothing appears
' on screen; it keeps syncing until you stop it or the machine restarts.
'
' To have it start automatically at login, put a shortcut to this file in:
'   Win+R  ->  shell:startup
'
' To stop it, double-click stop-bridge.vbs (or end node.exe in Task Manager).
'
' Output goes to data\bridge-run.log and data\bridge-run.log.err

Option Explicit

Dim fso, shell, root, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' This script lives in the project root
root = fso.GetParentFolderName(WScript.ScriptFullName)

If Not fso.FileExists(root & "\src\bridge.js") Then
    MsgBox "Could not find src\bridge.js." & vbCrLf & vbCrLf & _
           "Keep this file in the whatsapp-mcp folder.", vbCritical, "WhatsApp Bridge"
    WScript.Quit 1
End If

shell.CurrentDirectory = root

' cmd /c so both streams can be redirected; window style 0 = hidden
cmd = "cmd /c node src\bridge.js > data\bridge-run.log 2> data\bridge-run.log.err"
shell.Run cmd, 0, False
