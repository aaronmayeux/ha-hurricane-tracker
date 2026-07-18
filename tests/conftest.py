"""Test bootstrap for the hurricane_tracker integration.

The parsing + geometry modules (nhc, geometry, const, regions, layers helpers)
are pure Python -- stdlib only, no Home Assistant imports -- so we test them in
isolation WITHOUT installing homeassistant. The integration's __init__.py DOES
import homeassistant (setup/websocket code), so importing the real package would
drag HA in; instead we register a lightweight `hurricane_tracker` package whose
__path__ points at the integration dir but whose __init__ is a no-op. Relative
imports (`from .const import ...`, `from . import nhc`) then resolve against the
real source files with no HA dependency.

The integration dir is found by walking up from this file until a
`custom_components/hurricane_tracker/nhc.py` is seen, so the same suite runs both
from the repo root (CI) and against a mounted dev copy.
"""
import pathlib
import sys
import types

import pytest

_HERE = pathlib.Path(__file__).resolve()

def _find_pkg_dir():
    for parent in _HERE.parents:
        cand = parent / "custom_components" / "hurricane_tracker"
        if (cand / "nhc.py").exists():
            return cand
    raise RuntimeError("custom_components/hurricane_tracker not found above %s" % _HERE)

PKG_DIR = _find_pkg_dir()
FIXTURES = _HERE.parent / "fixtures"

# Register the no-op package so `import hurricane_tracker.<submodule>` resolves
# the source files directly (skips the HA-importing __init__.py).
if "hurricane_tracker" not in sys.modules:
    _pkg = types.ModuleType("hurricane_tracker")
    _pkg.__path__ = [str(PKG_DIR)]
    sys.modules["hurricane_tracker"] = _pkg


def _read(name, mode="rb"):
    with open(FIXTURES / name, mode) as fh:
        return fh.read()


@pytest.fixture(scope="session")
def forecast_zip():
    """Real NHC 5-day forecast-cone GIS zip (bytes)."""
    return _read("forecast_cone.zip")


@pytest.fixture(scope="session")
def best_track_zip():
    """Real NHC best-track GIS zip (bytes)."""
    return _read("best_track.zip")


@pytest.fixture(scope="session")
def adeck_text():
    """Real ATCF a-deck for the fixture storm, decompressed to text."""
    import gzip
    return gzip.decompress(_read("adeck.dat.gz")).decode("utf-8", "replace")


@pytest.fixture(scope="session")
def storm():
    """Real NHC CurrentStorms.json storm dict for the fixture storm."""
    import json
    return json.loads(_read("storm.json", "r"))
