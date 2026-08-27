' Stop the WhatsApp bridge started by start-bridge-hidden.vbs.
'
' Reads the PID the bridge recorded in data\bridge.lock and ends just that
' process, so any other node programs you are running are left alone.

Option Explicit

Dim fso, shell, root, lockFile, pid, stream

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
lockFile = root & "\data\bridge.lock"

If Not fso.FileExists(lockFile) Then
    MsgBox "The bridge does not appear to be running." & vbCrLf & vbCrLf & _
           "(No data\bridge.lock file found.)", vbInformation, "WhatsApp Bridge"
    WScript.Quit 0
End If

Set stream = fso.OpenTextFile(lockFile, 1)
pid = Trim(stream.ReadAll)
stream.Close

If Not IsNumeric(pid) Then
    MsgBox "The lock file is unreadable. Stop node.exe from Task Manager instead.", _
           vbExclamation, "WhatsApp Bridge"
    WScript.Quit 1
End If

' /F because the bridge has no window to receive a polite close
shell.Run "cmd /c taskkill /PID " & pid & " /F", 0, True

MsgBox "Bridge stopped." & vbCrLf & vbCrLf & _
       "New messages will not sync until you start it again.", _
       vbInformation, "WhatsApp Bridge"
