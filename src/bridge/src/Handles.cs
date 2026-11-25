using System;
using System.Collections.Generic;

namespace SwMcp
{
    /// <summary>Session-scoped handles for live COM objects.
    ///
    /// The model cannot hold a COM pointer, and returning one by value would be
    /// both unserialisable and unsafe. A handle is an opaque name for an object
    /// this bridge already owns; it stays valid until released or evicted.
    /// Handles are deliberately process-local: a restarted worker invalidates
    /// every one of them, and that is the correct behaviour.</summary>
    static class Handles
    {
        const int MaxHandles = 512;
        static readonly Dictionary<string, object> ById = new Dictionary<string, object>(StringComparer.Ordinal);
        static readonly List<string> Order = new List<string>();
        static int _next;

        public static string Register(object value, string kind)
        {
            if (value == null) return null;
            lock (ById)
            {
                string id = "obj_" + (++_next).ToString();
                ById[id] = value;
                Order.Add(id);
                while (Order.Count > MaxHandles)
                {
                    string oldest = Order[0];
                    Order.RemoveAt(0);
                    ById.Remove(oldest);
                }
                return id;
            }
        }

        public static object Get(string id)
        {
            if (string.IsNullOrEmpty(id)) return null;
            lock (ById)
            {
                object value;
                return ById.TryGetValue(id, out value) ? value : null;
            }
        }

        public static object Require(string id)
        {
            object value = Get(id);
            if (value == null)
                throw new BridgeError("HANDLE_NOT_FOUND",
                    "no live object for handle \"" + id + "\" (worker restarted or handle released)",
                    Json.Dict("handle", id, "live", List()));
            return value;
        }

        public static bool Release(string id)
        {
            lock (ById)
            {
                if (!ById.Remove(id)) return false;
                Order.Remove(id);
                return true;
            }
        }

        public static List<object> List()
        {
            List<object> items = new List<object>();
            lock (ById)
            {
                foreach (string id in Order)
                {
                    object value = ById[id];
                    items.Add(Json.Dict("handle", id, "type", value == null ? null : value.GetType().Name));
                }
            }
            return items;
        }

        public static void Clear()
        {
            lock (ById)
            {
                ById.Clear();
                Order.Clear();
            }
        }
    }
}
