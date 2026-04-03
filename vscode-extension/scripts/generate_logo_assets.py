from __future__ import annotations

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE_IMAGE = ROOT / "source-assets" / "NERV_Logo.webp"
MEDIA_DIR = ROOT / "media"
TRANSPARENT_OUTPUT = MEDIA_DIR / "nerv-logo-transparent.png"
TOOLBAR_OUTPUT = MEDIA_DIR / "nerv-toolbar-icon.png"
MARKETPLACE_OUTPUT = MEDIA_DIR / "nerv-marketplace-icon.png"


def estimate_foreground_red(image: Image.Image) -> tuple[int, int, int]:
    candidates: list[tuple[int, int, int]] = []
    for red, green, blue, _alpha in image.getdata():
        if red < 24:
            continue
        if red < green * 2 or red < blue * 2:
            continue
        candidates.append((red, green, blue))

    if not candidates:
        return (255, 0, 0)

    max_red = max(pixel[0] for pixel in candidates)
    bright_pixels = [pixel for pixel in candidates if pixel[0] >= max_red - 8] or candidates
    avg_green = round(sum(pixel[1] for pixel in bright_pixels) / len(bright_pixels))
    avg_blue = round(sum(pixel[2] for pixel in bright_pixels) / len(bright_pixels))
    return (max_red, avg_green, avg_blue)


def remove_black_background(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    fg_red, fg_green, fg_blue = estimate_foreground_red(image)
    fg_strength = max(fg_red, 1)

    converted = Image.new("RGBA", image.size)
    out_pixels = []

    for red, green, blue, _alpha in image.getdata():
        coverage = max(red, green, blue) / fg_strength
        if coverage <= 0.02:
            out_pixels.append((0, 0, 0, 0))
            continue

        clamped_alpha = max(0, min(255, round(coverage * 255)))
        out_pixels.append((fg_red, fg_green, fg_blue, clamped_alpha))

    converted.putdata(out_pixels)
    bbox = converted.getbbox()
    return converted.crop(bbox) if bbox else converted


def render_square_icon(image: Image.Image, size: int, padding: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    available = size - (padding * 2)
    scale = min(available / image.width, available / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    left = (size - resized.width) // 2
    top = (size - resized.height) // 2
    canvas.alpha_composite(resized, (left, top))
    return canvas


def main() -> None:
    if not SOURCE_IMAGE.exists():
        raise SystemExit(f"Source image not found: {SOURCE_IMAGE}")

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)

    transparent_logo = remove_black_background(SOURCE_IMAGE)
    transparent_logo.save(TRANSPARENT_OUTPUT)

    render_square_icon(transparent_logo, size=128, padding=6).save(TOOLBAR_OUTPUT)
    render_square_icon(transparent_logo, size=512, padding=32).save(MARKETPLACE_OUTPUT)

    print(f"Saved {TRANSPARENT_OUTPUT}")
    print(f"Saved {TOOLBAR_OUTPUT}")
    print(f"Saved {MARKETPLACE_OUTPUT}")


if __name__ == "__main__":
    main()

