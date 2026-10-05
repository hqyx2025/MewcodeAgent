// Keep the shell and its descendants in a Windows Job Object. The OS closes
// this non-inheritable handle on shell exit, including forced termination.
export const windowsJobPrelude = `
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace MewCode {
  public static class ProcessJob {
    private static IntPtr job;
    [StructLayout(LayoutKind.Sequential)] private struct Basic {
      public long ProcessTime, JobTime;
      public uint Flags;
      public UIntPtr MinWorkingSet, MaxWorkingSet;
      public uint ActiveProcesses;
      public UIntPtr Affinity;
      public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IO {
      public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] private struct Extended {
      public Basic Basic;
      public IO IO;
      public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    public static void Bind() {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      Extended info = new Extended();
      info.Basic.Flags = 0x2000;
      if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@ -ErrorAction Stop
[MewCode.ProcessJob]::Bind()
`;
