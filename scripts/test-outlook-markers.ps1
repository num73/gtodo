# Regression fixture: a provider permits standard folder fields but rejects named
# folder properties, matching the reported Exchange/Outlook calendar failure.
$ErrorActionPreference = 'Stop'
$bridgeFile = Join-Path ([IO.Directory]::GetParent($PSScriptRoot).FullName) 'electron\outlook-bridge.ps1'
$parseErrors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseInput((Get-Content -LiteralPath $bridgeFile -Raw -Encoding UTF8), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Bridge parse failed.' }
# Load only the actual declarations; never execute the COM entry point.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.TryStatementAst]) { break }
    . ([scriptblock]::Create($statement.Extent.Text))
}
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public sealed class GTodoTestAccessor {
    public int ReadResult = -2147221233;
    public int Reads;
    public int Writes;
    public string Value = "";
    public object GetProperty(string name) {
        Reads++;
        if (ReadResult != 0) throw new COMException("Provider failure", ReadResult);
        return Value;
    }
    public void SetProperty(string name, object value) {
        Writes++;
        throw new COMException("Named folder property operation is unsupported", -2147221246);
    }
}
public sealed class GTodoTestFolder {
    public string Description { get; set; }
    public GTodoTestAccessor PropertyAccessor = new GTodoTestAccessor();
}
'@
function Assert-True([bool]$condition, [string]$message) { if (!$condition) { throw $message } }
$fresh = New-Object GTodoTestFolder
$fresh.PropertyAccessor.ReadResult = -2147221246
Initialize-CalendarMarker $fresh
Assert-True (Test-OwnedCalendar $fresh) 'New folder must be owned.'
Assert-True ($fresh.PropertyAccessor.Reads -eq 0 -and $fresh.PropertyAccessor.Writes -eq 0) 'Standard marker must bypass named folder properties.'

$foreign = New-Object GTodoTestFolder
$foreign.Description = 'Personal calendar description'
$foreign.PropertyAccessor.ReadResult = -2147221246
Assert-True (!(Test-OwnedCalendar $foreign)) 'Unsupported legacy read must not adopt a foreign calendar.'
$rejected = $false
try { Initialize-CalendarMarker $foreign } catch { $rejected = $true }
Assert-True ($rejected -and $foreign.Description -ceq 'Personal calendar description') 'Existing description must be preserved.'

$missing = New-Object GTodoTestFolder
Assert-True (!(Test-OwnedCalendar $missing)) 'A missing legacy property must not grant ownership.'
$missing.Description = $folderDescriptionMarker + ' extra'
Assert-True (!(Test-OwnedCalendar $missing)) 'A partial description match must not grant ownership.'

$legacy = New-Object GTodoTestFolder
$legacy.Description = 'Preserve legacy description'
$legacy.PropertyAccessor.ReadResult = 0
$legacy.PropertyAccessor.Value = $marker
Assert-True (Test-OwnedCalendar $legacy) 'Existing legacy markers must remain compatible.'
Assert-True ($legacy.Description -ceq 'Preserve legacy description') 'Legacy description must not be overwritten.'

foreach ($hresult in @(-2147024891, -2147467259)) {
    $failed = New-Object GTodoTestFolder
    $failed.PropertyAccessor.ReadResult = $hresult
    $rejected = $false
    try { [void](Test-OwnedCalendar $failed) } catch { $rejected = $true }
    Assert-True $rejected 'Permissions and unexpected failures must stop calendar discovery.'
}
$rejected = $false
try { [void](Read-Property $foreign $ownerProperty) } catch { $rejected = $true }
Assert-True $rejected 'Appointment ownership must still fail closed on unsupported properties.'
[Console]::Out.Write('Calendar marker regression PASS')
