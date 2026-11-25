using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace SwMcp
{
    /// <summary>Entry point. All interop types are referenced only from
    /// <see cref="Program.Handle"/>, never from Main, so the JIT resolves the
    /// SolidWorks assemblies after the resolver is installed.</summary>
    static class Program
    {
        const string NewLine = "\n";

        [STAThread]
        static int Main(string[] args)
        {
            ConfigureResolvers();
            // --no-attach：只读枚举模式。探针（brokerd probeBridge）用它，保证一次健康
            // 探测不可能连上任何 SOLIDWORKS 实例。必须能在 Main 里无 COM 地解析出来。
            SwHost.NoAttach = Array.IndexOf(args, "--no-attach") >= 0;
            int instanceIndex = Array.IndexOf(args, "--instance");
            if (instanceIndex >= 0 && instanceIndex + 1 < args.Length)
            {
                int pid;
                if (int.TryParse(args[instanceIndex + 1], out pid) && pid > 0)
                    SwHost.ExpectedPid = pid;
            }
            // 两者同时给出是自相矛盾的请求：宁可拒绝，也不要猜调用方想要哪个。
            if (SwHost.NoAttach && SwHost.ExpectedPid != 0)
            {
                Console.Error.WriteLine("--no-attach and --instance are mutually exclusive");
                return 2;
            }
            if (Array.IndexOf(args, "--worker") >= 0) return RunWorker(args);
            return Run(args);
        }

        /// <summary>STA worker with a message pump.
        ///
        /// A line loop on the main thread has no pump: modal dialogs opened by
        /// SOLIDWORKS never get their messages dispatched, and a long rebuild can
        /// leave the process unable to answer the next request. In worker mode the
        /// main thread runs Application.Run on a hidden form and every request is
        /// marshalled onto it with BeginInvoke, so COM calls are serialized on one
        /// STA thread while the reader thread keeps draining stdin.
        ///
        /// Requests are queued in arrival order by BeginInvoke; a request that
        /// arrives while another is running waits, which is exactly the
        /// "one instance, one call at a time" rule.</summary>
        static int RunWorker(string[] args)
        {
            System.Text.UTF8Encoding utf8 = new System.Text.UTF8Encoding(false);
            System.IO.StreamReader reader = new System.IO.StreamReader(
                Console.OpenStandardInput(), utf8, false);
            System.IO.StreamWriter writer = new System.IO.StreamWriter(
                Console.OpenStandardOutput(), utf8);
            writer.AutoFlush = false;
            object writeLock = new object();

            Form form = new Form();
            form.Text = "sw-mcp worker";
            form.ShowInTaskbar = false;
            form.FormBorderStyle = FormBorderStyle.None;
            form.WindowState = FormWindowState.Minimized;
            form.Opacity = 0;
            form.Show();
            IntPtr handle = form.Handle;   // force creation before the reader posts

            Thread readerThread = new Thread(delegate()
            {
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Trim().Length == 0) continue;
                    string copy = line;
                    try
                    {
                        form.BeginInvoke(new Action(delegate()
                        {
                            try
                            {
                                string output = Process(copy);
                                lock (writeLock)
                                {
                                    writer.Write(output);
                                    writer.Flush();
                                }
                            }
                            catch (Exception ex)
                            {
                                lock (writeLock)
                                {
                                    writer.Write(Json.S(Failure("unknown", "WORKER_WRITE_FAILED",
                                        ex.GetType().Name + ": " + ex.Message, null, null)) + NewLine);
                                    writer.Flush();
                                }
                            }
                        }));
                    }
                    catch (Exception) { break; }
                }
                try { form.BeginInvoke(new Action(delegate() { form.Close(); })); }
                catch (Exception) { }
            });
            readerThread.IsBackground = true;
            readerThread.Name = "sw-mcp-stdin";
            readerThread.Start();

            Application.Run(form);
            return 0;
        }

        static void ConfigureResolvers()
        {
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
            {
                string simple = new System.Reflection.AssemblyName(e.Name).Name;
                string candidate = System.IO.Path.Combine(SwHost.InstallDir, simple + ".dll");
                if (System.IO.File.Exists(candidate))
                    return System.Reflection.Assembly.LoadFrom(candidate);
                return null;
            };
        }

        /// <summary>Serves requests until stdin closes.
        ///
        /// One process per request would mean one COM attach per request, and the
        /// attach dominates the cost; a line loop keeps the process warm. The
        /// protocol is deliberately trivial: one JSON object per line in, one JSON
        /// object per line out, both UTF-8. A request may carry an "id" which is
        /// echoed back so a client multiplexing several calls can match them up.
        ///
        /// The encoding is decided here rather than by the console. Without it the
        /// reader takes the console code page (GBK on a Chinese Windows) and turns
        /// every non-ASCII path into mojibake, so saving a part silently writes it
        /// to a directory spelled with the wrong characters.
        /// </summary>
        static int Run(string[] args)
        {
            System.Text.UTF8Encoding utf8 = new System.Text.UTF8Encoding(false);

            System.IO.Stream stdin = Console.OpenStandardInput();
            System.IO.StreamReader reader = new System.IO.StreamReader(stdin, utf8, false);
            System.IO.StreamWriter writer = new System.IO.StreamWriter(
                Console.OpenStandardOutput(), utf8);
            writer.AutoFlush = false;

            string line;
            while ((line = reader.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                writer.Write(Process(line));
                writer.Flush();
            }
            return 0;   // transport always succeeds; the payload carries the outcome
        }

        static string Process(string line)
        {
            Dictionary<string, object> response = Handle(line);
            return Json.S(response) + NewLine;
        }

        /// <summary>Runs one request. Never throws: a transport that dies on a bad
        /// request would take the whole session with it.</summary>
        static Dictionary<string, object> Handle(string line)
        {
            Dictionary<string, object> response;
            string op = "unknown";
            object id = null;
            try
            {
                Dictionary<string, object> req = Json.ParseObject(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                op = Json.Str(req, "op", "");
                response = new Operations().Dispatch(op, req);
                response["ok"] = true;
                response["op"] = op;
            }
            catch (BridgeError be)
            {
                response = Failure(op, be.Code, be.Message, be.Detail, be.LastCompletedStep);
            }
            catch (COMException ce)
            {
                // COM 失败时才去问窗口状态：如果确实有对话框，就把错误说成
                // SW_BLOCKED_BY_DIALOG 并带上对话框标题；否则老实报 COM 错误。
                // 反过来（先看窗口再调用）会把「正在重建」误判成「弹着对话框」。
                SwWindows windows = SwWindows.Probe(SwHost.LastKnownProcessId);
                string code = windows.Blocking ? "SW_BLOCKED_BY_DIALOG" : "SW_COM_ERROR";
                string message = windows.Blocking
                    ? "SOLIDWORKS 有对话框挡着：「" + windows.BlockingTitle + "」。"
                      + "请在 SOLIDWORKS 窗口里点掉它再重试；这个桥接器不会替你点按钮。"
                    : "SOLIDWORKS COM call failed: " + ce.Message;
                response = Failure(op, code, message,
                    Json.Dict("hresult", "0x" + ce.HResult.ToString("X8"), "windows", windows.ToDict()), null);
            }
            catch (Exception ex)
            {
                string stack = ex.StackTrace == null
                    ? ""
                    : NewLine + string.Join(NewLine, FirstLines(ex.StackTrace, 6));
                response = Failure(op, "INTERNAL_ERROR",
                    ex.GetType().Name + ": " + ex.Message + stack, null, null);
            }
            if (id != null) response["id"] = id;
            return response;
        }

        static string[] FirstLines(string text, int count)
        {
            string[] parts = text.Split('\n');
            string[] result = new string[Math.Min(count, parts.Length)];
            Array.Copy(parts, result, result.Length);
            return result;
        }

        static Dictionary<string, object> Failure(string op, string code, string message,
            Dictionary<string, object> detail, string lastCompletedStep)
        {
            Dictionary<string, object> error = Json.Dict(
                "code", code,
                "message", message,
                "detail", detail ?? new Dictionary<string, object>());
            if (lastCompletedStep != null) error["lastCompletedStep"] = lastCompletedStep;
            return Json.Dict("ok", false, "op", op, "error", error);
        }
    }
}
