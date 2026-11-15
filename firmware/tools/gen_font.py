#!/usr/bin/env python3
"""Генерує main/font_data.c з растрових шрифтів BDF (Misc Fixed, суспільне надбання).

Шрифти: https://github.com/olikraus/u8g2/tree/master/tools/font/bdf (6x10.bdf, 10x20.bdf).
Запуск: python tools/gen_font.py 6x10.bdf 10x20.bdf > main/addons/display/font_data.c
Кожен гліф записано на всю клітинку шрифту, рядками зверху вниз, (ширина+7)/8 байт на рядок, старший біт ліворуч.
"""
import sys

# Латиниця (ASCII), градус, українська і російська кирилиця, апостроф.
CODEPOINTS = (list(range(32, 127)) + [0xB0, 0xB5, 0x2019, 0x2013, 0x2014, 0x2026]
              + [0x401, 0x404, 0x406, 0x407] + list(range(0x410, 0x450)) + [0x451, 0x454, 0x456, 0x457, 0x490, 0x491])


def parse(path):
    glyphs, fbb, ascent, descent = {}, None, 0, 0
    with open(path, encoding="latin-1") as f:
        lines = iter(f.read().splitlines())
    for line in lines:
        p = line.split()
        if not p:
            continue
        if p[0] == "FONTBOUNDINGBOX":
            fbb = list(map(int, p[1:]))
        elif p[0] == "FONT_ASCENT":
            ascent = int(p[1])
        elif p[0] == "FONT_DESCENT":
            descent = int(p[1])
        elif p[0] == "STARTCHAR":
            enc, bbx, rows = None, None, []
            for line in lines:
                q = line.split()
                if q[0] == "ENCODING":
                    enc = int(q[1])
                elif q[0] == "BBX":
                    bbx = list(map(int, q[1:]))
                elif q[0] == "BITMAP":
                    for line in lines:
                        if line.startswith("ENDCHAR"):
                            break
                        rows.append((int(line, 16), len(line) * 4))
                    break
            glyphs[enc] = (bbx, rows)
    return fbb, ascent, descent, glyphs


def cell(fbb, ascent, descent, glyph):
    w, h = fbb[0], ascent + descent
    (gw, gh, gx, gy), rows = glyph
    out = [[0] * w for _ in range(h)]
    top = ascent - (gy + gh)
    for r, (bits, nbits) in enumerate(rows):
        for c in range(gw):
            if bits >> (nbits - 1 - c) & 1:
                y, x = top + r, gx + c
                if 0 <= y < h and 0 <= x < w:
                    out[y][x] = 1
    return w, h, out


def main():
    print("// Згенеровано tools/gen_font.py з шрифтів Misc Fixed (суспільне надбання). Не редагувати вручну.")
    print('#include "gfx.h"\n')
    for path in sys.argv[1:]:
        name = "font_" + path.rsplit("/", 1)[-1].split(".")[0]
        fbb, ascent, descent, glyphs = parse(path)
        cps = sorted(c for c in set(CODEPOINTS) if c in glyphs)  # відсортовано: пошук діленням навпіл
        w, h = fbb[0], ascent + descent
        bpr = (w + 7) // 8
        print(f"static const uint16_t {name}_cp[] = {{")
        print("    " + ", ".join(f"0x{c:04x}" for c in cps))
        print("};")
        print(f"static const uint8_t {name}_bits[] = {{")
        for c in cps:
            _, _, px = cell(fbb, ascent, descent, glyphs[c])
            bs = []
            for row in px:
                v = 0
                for x in range(bpr * 8):
                    v = v << 1 | (row[x] if x < w else 0)
                bs += [(v >> (8 * (bpr - 1 - i))) & 0xFF for i in range(bpr)]
            print("    " + ", ".join(f"0x{b:02x}" for b in bs) + f", // U+{c:04X}")
        print("};")
        print(f"const font_t {name} = {{ .w = {w}, .h = {h}, .bpr = {bpr}, .ascent = {ascent}, .count = {len(cps)}, "
              f".cp = {name}_cp, .bits = {name}_bits }};\n")


main()
