param([Parameter(Mandatory=$true)][int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TestDialog {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$deadline = [DateTime]::UtcNow.AddSeconds(20)
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $TargetProcessId)
while ([DateTime]::UtcNow -lt $deadline) {
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
        $names = @($window.Current.Name)
        foreach ($element in $elements) {
            $names += $element.Current.Name
        }
        $text = $names -join ' '
        if ($text.Contains('Local configuration/data cannot be read') -and $text.Contains('Your data has been preserved')) {
            $handle = [IntPtr]$window.Current.NativeWindowHandle
            if ($handle -eq [IntPtr]::Zero -or -not [TestDialog]::PostMessageW($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Could not dismiss the owned recovery dialog' }
            Write-Output 'Native root recovery dialog verified and dismissed.'
            exit 0
        }
    }
    Start-Sleep -Milliseconds 100
}
throw 'Expected native recovery dialog was not found for the owned test process'
