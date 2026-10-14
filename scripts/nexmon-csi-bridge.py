#!/usr/bin/env python3
"""Bridge BCM43455c0 Nexmon 20 MHz CSI to RuView's ADR-018 UDP format.

Linux/Python 3.9+, standard library only; needs root or CAP_NET_RAW to capture.
No firmware changes, packet injection, or raw data persistence.
See scripts/nexmon-csi-bridge.md for usage and conversion limitations.
"""

import argparse
from collections import Counter
import math
import socket
import struct
import sys
import time


NEXMON_HEADER = struct.Struct("<HbB6sHHHH")
ADR018_HEADER = struct.Struct("<IBBHIIbbBB")
# Common active 20 MHz OFDM tones: -26..-1 and +1..+26, unshifted FFT.
# Guard/DC bins can contain arbitrary values, including Nexmon PHY metadata.
NULL_BINS = {0, *range(27, 38)}


def extract_udp(packet: bytes):
    """Return a complete Nexmon UDP payload from an Ethernet/IPv4 frame."""
    if len(packet) < 42 or packet[12:14] != b"\x08\x00":
        return None
    ip = packet[14:]
    ihl = (ip[0] & 15) * 4
    total = struct.unpack_from("!H", ip, 2)[0]
    fragments = struct.unpack_from("!H", ip, 6)[0]
    if (ip[0] >> 4 != 4 or ihl < 20 or total < ihl + 8
            or len(ip) < total or fragments & 0x3FFF or ip[9] != 17):
        return None
    if ip[12:20] != b"\x0a\x0a\x0a\x0a\xff\xff\xff\xff":
        return None
    source, dest, length, _ = struct.unpack_from("!HHHH", ip, ihl)
    if source != 5500 or dest != 5500 or length != total - ihl:
        return None
    return ip[ihl + 8:total]


def convert_payload(payload: bytes, *, mac: bytes, channel: int, node_id: int,
                    sequence: int, iq_divisor: float, noise_floor: int):
    """Return (ADR-018 bytes, clipped component count); reject other profiles."""
    if len(payload) != NEXMON_HEADER.size + 64 * 4:
        raise ValueError("length")
    magic, rssi, _, source_mac, _, config, chanspec, chip = NEXMON_HEADER.unpack_from(payload)
    if magic != 0x1111:
        raise ValueError("magic")
    if chip != 0x0065:  # BCM43455c0 identifier in the supported capture profile
        raise ValueError("chip")
    if source_mac != mac:
        raise ValueError("mac")
    if config != 0:  # core 0, spatial stream 0; never mix radio paths
        raise ValueError("core_stream")
    if chanspec != (0x1000 | channel):  # 2.4 GHz / 20 MHz / no sideband
        raise ValueError("chanspec")
    if not -128 <= rssi <= 0:
        raise ValueError("rssi")

    iq = bytearray()
    clipped = 0
    for index, (real, imag) in enumerate(struct.iter_unpack("<hh", payload[18:])):
        for component in (real, imag):
            value = 0 if index in NULL_BINS else round(component / iq_divisor)
            clipped += int(value < -128 or value > 127)
            iq.append(max(-128, min(127, value)) & 255)
    # Noise is an operator assumption; PPDU 0 is the HT/legacy bucket.
    # No HE or IEEE 802.15.4 synchronization metadata is claimed.
    header = ADR018_HEADER.pack(0xC5110001, node_id, 1, 64, 2407 + 5 * channel,
                               sequence, rssi, noise_floor, 0, 0)
    return header + iq, clipped


def parse_mac(value: str) -> bytes:
    parts = value.split(":")
    try:
        if len(parts) != 6 or any(len(part) != 2 for part in parts):
            raise ValueError
        return bytes(int(part, 16) for part in parts)
    except ValueError:
        raise argparse.ArgumentTypeError("expected six hex octets, e.g. aa:bb:cc:dd:ee:ff") from None


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", default="wlan0")
    parser.add_argument("--mac", type=parse_mac, required=True, help="one transmitter MAC")
    parser.add_argument("--channel", type=int, choices=range(1, 14), default=6)
    parser.add_argument("--node-id", type=int, default=1, help="unused RuView node ID")
    parser.add_argument("--port", type=int, default=5005, help="127.0.0.1 destination port")
    parser.add_argument("--iq-divisor", type=float, default=64.0, help="fixed int16-to-int8 divisor")
    parser.add_argument("--noise-floor", type=int, default=-95, help="assumed dBm, not measured")
    parser.add_argument("--count", type=int, default=0, help="stop after N sends; 0 runs until Ctrl-C")
    args = parser.parse_args(argv)
    if not 1 <= args.node_id <= 255:
        parser.error("--node-id must be 1..255")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be 1..65535")
    if not math.isfinite(args.iq_divisor) or args.iq_divisor < 1:
        parser.error("--iq-divisor must be finite and >= 1")
    if not -128 <= args.noise_floor <= 0:
        parser.error("--noise-floor must be -128..0")
    if args.count < 0:
        parser.error("--count must be >= 0")
    return args


def run(args) -> None:
    if not hasattr(socket, "AF_PACKET"):
        raise RuntimeError("live capture requires Linux (run on the Raspberry Pi)")
    destination = ("127.0.0.1", args.port)
    with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0800)) as rx:
        rx.bind((args.interface, 0))
        rx.settimeout(1.0)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as tx:
            sent = candidates = clipped = 0
            rejected = Counter()
            last_report = time.monotonic()
            print(f"[bridge] {args.interface} MAC={args.mac.hex(':')} channel={args.channel} "
                  f"core=0 stream=0 -> {destination[0]}:{destination[1]} node={args.node_id}", flush=True)
            print(f"[bridge] divisor={args.iq_divisor} assumed_noise={args.noise_floor}dBm; "
                  "64 bins, 52 common OFDM tones retained; server labels ADR-018 as esp32", flush=True)

            def report():
                print(f"[bridge] candidates={candidates} forwarded={sent} "
                      f"clipped_components={clipped} rejected={dict(rejected)}", flush=True)

            try:
                while not args.count or sent < args.count:
                    try:
                        packet = rx.recv(65535)
                    except socket.timeout:
                        packet = b""
                    payload = extract_udp(packet)
                    if payload is not None:
                        candidates += 1
                        try:
                            frame, saturated = convert_payload(
                                payload, mac=args.mac, channel=args.channel, node_id=args.node_id,
                                sequence=sent & 0xFFFFFFFF, iq_divisor=args.iq_divisor,
                                noise_floor=args.noise_floor,
                            )
                        except ValueError as error:
                            rejected[str(error)] += 1
                        else:
                            tx.sendto(frame, destination)
                            sent += 1
                            clipped += saturated
                    now = time.monotonic()
                    if now - last_report >= 5:
                        report()
                        last_report = now
            except KeyboardInterrupt:
                pass
            finally:
                report()


def main() -> int:
    args = parse_args()
    try:
        run(args)
    except (OSError, RuntimeError) as error:
        print(f"[bridge] error: {error}", file=sys.stderr)
        if isinstance(error, PermissionError):
            print("[bridge] capture needs sudo or CAP_NET_RAW", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
