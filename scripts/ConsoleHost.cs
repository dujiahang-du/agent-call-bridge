// Windows PowerShell compiles this locally with its built-in .NET Framework.
// The Job handle belongs only to this launcher, never to the browser or child.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class AcbConsoleHost : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTime, PerJobUserTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    delegate bool Handler(uint control);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

    public static string[] ParseArguments(string command)
    {
        int count;
        IntPtr memory = CommandLineToArgvW(command, out count);
        if (memory == IntPtr.Zero) throw new Win32Exception();
        try {
            var result = new string[count];
            for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
            return result;
        } finally { LocalFree(memory); }
    }

    readonly object gate = new object();
    readonly Handler handler;
    IntPtr job;
    Process child;
    int stopped;
    bool disposed;
    public int Pid { get { return child.Id; } }
    public long ConsoleWindow { get { return GetConsoleWindow().ToInt64(); } }
    public bool HasExited { get { return child.HasExited; } }
    public bool StopRequested { get { return Volatile.Read(ref stopped) != 0; } }
    public int ExitCode { get { return child.ExitCode; } }

    public AcbConsoleHost(string node, string entry, string root, string data)
    {
        handler = HandleControl;
        try {
            // Null security attributes make the unnamed handle non-inheritable.
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
            lock (gate) {
                if (!SetConsoleCtrlHandler(handler, true)) throw new Win32Exception();
                var info = new ProcessStartInfo(node, "\"" + entry + "\"") {
                    WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                };
                info.EnvironmentVariables["ACB_DATA_DIR"] = data;
                child = new Process { StartInfo = info };
                child.Start();
                if (!AssignProcessToJobObject(job, child.Handle)) {
                    child.Kill();
                    throw new Win32Exception();
                }
                // Copy logs to private files asynchronously; never print raw errors or credentials.
                var stdout = new FileStream(Path.Combine(data, "server.stdout.log"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
                var stderr = new FileStream(Path.Combine(data, "server.stderr.log"), FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
                child.StandardOutput.BaseStream.CopyToAsync(stdout).ContinueWith(t => stdout.Dispose());
                child.StandardError.BaseStream.CopyToAsync(stderr).ContinueWith(t => stderr.Dispose());
                child.StandardInput.WriteLine("ACB_START");
                child.StandardInput.Flush();
            }
        } catch { Dispose(); throw; }
    }

    bool HandleControl(uint control)
    {
        if (control > 2 && control != 5 && control != 6) return false;
        // CTRL_CLOSE has a short OS deadline. Do not rely on PowerShell finally.
        Stop(3000);
        return true;
    }

    public void Stop(int graceMilliseconds)
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        lock (gate) {
            try {
                if (child != null && !child.HasExited) {
                    child.StandardInput.WriteLine("ACB_STOP");
                    child.StandardInput.Flush();
                    child.WaitForExit(graceMilliseconds);
                }
            } catch { /* Closing the owned job is the final containment boundary. */ }
            finally {
                if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            }
        }
    }

    public void Wait() { child.WaitForExit(); }
    public void Dispose()
    {
        Stop(3000);
        lock (gate) {
            if (disposed) return;
            disposed = true;
            SetConsoleCtrlHandler(handler, false);
            if (child != null) child.Dispose();
        }
        GC.KeepAlive(handler);
    }
}
