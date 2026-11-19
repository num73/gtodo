# Outlook Object Model bridge. JSON arrives over stdin; task content is never executed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$prefix = 'http://schemas.microsoft.com/mapi/string/{1ADCF3C8-8F33-4499-A7A5-3FC2DC9DF0AD}/'
$folderProperty = $prefix + 'GTodoCalendar'
$ownerProperty = $prefix + 'GTodoOwner'
$taskProperty = $prefix + 'GTodoTaskId'
$revisionProperty = $prefix + 'GTodoRevision'
$marker = 'app.gtodo.desktop.v1'
# Exchange-backed calendars can reject named properties on folders, even though
# the same properties work on appointments and PST folders. Description uses the
# standard PR_COMMENT field and does not require a new named folder property.
$folderDescriptionMarker = 'GTodoCalendar {1ADCF3C8-8F33-4499-A7A5-3FC2DC9DF0AD} app.gtodo.desktop.v1'
$outlook = $null
$session = $null

function Release-Com($object) {
    if ($null -ne $object -and [Runtime.InteropServices.Marshal]::IsComObject($object)) {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($object)
    }
}
function Read-Property($object, [string]$name) {
    $accessor = $null
    try { $accessor = $object.PropertyAccessor; return [string]$accessor.GetProperty($name) }
    catch {
        # MAPI_E_NOT_FOUND is the only acceptable reason to treat a marker as absent.
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        if ($failure.HResult -eq -2147221233) { return '' }
        throw
    } finally { Release-Com $accessor }
}
function Write-Property($object, [string]$name, [string]$value) {
    $accessor = $null
    try { $accessor = $object.PropertyAccessor; $accessor.SetProperty($name, $value) }
    finally { Release-Com $accessor }
}
function Test-OwnedCalendar($folder) {
    if ([string]$folder.Description -ceq $folderDescriptionMarker) { return $true }
    try { return (Read-Property $folder $folderProperty) -ceq $marker }
    catch {
        $failure = $_.Exception
        while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
        # A provider without named folder properties cannot hold a legacy marker.
        # Do not apply this exception to appointment tags or permission/I/O errors.
        if ($failure.HResult -eq -2147221246) { return $false } # MAPI_E_NO_SUPPORT
        throw
    }
}
function Initialize-CalendarMarker($folder) {
    # Called only for the folder returned by Folders.Add, never for an unmarked
    # existing calendar. Keep descriptions on unrelated and legacy calendars intact.
    $description = [string]$folder.Description
    if ($description -and $description -cne $folderDescriptionMarker) { throw '新建日历的描述已改变，已停止写入。' }
    $folder.Description = $folderDescriptionMarker
    if ([string]$folder.Description -cne $folderDescriptionMarker) { throw '无法保存 GTodo 日历标记，请检查日历写入权限。' }
}
function Target-Info($folder, [string]$name) {
    return @{ storeId = [string]$folder.StoreID; folderId = [string]$folder.EntryID; name = $name }
}
function Normalize-Body([string]$body) {
    # Outlook's rich-text round trip adds spaces before line breaks. Ignore that formatting only.
    return [regex]::Replace($body.Replace("`r`n", "`n").Replace("`r", "`n"), '[ \t]+(?=\n|$)', '').TrimEnd()
}

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -notin @('list', 'connect', 'sync')) { throw '无效的日历操作。' }
    if ($null -eq [Type]::GetTypeFromProgID('Outlook.Application')) { throw '未检测到经典 Outlook。请安装并配置经典 Outlook；新版 Outlook 不提供本地同步接口。' }
    $profiles = 'HKCU:\Software\Microsoft\Office\16.0\Outlook\Profiles'
    if (!(Test-Path -LiteralPath $profiles) -or @(Get-ChildItem -LiteralPath $profiles).Count -eq 0) { throw '请先打开经典 Outlook，添加账户并完成日历配置，再重试。' }
    try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
    catch { $outlook = New-Object -ComObject Outlook.Application }
    $session = $outlook.GetNamespace('MAPI')
    if ($request.action -eq 'list') {
        $result = New-Object 'System.Collections.Generic.List[object]'
        $stores = $session.Stores
        try {
            if ($stores.Count -gt 100) { throw 'Outlook 账户数量超过本次读取上限。' }
            for ($index = 1; $index -le $stores.Count; $index++) {
                $store = $null; $folder = $null
                try {
                    $store = $stores.Item($index)
                    try { $folder = $store.GetDefaultFolder(9) } catch { continue }
                    if ($null -ne $folder -and $folder.DefaultItemType -eq 1) {
                        $result.Add((Target-Info $folder ([string]$store.DisplayName + ' / ' + [string]$folder.Name)))
                    }
                } finally { Release-Com $folder; Release-Com $store }
            }
        } finally { Release-Com $stores }
        if ($result.Count -eq 0) { throw '经典 Outlook 中未找到可用日历。请先完成账户配置。' }
        $data = @($result.ToArray())
    } elseif ($request.action -eq 'connect') {
        $parent = $null; $folders = $null; $target = $null
        try {
            $parent = $session.GetFolderFromID([string]$request.parent.folderId, [string]$request.parent.storeId)
            if ($parent.DefaultItemType -ne 1) { throw '所选位置不是 Outlook 日历。' }
            $folders = $parent.Folders
            if ($folders.Count -gt 500) { throw '该日历的子文件夹过多，请选择其他账户。' }
            $names = @{}
            for ($index = 1; $index -le $folders.Count; $index++) {
                $candidate = $null
                try {
                    $candidate = $folders.Item($index)
                    $names[[string]$candidate.Name] = $true
                    if ($candidate.DefaultItemType -eq 1 -and (Test-OwnedCalendar $candidate)) {
                        $target = $candidate; $candidate = $null; break
                    }
                } finally { Release-Com $candidate }
            }
            if ($null -eq $target) {
                $name = 'GTodo'; $suffix = 2
                while ($names.ContainsKey($name)) { $name = 'GTodo (' + $suffix + ')'; $suffix++ }
                $target = $folders.Add($name, 9)
                Initialize-CalendarMarker $target
            }
            $data = Target-Info $target ([string]$request.parent.name + ' / ' + [string]$target.Name)
        } finally { Release-Com $target; Release-Com $folders; Release-Com $parent }
    } else {
        $folder = $null; $items = $null
        try {
            $folder = $session.GetFolderFromID([string]$request.target.folderId, [string]$request.target.storeId)
            if ($folder.DefaultItemType -ne 1 -or !(Test-OwnedCalendar $folder)) { throw '目标日历的 GTodo 标记不匹配，已停止写入。请停止同步后重新选择日历。' }
            $items = $folder.Items
            $items.IncludeRecurrences = $false
            if ($items.Count -gt 100000) { throw '目标日历超过 100000 项，已停止本次同步。' }
            $known = @{}; $duplicates = @{}
            # Build a complete index before mutating anything. Unreadable markers fail closed.
            for ($index = 1; $index -le $items.Count; $index++) {
                $item = $null
                try {
                    $item = $items.Item($index)
                    if ($item.Class -ne 26 -or (Read-Property $item $ownerProperty) -ne $marker) { continue }
                    $id = Read-Property $item $taskProperty
                    if (!$id) { continue }
                    if ($known.ContainsKey($id)) { $duplicates[$id] = $true }
                    else { $known[$id] = [string]$item.EntryID }
                } finally { Release-Com $item }
            }
            $counts = @{ created = 0; updated = 0; removed = 0; unchanged = 0 }
            $failures = 0
            foreach ($record in @($request.tasks)) {
                $id = [string]$record.id
                if ($duplicates.ContainsKey($id)) { $failures++; continue }
                $item = $null; $recipients = $null
                try {
                    if ($known.ContainsKey($id)) {
                        $item = $session.GetItemFromID($known[$id], [string]$folder.StoreID)
                        # A moved/replaced item or a meeting is never touched, even if it has our tags.
                        $itemParent = $null
                        try {
                            $itemParent = $item.Parent
                            if ($itemParent.EntryID -ne $folder.EntryID -or (Read-Property $item $ownerProperty) -ne $marker -or (Read-Property $item $taskProperty) -ne $id) { throw '日程身份已改变。' }
                        } finally { Release-Com $itemParent }
                        $recipients = $item.Recipients
                        if ($item.MeetingStatus -ne 0 -or $recipients.Count -ne 0) { throw '日程已转换为会议。' }
                    }
                    if ($null -eq $record.event) {
                        if ($null -ne $item) { $item.Delete(); $counts.removed++ }
                        continue
                    }
                    $desired = $record.event
                    $start = [DateTime]::ParseExact([string]$desired.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
                    $end = $start.AddDays(1)
                    $importance = 1
                    if ($desired.important) { $importance = 2 }
                    $creating = $null -eq $item
                    if (!$creating) {
                        $isCurrent = (Read-Property $item $revisionProperty) -eq [string]$desired.revision -and
                            $item.Subject -ceq [string]$desired.subject -and
                            (Normalize-Body $item.Body) -ceq (Normalize-Body ([string]$desired.body)) -and
                            $item.AllDayEvent -and !$item.IsRecurring -and !$item.ReminderSet -and
                            $item.Start -eq $start -and $item.End -eq $end -and $item.BusyStatus -eq 0 -and $item.Importance -eq $importance
                        if ($isCurrent) { $counts.unchanged++; continue }
                    } else { $item = $items.Add('IPM.Appointment') }
                    if ($item.IsRecurring) { $item.ClearRecurrencePattern() }
                    $item.Subject = [string]$desired.subject
                    $item.Body = [string]$desired.body
                    $item.Start = $start
                    $item.End = $end
                    $item.AllDayEvent = $true
                    $item.BusyStatus = 0
                    $item.ReminderSet = $false
                    $item.Importance = $importance
                    Write-Property $item $ownerProperty $marker
                    Write-Property $item $taskProperty $id
                    Write-Property $item $revisionProperty ([string]$desired.revision)
                    $item.Save()
                    if ($creating) { $counts.created++ } else { $counts.updated++ }
                } catch { $failures++ }
                finally { Release-Com $recipients; Release-Com $item }
            }
            if ($failures -gt 0) { throw ('有 ' + $failures + ' 项未同步。请检查日历写入权限，以及重复日程或已转换为会议的 GTodo 日程，然后重试。') }
            $data = $counts
        } finally { Release-Com $items; Release-Com $folder }
    }
    [Console]::Out.Write((@{ ok = $true; data = $data } | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $message = [string]$_.Exception.Message
    if ($message.Length -gt 1500) { $message = $message.Substring(0, 1500) }
    [Console]::Out.Write((@{ ok = $false; error = $message } | ConvertTo-Json -Depth 4 -Compress))
    exit 1
} finally {
    Release-Com $session; Release-Com $outlook
    # Never call Outlook.Quit: it may be the user's open mail application.
}
