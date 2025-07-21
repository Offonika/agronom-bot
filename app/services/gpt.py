"""GPT-Vision integration stubs."""

from __future__ import annotations


def call_gpt_vision_stub(image_path: str) -> dict:
    """Return mock diagnosis for the given image.

    Parameters
    ----------
    image_path: str
        Path to the uploaded image. Only used for debugging
        in this stub implementation.

    Returns
    -------
    dict
        Mocked GPT response with keys: ``crop``, ``disease`` and ``confidence``.
    """
    # In real integration this function would upload the image to GPT-Vision
    # and parse the JSON response. The stub always returns a fixed payload.
    return {"crop": "apple", "disease": "powdery_mildew", "confidence": 0.92}

