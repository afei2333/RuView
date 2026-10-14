# Raspberry Pi Nexmon CSI bridge

`nexmon-csi-bridge.py` captures Ethernet/IPv4/UDP packets on Linux `wlan0`,
parses the BCM43455c0 Nexmon CSI profile, and sends ADR-018 frames to
`127.0.0.1:5005`. It uses Python 3.9+ and the standard library. Capture needs
root or CAP_NET_RAW; the sensing server runs as your normal user. It does not
change firmware, interfaces, channels, or routes, inject wireless traffic, or
persist captured data.

Supported input is deliberately bounded: modern 18-byte Nexmon header,
magic `0x1111`, chip identifier `0x0065`, 2.4 GHz channels 1–13 at 20 MHz,
64 interleaved little-endian int16 I/Q pairs, core 0 / spatial stream 0, and
one explicitly selected transmitter MAC. Other chips, old headers, wider
channels, fragmented IPv4, VLAN frames, and mixed radio paths are rejected.
The firmware must already be configured and generating packets on port 5500.

## Run on the Raspberry Pi

Copy the script into the Pi checkout's `scripts/` directory first. From the
checkout's `v2/` directory, stop the existing simulated server with Ctrl-C and
start the receiver in terminal 1:

```bash
./target/release/sensing-server \
  --source esp32 \
  --bind-addr 127.0.0.1 \
  --http-port 3000 \
  --ws-port 3001 \
  --udp-bind 127.0.0.1 \
  --udp-port 5005 \
  --ui-path ../ui
```

From the same `v2/` directory in terminal 2, substitute your transmitter MAC:

```bash
sudo python3 ../scripts/nexmon-csi-bridge.py \
  --interface wlan0 \
  --mac aa:bb:cc:dd:ee:ff \
  --channel 6 \
  --node-id 1
```

Use a node ID that is not used by another sender. The bridge fixes its
destination to loopback; no routable UDP bind or firewall changes are needed.
The capture uses AF_PACKET because seeing Nexmon packets in tcpdump does not
guarantee that Linux will deliver their synthetic broadcast IPs to a normal
UDP socket. Ctrl-C stops the bridge. Add `--count 20` for a bounded send check.

Every five seconds, including periods with no input, it prints cumulative
`candidates`, `forwarded`, `clipped_components`, and rejection reasons.
`forwarded` means UDP sends completed, not that the server accepted them.
`candidates=0` means no matching Ethernet/IPv4/UDP envelope was observed;
`rejected={'mac': ...}` or `chanspec` indicates a filter mismatch.

## Confirm application ingestion

```bash
curl -fsS --max-time 5 http://127.0.0.1:3000/health | python3 -m json.tool
curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/status | python3 -m json.tool
curl -fsS --max-time 5 http://127.0.0.1:3000/api/v1/sensing/latest | python3 -m json.tool
```

While packets arrive, expect `source: esp32`, `source_state: live_unverified`,
`waiting_for_frames: false`, recent `last_frame_age_ms`, increasing
`processing.udp.datagrams` and `tick`, and fresh sensing updates. Repeat after
a few seconds. Before the first frame, expect a disconnected/offline source;
simply starting with `--source esp32` is not proof of reception. After the
bridge stops and the server's timeout elapses, status should become stale or
offline. Sparse input can also make status intermittent.

## Conversion limits

- This is real Nexmon input transported through the server's existing
  ADR-018 decoder. The server labels it `esp32` because of the wire protocol;
  this does **not** identify the physical receiver as an ESP32. No server
  provenance changes are made by this script.
- Nexmon int16 components are divided by the fixed `--iq-divisor` (default
  64), rounded and saturated to int8. This is lossy. Per-frame normalization
  is intentionally avoided so temporal amplitude changes remain visible.
  Increase the divisor if retained signal components repeatedly saturate;
  keep it fixed during a capture/calibration and recalibrate after changing
  it. A larger divisor reduces clipping but increases quantization loss.
- All 64 FFT positions remain in place. DC bin 0 and guard bins 27–37 are
  zeroed in unshifted FFT order, retaining the 52 tones shared by legacy
  OFDM and HT20. Nexmon can place PHY metadata in guard bins. The four extra
  HT20 edge tones are also omitted conservatively; there is no carrier
  reordering or phase sanitization.
- RSSI is copied. The packet has no noise-floor measurement, so
  `--noise-floor -95` is an explicit assumption and affects server SNR
  features. PPDU is encoded in the HT/legacy bucket (0), flags are zero;
  no HE or mesh synchronization metadata is invented.
- ADR-018 sequence is a local monotonic uint32 send counter, not the raw
  Wi-Fi sequence-control field. It wraps at uint32 and restarts with the
  bridge. Restart the server too if a counter restart disrupts an existing
  temporal/calibration session.
- Successful parsing/ingestion is not evidence of accurate presence, pose,
  people counting, breathing, or heart-rate estimation. Those need separate
  measured hardware validation with appropriate sample rate and calibration.

Format references: [Nexmon documentation](https://github.com/seemoo-lab/nexmon_csi#analyzing-the-csi),
[Nexmon header and PHY metadata implementation](https://github.com/seemoo-lab/nexmon_csi/blob/master/src/csi_extractor.c),
and the receiver in `v2/crates/wifi-densepose-sensing-server/src/main.rs`
(`parse_esp32_frame`, `udp_receiver_task`). The source parser is authoritative
for ADR-018 field offsets; older ADR prose may be stale.

## Offline validation

From the repository root:

```bash
python3 -m unittest discover -s scripts/tests -p test_nexmon_csi_bridge.py -v
```

Tests use SYNTHETIC inputs, check malformed packets and profile filters,
fixed scaling and guard/DC masking, a mocked capture/send loop, and the
independent recorder decoder. With `rustc` installed, they also compile and
execute the current server's unmodified frame struct and I/Q parser using
stubbed external metadata types. This is parser compatibility evidence, not
a full server run or a real Linux AF_PACKET/hardware test. Hardware acceptance
requires the Pi bridge logs plus current API output from the commands above.
