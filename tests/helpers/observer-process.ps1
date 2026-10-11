# Test-only supervisor. Put the observer in a job before releasing its startup
# gate; detached descendants inherit the job even after their parent exits.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
public sealed class ObserverJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)]
  struct Completion { public IntPtr Key, Port; }
  [StructLayout(LayoutKind.Sequential)]
  struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Minimum, Maximum;
    public uint Active;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct Counters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)]
  struct Limits {
    public Basic Basic;
    public Counters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr port, IntPtr key, uint threads);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, int size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out IntPtr key, out IntPtr data, uint timeout);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  IntPtr job, port;
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  void Configure<T>(int kind, T value) {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr data = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value, data, false); Check(SetInformationJobObject(job, kind, data, size)); }
    finally { Marshal.FreeHGlobal(data); }
  }
  public ObserverJob() {
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, IntPtr.Zero, 1); Check(port != IntPtr.Zero);
      Configure(7, new Completion { Port = port });
      // Killing the supervisor on a harness timeout must not orphan workers.
      Configure(9, new Limits { Basic = new Basic { Flags = 0x2000 } });
    } catch { Dispose(); throw; }
  }
  public void Assign(Process process) { Check(AssignProcessToJobObject(job, process.Handle)); }
  public void Wait(int milliseconds) {
    Stopwatch timer = Stopwatch.StartNew();
    while (timer.ElapsedMilliseconds < milliseconds) {
      uint message; IntPtr key, data;
      Check(GetQueuedCompletionStatus(port, out message, out key, out data,
        (uint)(milliseconds - timer.ElapsedMilliseconds)));
      if (message == 4) return; // JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
    }
    throw new TimeoutException("Observer descendants did not exit");
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
    if (port != IntPtr.Zero) { CloseHandle(port); port = IntPtr.Zero; }
  }
}
'@
$job = $null
$child = $null
$gate = $null
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  $gateName = 'Local\foom-observer-test-' + [Guid]::NewGuid().ToString('N')
  $gate = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, $gateName)
  $job = New-Object ObserverJob
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $PSHOME + '\powershell.exe'
  # Event and gate name are environment data, never interpolated PowerShell code.
  $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$gate = [System.Threading.EventWaitHandle]::OpenExisting($env:FOOM_TEST_GATE); $null = $gate.WaitOne(); $gate.Dispose(); & ./observer.ps1 $env:FOOM_TEST_EVENT"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $start.EnvironmentVariables['FOOM_TEST_GATE'] = $gateName
  $start.EnvironmentVariables['FOOM_TEST_EVENT'] = $request.event
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $child = [System.Diagnostics.Process]::Start($start)
  try { $job.Assign($child) } catch { $child.Kill(); $child.WaitForExit(); throw }
  $null = $gate.Set()
  $output = $child.StandardOutput.ReadToEndAsync()
  $errors = $child.StandardError.ReadToEndAsync()
  if ($null -ne $request.input) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$request.input)
    $child.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $child.StandardInput.Close()
  }
  if (!$child.WaitForExit($request.deadline)) { throw 'Observer parent did not exit' }
  $elapsed = $timer.ElapsedMilliseconds
  if ($child.ExitCode -ne 0) { throw ('Observer exit code: ' + $child.ExitCode) }
  # Publish the parent's result immediately, before waiting for descendants.
  [Console]::Out.WriteLine((@{ stdout = $output.GetAwaiter().GetResult(); stderr = $errors.GetAwaiter().GetResult(); elapsed = $elapsed } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  $job.Wait($request.deadline)
} catch { [Console]::Error.WriteLine($_); exit 1 }
finally {
  if ($job) { $job.Dispose() }
  if ($child) { $child.Dispose() }
  if ($gate) { $gate.Dispose() }
}
