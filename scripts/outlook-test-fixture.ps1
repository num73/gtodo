# Opt-in native integration fixture. Every mutation is confined to a new local QA PST.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Release-Com($object) { if ($null -ne $object -and [Runtime.InteropServices.Marshal]::IsComObject($object)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($object) } }
$application = $null; $session = $null; $stores = $null; $store = $null; $root = $null; $folder = $null
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $qaRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Directory]::GetParent($PSScriptRoot).FullName) '.qa'))
    $storePath = [IO.Path]::GetFullPath([string]$request.storePath)
    if ([IO.Path]::GetDirectoryName($storePath) -ine $qaRoot -or [IO.Path]::GetFileName($storePath) -notmatch '^outlook-integration-[a-f0-9-]{36}\.pst$') { throw 'Refusing a non-fixture path.' }
    try { $application = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { $application = New-Object -ComObject Outlook.Application }
    $session = $application.GetNamespace('MAPI')
    if ($request.action -eq 'setup') {
        if (Test-Path -LiteralPath $storePath) { throw 'Fixture file already exists.' }
        $session.AddStoreEx($storePath, 2)
    }
    $stores = $session.Stores
    for ($index = 1; $index -le $stores.Count; $index++) {
        $candidate = $stores.Item($index)
        if ([string]$candidate.FilePath -ieq $storePath) { $store = $candidate; break }
        Release-Com $candidate
    }
    if ($null -eq $store) {
        if ($request.action -eq 'cleanup') { [Console]::Out.Write('{"ok":true,"data":null}'); exit 0 }
        throw 'Fixture store not found.'
    }
    $root = $store.GetRootFolder()
    if ($request.action -eq 'setup') {
        $root.Name = 'GTodo local integration test'
        $folder = $root.Folders.Add('Test calendar', 9)
        $collision = $folder.Folders.Add('GTodo', 9); $collision.Description = 'Preserve unrelated calendar'; Release-Com $collision
        $data = @{ storeId = [string]$store.StoreID; folderId = [string]$folder.EntryID; name = 'Local QA / Calendar' }
    } elseif ($request.action -eq 'cleanup') {
        $session.RemoveStore($root)
        $data = $null
    } else {
        $folder = $session.GetFolderFromID([string]$request.folderId, [string]$store.StoreID)
        if ($folder.StoreID -ne $store.StoreID) { throw 'Folder escaped test store.' }
        $items = $folder.Items
        try {
            if ($request.action -eq 'inspect-folder') {
                $data = @{ description = [string]$folder.Description; count = $items.Count; name = [string]$folder.Name }
            } elseif ($request.action -eq 'tamper-marker') {
                $folder.Description = 'Changed calendar ownership'
                $data = $null
            } elseif ($request.action -eq 'legacy-marker') {
                $folder.Description = 'Preserve legacy calendar description'
                $accessor = $null
                try { $accessor = $folder.PropertyAccessor; $accessor.SetProperty('http://schemas.microsoft.com/mapi/string/{1ADCF3C8-8F33-4499-A7A5-3FC2DC9DF0AD}/GTodoCalendar', 'app.gtodo.desktop.v1') }
                finally { Release-Com $accessor }
                $data = $null
            } elseif ($request.action -eq 'seed') {
                $item = $items.Add('IPM.Appointment')
                try { $item.Subject = 'Unmanaged fixture event'; $item.Start = [DateTime]'2028-02-29'; $item.End = [DateTime]'2028-03-01'; $item.AllDayEvent = $true; $item.ReminderSet = $false; $item.Save() }
                finally { Release-Com $item }
                $data = $null
            } elseif ($request.action -eq 'edit') {
                $item = $session.GetItemFromID([string]$request.entryId, [string]$store.StoreID)
                try { $item.Subject = 'Outlook edit'; $item.Start = [DateTime]'2028-06-15'; $item.End = [DateTime]'2028-06-16'; $item.Save() }
                finally { Release-Com $item }
                $data = $null
            } elseif ($request.action -eq 'inspect') {
                $rows = New-Object 'System.Collections.Generic.List[object]'
                for ($index = 1; $index -le $items.Count; $index++) {
                    $item = $items.Item($index)
                    try {
                        $revision = ''; try { $revision = $item.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/string/{1ADCF3C8-8F33-4499-A7A5-3FC2DC9DF0AD}/GTodoRevision') } catch {}
                        $rows.Add(@{ entryId = [string]$item.EntryID; subject = [string]$item.Subject; body = [string]$item.Body; date = $item.Start.ToString('yyyy-MM-dd'); endDate = $item.End.ToString('yyyy-MM-dd'); allDay = [bool]$item.AllDayEvent; reminder = [bool]$item.ReminderSet; start = $item.Start.ToString('o'); end = $item.End.ToString('o'); importance = [int]$item.Importance; busy = [int]$item.BusyStatus; recurring = [bool]$item.IsRecurring; revision = $revision })
                    } finally { Release-Com $item }
                }
                $data = @($rows.ToArray())
            } else { throw 'Unknown fixture action.' }
        } finally { Release-Com $items }
    }
    [Console]::Out.Write((@{ ok = $true; data = $data } | ConvertTo-Json -Depth 6 -Compress))
} catch { [Console]::Out.Write((@{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress)); exit 1 }
finally { Release-Com $folder; Release-Com $root; Release-Com $store; Release-Com $stores; Release-Com $session; Release-Com $application }
