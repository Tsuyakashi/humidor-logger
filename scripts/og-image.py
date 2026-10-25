#!/usr/bin/env python3
# Генератор превью для Open Graph: services/web/public/og.png (1200×630, тёмная палитра страницы).
# Запускается вручную один раз, результат коммитится. Нужен Pillow и шрифт с кириллицей (fc-match).
# Запуск из корня репо: python3 scripts/og-image.py   (OG_FONT=... OG_FONT_BOLD=... — свои шрифты)
import math
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
SS = 2  # рисуем в 2× и уменьшаем — сглаживание линий
OUT = Path(__file__).resolve().parent.parent / 'services/web/public/og.png'

# палитра тёмной темы из index.html
BG = (21, 21, 20)
CARD = (31, 30, 29)
FG = (236, 235, 232)
MUTED = (154, 150, 143)
GRID = (255, 255, 255, 20)
TEMP = (240, 138, 85)
HUM = (94, 163, 242)
BAND = (94, 163, 242, 36)


def font(env: str, pattern: str) -> str:
    if os.environ.get(env):
        return os.environ[env]
    return subprocess.run(['fc-match', '-f', '%{file}', pattern], check=True, capture_output=True, text=True).stdout


def s(v: float) -> int:
    return round(v * SS)


def main() -> None:
    bold = ImageFont.truetype(font('OG_FONT_BOLD', 'Noto Sans:bold:lang=ru'), s(112))
    regular = ImageFont.truetype(font('OG_FONT', 'Noto Sans:lang=ru'), s(40))
    small = ImageFont.truetype(font('OG_FONT', 'Noto Sans:lang=ru'), s(24))

    img = Image.new('RGB', (s(W), s(H)), BG)
    d = ImageDraw.Draw(img, 'RGBA')

    d.text((s(80), s(64)), 'Хьюмидор', font=bold, fill=FG)
    d.text((s(84), s(212)), 'температура · влажность', font=regular, fill=MUTED)

    # карточка графика
    cx0, cy0, cx1, cy1 = 64, 300, W - 64, H - 56
    d.rounded_rectangle((s(cx0), s(cy0), s(cx1), s(cy1)), radius=s(20), fill=CARD)
    px0, py0, px1, py1 = cx0 + 40, cy0 + 30, cx1 - 40, cy1 - 30

    for i in range(1, 4):
        y = py0 + (py1 - py0) * i / 4
        d.line((s(px0), s(y), s(px1), s(y)), fill=GRID, width=s(1))

    # шкала RH 60–75 %, коридор 65–70 %
    def rh_y(v: float) -> float:
        return py1 - (v - 60) / 15 * (py1 - py0)

    d.rectangle((s(px0), s(rh_y(70)), s(px1), s(rh_y(65))), fill=BAND)
    d.text((s(px1), s(rh_y(70) - 8)), '65–70 %', font=small, fill=HUM, anchor='rd')

    # стилизованные ряды: детерминированная сумма синусоид
    n = 240
    xs = [px0 + (px1 - px0) * i / (n - 1) for i in range(n)]
    hum = [67.6 + 1.3 * math.sin(i / 23) + 0.6 * math.sin(i / 7.3 + 1) + 0.25 * math.sin(i / 2.1) for i in range(n)]
    temp = [py0 + 180 + 16 * math.sin(i / 31 + 2) + 7 * math.sin(i / 9.7) + 2 * math.sin(i / 3.3) for i in range(n)]

    d.line([(s(x), s(y)) for x, y in zip(xs, temp)], fill=TEMP, width=s(5), joint='curve')
    d.line([(s(x), s(rh_y(v))) for x, v in zip(xs, hum)], fill=HUM, width=s(5), joint='curve')

    img = img.resize((W, H), Image.LANCZOS)
    img.save(OUT, optimize=True)
    print(f'{OUT} {OUT.stat().st_size // 1024} KB')


if __name__ == '__main__':
    main()
