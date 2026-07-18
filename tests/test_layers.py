"""Tests for layers.py pure helpers (the on-demand layer platform's data prep).

Only the stdlib-pure helpers are exercised here; async_get_layer needs a live
hass/coordinator and is covered by manual on-glass testing.
"""
from hurricane_tracker import layers


def test_strip_html():
    assert layers._strip_html("<p>Hello &amp; bye</p>") == "Hello & bye"
    assert layers._strip_html("") == ""
    assert layers._strip_html(None) == ""


def test_surge_rank_orders_by_severity():
    assert layers._surge_rank("blue") < layers._surge_rank("red")
    assert layers._surge_rank("purple") > layers._surge_rank("orange")
    assert layers._surge_rank("nonsense") == -1
