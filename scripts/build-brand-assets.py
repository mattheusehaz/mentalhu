#!/usr/bin/env python3
"""Rebuild MENTÁL.hu's share card and icons from its existing logo and fonts.

Development-only dependencies: Pillow, fonttools, brotli, cairosvg.
No additional runtime dependencies are needed by the website.
"""

from io import BytesIO
from pathlib import Path
import re

import cairosvg
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
INK = "#183c33"
PAPER = "#fafbf7"
PEACH = "#edb293"
SCALE = 2
MARK = (ROOT / "assets/mental-mark.svg").read_text()
MARK_PATH = re.search(r'<path d="([^"]+)"', MARK).group(1)


def font(filename, size):
    face = TTFont(ROOT / "assets/fonts" / filename)
    face.flavor = None
    data = BytesIO()
    face.save(data)
    data.seek(0)
    return ImageFont.truetype(data, round(size * SCALE))


def svg_image(source, size):
    return Image.open(BytesIO(cairosvg.svg2png(
        bytestring=source.encode(), output_width=size[0], output_height=size[1]
    ))).convert("RGBA")


def build_icons():
    # Keep the established mark, with a dark field for clear 16 px contrast.
    source = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
        f'<rect width="64" height="64" rx="13" fill="{INK}"/>'
        f'<path transform="translate(6 10) scale(.8)" fill="{PEACH}" d="{MARK_PATH}"/>'
        '</svg>\n'
    )
    (ROOT / "favicon.svg").write_text(source)
    large = svg_image(source, (512, 512))
    large.save(ROOT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    large.resize((32, 32), Image.Resampling.LANCZOS).save(ROOT / "favicon-32x32.png", optimize=True)
    # Apple applies its own corner mask; supply an opaque, full-bleed icon.
    apple = Image.new("RGBA", (512, 512), INK)
    apple.alpha_composite(large)
    apple.convert("RGB").resize((180, 180), Image.Resampling.LANCZOS).save(
        ROOT / "apple-touch-icon.png", optimize=True
    )


def build_share_card():
    canvas = Image.new("RGB", (1200 * SCALE, 630 * SCALE), INK)
    draw = ImageDraw.Draw(canvas)

    def text(position, value, face, color=PAPER, **kwargs):
        draw.text(tuple(round(v * SCALE) for v in position), value, font=face,
                  fill=color, **kwargs)

    mark = MARK.replace('#E8AB8A', PEACH)
    logo = svg_image(mark, (80 * SCALE, 68 * SCALE))
    canvas.paste(logo, (88 * SCALE, 68 * SCALE), logo)
    text((196, 92), 'MAGAZIN ÉS SZAKEMBERKERESŐ', font('dm-sans-1.woff2', 22))
    draw.line((88 * SCALE, 168 * SCALE, 1112 * SCALE, 168 * SCALE),
              fill='#49675d', width=SCALE)

    brand_font = font('newsreader-4.woff2', 178)
    text((80, 358), 'MENTÁL', brand_font, anchor='ls')
    brand_width = draw.textlength('MENTÁL', font=brand_font) / SCALE
    text((80 + brand_width + 4, 358), '.hu', font('newsreader-2.woff2', 112),
         color=PEACH, anchor='ls')
    text((92, 438), 'Pszichológia · Mentális egészség', font('dm-sans-0.woff2', 31))
    draw.line((92 * SCALE, 533 * SCALE, 184 * SCALE, 533 * SCALE),
              fill=PEACH, width=4 * SCALE)
    canvas.resize((1200, 630), Image.Resampling.LANCZOS).save(
        ROOT / 'assets/mental-og.png', optimize=True
    )


if __name__ == '__main__':
    build_icons()
    build_share_card()
    for relative in ['favicon.svg', 'favicon.ico', 'favicon-32x32.png',
                     'apple-touch-icon.png', 'assets/mental-og.png']:
        file = ROOT / relative
        print(f'{relative}: {file.stat().st_size:,} bytes')
