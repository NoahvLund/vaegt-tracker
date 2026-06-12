"""Generate simple PNG app icons using only the Python stdlib (zlib).
Draws a scale/dashboard-style icon on a dark rounded background.
"""
import struct
import zlib


def png(width, height, pixels):
    """pixels: list of (r,g,b,a) rows -> bytes PNG."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def build(size):
    bg = (15, 23, 42, 255)        # slate-900
    accent = (56, 189, 248, 255)  # sky-400
    accent2 = (129, 140, 248, 255)
    radius = size * 0.22

    cx = size / 2
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            # rounded-rect mask
            dx = max(radius - x, x - (size - radius), 0)
            dy = max(radius - y, y - (size - radius), 0)
            outside = (dx * dx + dy * dy) > radius * radius
            px = (0, 0, 0, 0) if outside else bg

            if not outside:
                # gauge arc (a ring segment near center)
                ddx = x - cx
                ddy = y - cx
                dist = (ddx * ddx + ddy * ddy) ** 0.5
                ring_r = size * 0.30
                if abs(dist - ring_r) < size * 0.045 and ddy < size * 0.06:
                    px = accent
                # needle
                # line from center up-right
                t = (x - cx) - (-(y - cx)) * 0.6
                if abs((y - cx) + (x - cx) * 0.7) < size * 0.03 and dist < ring_r and ddy < 0:
                    px = accent2
                # center dot
                if dist < size * 0.05:
                    px = accent2
            row.append(px)
        rows.append(row)
    return png(size, size, rows)


for sz, name in [(180, "icon-180.png"), (192, "icon-192.png"), (512, "icon-512.png")]:
    data = build(sz)
    with open(f"icons/{name}", "wb") as f:
        f.write(data)
    print(f"wrote icons/{name} ({len(data)} bytes)")
