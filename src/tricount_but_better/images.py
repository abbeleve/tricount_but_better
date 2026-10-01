"""Safe, in-memory intake for receipt photos.

Uploads are decoded, bounded, re-encoded, and stripped of metadata in memory
before they are shown to a model. Re-encoding is the point: it drops EXIF
(which carries GPS), and it means we never hand the model bytes we have not
parsed ourselves.
"""

from __future__ import annotations

import io

from PIL import Image, UnidentifiedImageError

# A 2000px long edge keeps small print legible without ballooning token cost.
MAX_EDGE = 2000
# Guard against decompression bombs: a 100MP "image" is not a receipt.
MAX_PIXELS = 40_000_000
ALLOWED_FORMATS = {"JPEG", "PNG", "WEBP", "HEIF", "MPO"}


class ImageError(ValueError):
    """The upload is not an image we are willing to process."""


def _normalise(image: Image.Image) -> Image.Image:
    # Honour the EXIF orientation flag before we discard EXIF, otherwise
    # phone photos reach the model rotated.
    from PIL import ImageOps

    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    if max(image.size) > MAX_EDGE:
        image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
    return image


def normalise_image(data: bytes) -> bytes:
    """Validate an image and return clean JPEG bytes without writing a file."""
    if not data:
        raise ImageError("the uploaded file is empty")

    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = probe.format or ""
            if fmt.upper() not in ALLOWED_FORMATS:
                raise ImageError(f"unsupported image format: {fmt or 'unknown'}")
            width, height = probe.size
            if width * height > MAX_PIXELS:
                raise ImageError("that image is too large to process")
            probe.load()
            image = _normalise(probe)
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=88, optimize=True)
    except UnidentifiedImageError as exc:
        raise ImageError("that file is not a readable image") from exc
    except OSError as exc:
        raise ImageError("that image could not be decoded") from exc

    return buffer.getvalue()
