using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace SwMcp
{
    /// <summary>Thin JSON helpers over JavaScriptSerializer (the only serializer
    /// available to a bare csc build on this machine).</summary>
    static class Json
    {
        static readonly JavaScriptSerializer Ser = Create();

        static JavaScriptSerializer Create()
        {
            JavaScriptSerializer s = new JavaScriptSerializer();
            s.MaxJsonLength = 64 * 1024 * 1024;
            s.RecursionLimit = 200;
            return s;
        }

        public static string S(object o)
        {
            return Ser.Serialize(o);
        }

        public static Dictionary<string, object> ParseObject(string text)
        {
            Dictionary<string, object> d = Ser.Deserialize<Dictionary<string, object>>(text);
            return d;
        }

        public static Dictionary<string, object> Obj(object o)
        {
            return o as Dictionary<string, object>;
        }

        /// <summary>Reads a list as an ArrayList. Accepts both the ArrayList that
        /// deserialization produces and the typed lists built in-process, so a
        /// vector created here and a vector parsed from JSON behave identically.</summary>
        public static ArrayList Arr(object o)
        {
            if (o == null || o is string) return null;
            ArrayList a = o as ArrayList;
            if (a != null) return a;
            IList list = o as IList;
            if (list == null) return null;
            ArrayList copy = new ArrayList(list.Count);
            foreach (object x in list) copy.Add(x);
            return copy;
        }

        public static IEnumerable<object> Items(object o)
        {
            ArrayList a = Arr(o);
            if (a == null) yield break;
            foreach (object x in a) yield return x;
        }

        public static string Str(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return null;
            return Convert.ToString(d[key], CultureInfo.InvariantCulture);
        }

        public static string Str(Dictionary<string, object> d, string key, string fallback)
        {
            string v = Str(d, key);
            return v == null ? fallback : v;
        }

        public static double Dbl(Dictionary<string, object> d, string key, double fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            return ToDouble(d[key], fallback);
        }

        public static double ToDouble(object v, double fallback)
        {
            if (v == null) return fallback;
            if (v is double) return (double)v;
            if (v is int) return (int)v;
            if (v is long) return (long)v;
            if (v is decimal) return (double)(decimal)v;
            string s = Convert.ToString(v, CultureInfo.InvariantCulture);
            double r;
            if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out r)) return r;
            return fallback;
        }

        public static int Int(Dictionary<string, object> d, string key, int fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            return (int)Math.Round(ToDouble(d[key], fallback));
        }

        public static bool Bool(Dictionary<string, object> d, string key, bool fallback)
        {
            if (d == null || !d.ContainsKey(key) || d[key] == null) return fallback;
            object v = d[key];
            if (v is bool) return (bool)v;
            string s = Convert.ToString(v, CultureInfo.InvariantCulture);
            return string.Equals(s, "true", StringComparison.OrdinalIgnoreCase);
        }

        public static Dictionary<string, object> Dict(params object[] kv)
        {
            Dictionary<string, object> d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2)
                d[Convert.ToString(kv[i], CultureInfo.InvariantCulture)] = kv[i + 1];
            return d;
        }

        public static List<object> List(params object[] items)
        {
            return new List<object>(items);
        }

        public static string Num(double v)
        {
            // stable, compact, invariant
            double rounded = Math.Round(v, 6);
            return rounded.ToString("0.######", CultureInfo.InvariantCulture);
        }

        /// <summary>Same rounding as <see cref="Num"/>, but as a real number.
        ///
        /// Num returns text because it is used to build SOLIDWORKS equation
        /// strings; using it for JSON payloads made every measurement arrive as a
        /// quoted string, which quietly breaks arithmetic on the client side.</summary>
        public static double R(double v)
        {
            double rounded = Math.Round(v, 6);
            if (rounded == 0) return 0;     // normalise -0
            return rounded;
        }
    }

    /// <summary>Recursive-descent evaluator for the small arithmetic subset the
    /// design DSL uses: numbers, dotted parameter names, + - * / and parens.</summary>
    sealed class Expr
    {
        readonly string _src;
        readonly IDictionary<string, double> _vars;
        int _pos;

        Expr(string src, IDictionary<string, double> vars)
        {
            _src = src;
            _vars = vars;
            _pos = 0;
        }

        public static double Eval(string src, IDictionary<string, double> vars)
        {
            Expr e = new Expr(src, vars);
            double v = e.ParseSum();
            e.SkipWs();
            if (e._pos < e._src.Length)
                throw new BridgeError("BAD_EXPRESSION", "unexpected '" + e._src.Substring(e._pos) + "' in expression \"" + src + "\"");
            return v;
        }

        public static bool IsNumericLiteral(string src)
        {
            double r;
            return double.TryParse(src, NumberStyles.Float, CultureInfo.InvariantCulture, out r);
        }

        void SkipWs()
        {
            while (_pos < _src.Length && char.IsWhiteSpace(_src[_pos])) _pos++;
        }

        bool Take(char c)
        {
            SkipWs();
            if (_pos < _src.Length && _src[_pos] == c) { _pos++; return true; }
            return false;
        }

        double ParseSum()
        {
            double v = ParseProduct();
            while (true)
            {
                if (Take('+')) v += ParseProduct();
                else if (Take('-')) v -= ParseProduct();
                else return v;
            }
        }

        double ParseProduct()
        {
            double v = ParseUnary();
            while (true)
            {
                if (Take('*')) v *= ParseUnary();
                else if (Take('/')) v /= ParseUnary();
                else return v;
            }
        }

        double ParseUnary()
        {
            if (Take('-')) return -ParseUnary();
            if (Take('+')) return ParseUnary();
            return ParseAtom();
        }

        double ParseAtom()
        {
            SkipWs();
            if (_pos >= _src.Length)
                throw new BridgeError("BAD_EXPRESSION", "unexpected end of expression \"" + _src + "\"");
            if (Take('('))
            {
                double v = ParseSum();
                if (!Take(')'))
                    throw new BridgeError("BAD_EXPRESSION", "missing ')' in \"" + _src + "\"");
                return v;
            }
            char c = _src[_pos];
            if (char.IsDigit(c) || c == '.')
            {
                int start = _pos;
                while (_pos < _src.Length && (char.IsDigit(_src[_pos]) || _src[_pos] == '.')) _pos++;
                string lit = _src.Substring(start, _pos - start);
                double v;
                if (!double.TryParse(lit, NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                    throw new BridgeError("BAD_EXPRESSION", "bad number \"" + lit + "\" in \"" + _src + "\"");
                return v;
            }
            if (char.IsLetter(c) || c == '_')
            {
                int start = _pos;
                while (_pos < _src.Length && (char.IsLetterOrDigit(_src[_pos]) || _src[_pos] == '_' || _src[_pos] == '.')) _pos++;
                string name = _src.Substring(start, _pos - start);
                if (_vars == null || !_vars.ContainsKey(name))
                    throw new BridgeError("UNKNOWN_PARAM", "unknown parameter \"" + name + "\" in expression \"" + _src + "\"");
                return _vars[name];
            }
            throw new BridgeError("BAD_EXPRESSION", "unexpected '" + c + "' in \"" + _src + "\"");
        }
    }

    /// <summary>Carries a machine-readable error code out of the operation layer.</summary>
    sealed class BridgeError : Exception
    {
        public readonly string Code;
        public readonly Dictionary<string, object> Detail;

        /// <summary>Named step that had already completed when this failure
        /// surfaced; lets the caller resume instead of replaying.</summary>
        public string LastCompletedStep { get; set; }

        public BridgeError(string code, string message) : base(message)
        {
            Code = code;
            Detail = new Dictionary<string, object>();
        }

        public BridgeError(string code, string message, Dictionary<string, object> detail) : base(message)
        {
            Code = code;
            Detail = detail ?? new Dictionary<string, object>();
        }

        public BridgeError At(string step)
        {
            LastCompletedStep = step;
            return this;
        }
    }
}
