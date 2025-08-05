"""ROI calculation service.

This module contains a small stub for computing return on investment (ROI).
In production this would likely query external data sources. For tests we
use a deterministic formula based on crop and disease names so results are
predictable.
"""

from __future__ import annotations


def calculate_roi(crop: str, disease: str) -> float:
    """Calculate ROI for the given crop and disease.

    Parameters
    ----------
    crop: str
        Name of the crop detected on the photo.
    disease: str
        Name of the disease returned by GPT.

    Returns
    -------
    float
        A deterministic ROI value. The current implementation is a simple
        placeholder: the combined length of ``crop`` and ``disease`` divided
        by ten.
    """

    return round((len(crop) + len(disease)) / 10, 2)


__all__ = ["calculate_roi"]

