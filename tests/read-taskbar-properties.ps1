param([Parameter(Mandatory = $true)][long]$WindowHandle)
$ErrorActionPreference = 'Stop'

# Read only the native property store of the test window; no taskbar/pin changes.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class GTodoTaskbarProperties {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size = 24)]
  public struct PropVariant {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PropVariant value);
  public static Dictionary<string, string> Read(long handle) {
    var iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(handle), ref iid, out store));
    var result = new Dictionary<string, string>();
    var ids = new Dictionary<string, uint> { {"relaunchCommand", 2}, {"relaunchIcon", 3}, {"relaunchDisplayName", 4}, {"appId", 5} };
    try {
      foreach (var item in ids) {
        var key = new PropertyKey {format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = item.Value};
        PropVariant value;
        Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
        try {
          if (value.type != 31) throw new Exception("Unexpected property type " + value.type + " for " + item.Key);
          result[item.Key] = Marshal.PtrToStringUni(value.pointer);
        } finally { PropVariantClear(ref value); }
      }
    } finally { Marshal.ReleaseComObject(store); }
    return result;
  }
}
'@
[GTodoTaskbarProperties]::Read($WindowHandle) | ConvertTo-Json -Compress
