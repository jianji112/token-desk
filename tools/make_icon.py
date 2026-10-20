"""生成TokenDesk Launcher 图标（各密度 mipmap PNG）。一次性工具，产物随工程提交。"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, "app", "res")
S = 1024

LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


BG_TOP = (16, 26, 36)
BG_BOT = (8, 12, 17)
GREEN = (74, 222, 128)
GREEN_D = (34, 160, 92)
CYAN = (56, 189, 248)
WHITE = (232, 240, 246)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def build():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    for y in range(S):
        t = y / (S - 1)
        c = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
        d.line([(0, y), (S, y)], fill=c + (255,))

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r in range(520, 0, -8):
        a = int(42 * (1 - r / 520) ** 1.6)
        gd.ellipse([220 - r, 180 - r, 220 + r, 180 + r], fill=(74, 222, 128, a))
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)


    cx, cy, R = 400, 430, 190
    d.ellipse([cx - R, cy - R, cx + R, cy + R], outline=GREEN, width=64)
    d.ellipse([cx - R + 78, cy - R + 78, cx + R - 78, cy + R - 78], outline=GREEN_D, width=10)

    d.rounded_rectangle([cx + R - 20, cy - 36, 880, cy + 36], radius=36, fill=GREEN)

    d.rounded_rectangle([700, cy + 30, 752, cy + 150], radius=14, fill=GREEN)
    d.rounded_rectangle([800, cy + 30, 852, cy + 116], radius=14, fill=GREEN)


    for i, (rx, ry, col) in enumerate([(760, 790, CYAN), (700, 830, GREEN), (640, 870, WHITE)]):
        w = 120 - i * 8
        d.rounded_rectangle([rx - w, ry - 22, rx + w, ry + 22], radius=22, fill=col + (235,))


    img.putalpha(rounded_mask(S, 190))
    return img


def main():
    base = build()
    dens = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for name, px in dens.items():
        out_dir = os.path.join(RES, "mipmap-" + name)
        os.makedirs(out_dir, exist_ok=True)
        im = base.resize((px, px), LANCZOS)
        im.save(os.path.join(out_dir, "ic_launcher.png"))

    prev = os.path.join(ROOT, "docs")
    os.makedirs(prev, exist_ok=True)
    base.resize((512, 512), LANCZOS).save(os.path.join(prev, "icon-512.png"))
    print("icons done")


if __name__ == "__main__":
    main()
