using System;
using System.Text;

namespace SwMcp
{
    /// <summary>Persistent references travel through JSON, so they are hex text.
    /// Parsing is written out rather than using Convert.ToByte: the built-in one
    /// throws FormatException with a message that says nothing about which
    /// argument was wrong, and the caller ends up with INTERNAL_ERROR instead of
    /// "that id is not hex".</summary>
    static class Hex
    {
        public static byte[] ToBytes(string hex)
        {
            if (string.IsNullOrEmpty(hex) || hex.Length % 2 != 0)
                throw new BridgeError("BAD_ARGUMENT", "persistent id must be an even-length hex string",
                    Json.Dict("length", hex == null ? 0 : hex.Length));

            byte[] bytes = new byte[hex.Length / 2];
            for (int i = 0; i < bytes.Length; i++)
            {
                int hi = Digit(hex[i * 2]);
                int lo = Digit(hex[i * 2 + 1]);
                if (hi < 0 || lo < 0)
                    throw new BridgeError("BAD_ARGUMENT", "persistent id contains a non-hex character",
                        Json.Dict("at", i * 2, "character", hex[i * 2].ToString()));
                bytes[i] = (byte)((hi << 4) | lo);
            }
            return bytes;
        }

        public static string FromBytes(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) return null;
            StringBuilder text = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) text.Append(b.ToString("x2"));
            return text.ToString();
        }

        static int Digit(char c)
        {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        }
    }
}
