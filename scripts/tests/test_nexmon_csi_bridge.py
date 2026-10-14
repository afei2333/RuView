"""Offline protocol checks. Run: python3 -m unittest discover -s scripts/tests -p test_nexmon_csi_bridge.py -v"""

import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(filename):
    spec = importlib.util.spec_from_file_location(filename, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


bridge = load("nexmon-csi-bridge.py")
record = load("record-csi-udp.py")
MAC = bytes.fromhex("020000000001")


def payload(**overrides):
    values = dict(magic=0x1111, rssi=-55, fc=8, mac=MAC, sequence=0x78F0,
                  config=0, chanspec=0x1006, chip=0x65)
    values.update(overrides)
    # SYNTHETIC: one signal pair and deliberately huge guard/DC values.
    pairs = [(64, -64)] * 64
    pairs[1] = (192, 256)
    for index in bridge.NULL_BINS:
        pairs[index] = (32767, -32768)
    return struct.pack("<HbB6sHHHH", *values.values()) + b"".join(
        struct.pack("<hh", *pair) for pair in pairs)


def ethernet(data, *, options=b"", padding=b""):
    ip = bytearray(20 + len(options))
    ip[0] = 0x40 | len(ip) // 4
    struct.pack_into("!H", ip, 2, len(ip) + 8 + len(data))
    ip[9] = 17
    ip[12:20] = bytes.fromhex("0a0a0a0affffffff")
    ip[20:] = options
    udp = struct.pack("!HHHH", 5500, 5500, len(data) + 8, 0)
    return b"\xff" * 6 + b"NEXMON" + b"\x08\x00" + ip + udp + data + padding


def convert(data=None, **overrides):
    args = dict(mac=MAC, channel=6, node_id=1, sequence=123, iq_divisor=64,
                noise_floor=-95)
    args.update(overrides)
    return bridge.convert_payload(payload() if data is None else data, **args)


class BridgeTests(unittest.TestCase):
    def test_header_iq_and_independent_recorder(self):
        frame, clipped = convert()
        self.assertEqual(len(frame), 148)
        self.assertEqual(clipped, 0)
        self.assertEqual(struct.unpack_from("<IBBHIIbbBB", frame),
                         (0xC5110001, 1, 1, 64, 2437, 123, -55, -95, 0, 0))
        decoded = record.parse_csi_packet(frame)
        self.assertEqual(decoded["n_subcarriers"], 64)
        self.assertEqual(decoded["amplitudes"][1], 5.0)
        for index in bridge.NULL_BINS:
            self.assertEqual(decoded["amplitudes"][index], 0)

    def test_scaling_is_fixed_across_frames_and_saturation_counted(self):
        low = bytearray(payload())
        high = bytearray(low)
        struct.pack_into("<hh", low, 18 + 4, 64, -128)
        struct.pack_into("<hh", high, 18 + 4, 128, -256)
        self.assertEqual(struct.unpack_from("bb", convert(low)[0], 22), (1, -2))
        self.assertEqual(struct.unpack_from("bb", convert(high)[0], 22), (2, -4))
        struct.pack_into("<hh", high, 18 + 4, 32767, -32768)
        frame, clipped = convert(high)
        self.assertEqual(struct.unpack_from("bb", frame, 22), (127, -128))
        self.assertEqual(clipped, 2)

    def test_wrong_nexmon_profiles_and_lengths_rejected(self):
        for change in ({"magic": 0x1112}, {"chip": 0x66}, {"mac": b"\x03" * 6},
                       {"config": 1}, {"config": 8}, {"chanspec": 0x1001},
                       {"chanspec": 0x1806}, {"rssi": 1}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                convert(payload(**change))
        for data in (b"", payload()[:-1], payload() + b"\x00", b"\x11" * 274):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                convert(data)

    def test_ipv4_options_padding_and_truncation(self):
        packet = ethernet(payload(), options=b"\x00" * 4, padding=b"\x00" * 16)
        self.assertEqual(bridge.extract_udp(packet), payload())
        packet = ethernet(payload())
        for size in range(len(packet)):
            self.assertIsNone(bridge.extract_udp(packet[:size]))

    def test_bad_network_headers_rejected(self):
        packet = ethernet(payload())
        # EtherType, IP version/IHL, length, fragmentation, protocol, source,
        # destination, UDP source/destination port, and UDP length.
        for offset, value in ((12, b"\x86\xdd"), (14, b"\x65"), (14, b"\x44"),
                              (16, b"\x00\x10"), (20, b"\x20\x00"),
                              (20, b"\x00\x01"), (23, b"\x06"), (26, b"\x01"),
                              (30, b"\x01"), (34, b"\x00\x00"),
                              (36, b"\x00\x00"), (38, b"\x00\x07")):
            damaged = bytearray(packet)
            damaged[offset:offset + len(value)] = value
            with self.subTest(offset=offset, value=value):
                self.assertIsNone(bridge.extract_udp(damaged))

    def test_cli_rejects_invalid_operator_inputs(self):
        for flag, value in (("--mac", "aa:bb"), ("--mac", "gg:" * 5 + "gg"),
                            ("--channel", "14"), ("--node-id", "256"),
                            ("--port", "0"), ("--iq-divisor", "nan"),
                            ("--iq-divisor", "inf"), ("--iq-divisor", "0.01"),
                            ("--noise-floor", "-129"), ("--count", "-1")):
            with self.subTest(flag=flag, value=value), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    bridge.parse_args(["--mac", "02:00:00:00:00:01", flag, value])

    def test_capture_loop_sends_only_matching_frames_with_monotonic_sequence(self):
        args = bridge.parse_args(["--mac", "02:00:00:00:00:01", "--count", "2"])
        packets = iter([ethernet(payload(mac=b"\x03" * 6)),
                        ethernet(payload(sequence=65535)), ethernet(payload(sequence=0))])
        sent = []

        class FakeSocket:
            def __enter__(self):
                return self

            def __exit__(self, *unused):
                pass

            def bind(self, address):
                assert address == ("wlan0", 0)

            def settimeout(self, timeout):
                pass

            def recv(self, size):
                return next(packets)

            def sendto(self, data, address):
                sent.append((data, address))

        with patch.object(socket, "AF_PACKET", 17, create=True), \
                patch.object(socket, "socket", return_value=FakeSocket()), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            bridge.run(args)
        self.assertEqual(len(sent), 2)
        self.assertEqual([struct.unpack_from("<I", frame, 12)[0] for frame, _ in sent], [0, 1])
        self.assertTrue(all(address == ("127.0.0.1", 5005) for _, address in sent))
        self.assertIn("forwarded=2", output.getvalue())
        self.assertIn("'mac': 1", output.getvalue())

    @unittest.skipUnless(shutil.which("rustc"), "rustc is needed for server parser compatibility")
    def test_output_accepted_by_exact_sensing_server_parser(self):
        source = (ROOT / "v2/crates/wifi-densepose-sensing-server/src/main.rs").read_text()
        parser = source.split("fn parse_esp32_frame(buf: &[u8])", 1)[1].split("\n#[cfg(test)]", 1)[0]
        fields = source.split("struct Esp32Frame {", 1)[1].split("\n}", 1)[0]
        # Keep the server's frame struct and I/Q parser verbatim. Only external
        # metadata wrappers are stubbed to avoid unrelated workspace dependencies.
        harness = """
mod wifi_densepose_hardware {
    #[derive(Debug)] pub struct PpduType(u8);
    impl PpduType { pub fn from_byte(v: u8) -> Self { Self(v) } }
    #[derive(Debug)] pub struct Adr018Flags(u8);
    impl Adr018Flags { pub fn from_byte(v: u8) -> Self { Self(v) } }
}
""" + "struct Esp32Frame {" + fields + "\n}\nfn parse_esp32_frame(buf: &[u8])" + parser + """
fn main() {
    let data = std::fs::read(std::env::args().nth(1).unwrap()).unwrap();
    let f = parse_esp32_frame(&data).expect("bridge output must parse");
    assert_eq!((f.node_id, f.n_antennas, f.n_subcarriers, f.freq_mhz, f.sequence),
               (1, 1, 64, 2437, 123));
    assert_eq!((f.rssi, f.noise_floor), (-55, -95));
    assert_eq!(f.amplitudes.len(), 64);
    assert_eq!(f.amplitudes[1], 5.0);
    assert!((f.phases[1] - 4.0f64.atan2(3.0)).abs() < 1e-12);
    assert!(parse_esp32_frame(&data[..147]).is_none());
}
"""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "parser.rs").write_text(harness)
            (path / "frame.bin").write_bytes(convert()[0])
            subprocess.run(["rustc", "--edition=2021", "-A", "warnings", str(path / "parser.rs"),
                            "-o", str(path / "parser")], check=True, capture_output=True)
            subprocess.run([str(path / "parser"), str(path / "frame.bin")], check=True)


if __name__ == "__main__":
    unittest.main()
