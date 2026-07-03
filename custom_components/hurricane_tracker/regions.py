"""Region labels drawn on the map (country / state names) for orientation.

Plain reference data — a flat list of anchor points. The card is region-agnostic:
it draws whatever falls in view and hides anything that would collide with storm
data. To cover more of the world, append rows here; no code changes.

Each entry:
    name : label text (kept short; the card uppercases it)
    lng  : anchor longitude (approx region centroid, decimal degrees, E positive)
    lat  : anchor latitude
    tier : 0 = country / major (shown even when zoomed out)
           1 = state / province / island (shown only when zoomed in enough)

Coverage: global, matching the integration's storm coverage (NHC Atlantic +
E/Central Pacific, GDACS everywhere else). Anchors are approximate centroids —
good enough to label a landmass, not survey-grade.
"""
from __future__ import annotations

REGION_LABELS = [
    # ======================= AMERICAS / ATLANTIC =========================
    # --- Countries / territories (tier 0) ---
    {"name": "United States", "lng": -98.5, "lat": 39.5, "tier": 0},
    {"name": "Mexico", "lng": -102.5, "lat": 23.6, "tier": 0},
    {"name": "Canada", "lng": -95.0, "lat": 56.0, "tier": 0},
    {"name": "Cuba", "lng": -79.0, "lat": 21.6, "tier": 0},
    {"name": "Bahamas", "lng": -76.6, "lat": 24.3, "tier": 0},
    {"name": "Jamaica", "lng": -77.3, "lat": 18.1, "tier": 0},
    {"name": "Haiti", "lng": -72.5, "lat": 19.1, "tier": 0},
    {"name": "Dominican Rep.", "lng": -70.5, "lat": 18.9, "tier": 0},
    {"name": "Puerto Rico", "lng": -66.5, "lat": 18.2, "tier": 0},
    {"name": "Belize", "lng": -88.7, "lat": 17.2, "tier": 0},
    {"name": "Guatemala", "lng": -90.4, "lat": 15.6, "tier": 0},
    {"name": "Honduras", "lng": -86.6, "lat": 14.8, "tier": 0},
    {"name": "El Salvador", "lng": -88.9, "lat": 13.7, "tier": 0},
    {"name": "Nicaragua", "lng": -85.2, "lat": 12.9, "tier": 0},
    {"name": "Costa Rica", "lng": -84.1, "lat": 9.9, "tier": 0},
    {"name": "Panama", "lng": -80.1, "lat": 8.6, "tier": 0},
    {"name": "Colombia", "lng": -73.5, "lat": 4.6, "tier": 0},
    {"name": "Venezuela", "lng": -66.5, "lat": 7.5, "tier": 0},
    {"name": "Bermuda", "lng": -64.75, "lat": 32.3, "tier": 0},
    {"name": "Cape Verde", "lng": -23.6, "lat": 16.0, "tier": 0},

    # --- U.S. coastal states (tier 1) ---
    {"name": "Texas", "lng": -99.3, "lat": 31.3, "tier": 1},
    {"name": "Louisiana", "lng": -92.0, "lat": 31.0, "tier": 1},
    {"name": "Mississippi", "lng": -89.7, "lat": 32.6, "tier": 1},
    {"name": "Alabama", "lng": -86.8, "lat": 32.8, "tier": 1},
    {"name": "Florida", "lng": -81.6, "lat": 28.3, "tier": 1},
    {"name": "Georgia", "lng": -83.4, "lat": 32.7, "tier": 1},
    {"name": "South Carolina", "lng": -80.9, "lat": 33.9, "tier": 1},
    {"name": "North Carolina", "lng": -79.4, "lat": 35.6, "tier": 1},
    {"name": "Virginia", "lng": -78.7, "lat": 37.5, "tier": 1},
    {"name": "Maryland", "lng": -76.8, "lat": 39.0, "tier": 1},
    {"name": "Delaware", "lng": -75.5, "lat": 39.0, "tier": 1},
    {"name": "New Jersey", "lng": -74.5, "lat": 40.1, "tier": 1},
    {"name": "New York", "lng": -75.5, "lat": 42.9, "tier": 1},
    {"name": "Connecticut", "lng": -72.7, "lat": 41.6, "tier": 1},
    {"name": "Rhode Island", "lng": -71.5, "lat": 41.7, "tier": 1},
    {"name": "Massachusetts", "lng": -71.8, "lat": 42.3, "tier": 1},
    {"name": "Maine", "lng": -69.2, "lat": 45.3, "tier": 1},
    {"name": "California", "lng": -119.6, "lat": 36.5, "tier": 1},
    {"name": "Hawaii", "lng": -156.3, "lat": 20.3, "tier": 1},

    # ===================== NORTHWEST PACIFIC =============================
    {"name": "Japan", "lng": 138.2, "lat": 36.2, "tier": 0},
    {"name": "Philippines", "lng": 122.0, "lat": 12.9, "tier": 0},
    {"name": "China", "lng": 104.0, "lat": 35.0, "tier": 0},
    {"name": "Taiwan", "lng": 121.0, "lat": 23.7, "tier": 0},
    {"name": "South Korea", "lng": 127.8, "lat": 36.4, "tier": 0},
    {"name": "North Korea", "lng": 127.0, "lat": 40.0, "tier": 0},
    {"name": "Vietnam", "lng": 106.3, "lat": 16.0, "tier": 0},
    {"name": "Laos", "lng": 103.8, "lat": 18.5, "tier": 0},
    {"name": "Cambodia", "lng": 104.9, "lat": 12.6, "tier": 0},
    {"name": "Thailand", "lng": 101.0, "lat": 15.5, "tier": 0},
    {"name": "Guam", "lng": 144.8, "lat": 13.4, "tier": 0},
    {"name": "Hong Kong", "lng": 114.1, "lat": 22.3, "tier": 1},
    {"name": "Guangdong", "lng": 113.3, "lat": 23.3, "tier": 1},
    {"name": "Fujian", "lng": 118.3, "lat": 26.0, "tier": 1},
    {"name": "Zhejiang", "lng": 120.2, "lat": 29.2, "tier": 1},
    {"name": "Hainan", "lng": 109.7, "lat": 19.2, "tier": 1},
    {"name": "Okinawa", "lng": 127.8, "lat": 26.3, "tier": 1},
    {"name": "Kyushu", "lng": 130.7, "lat": 32.5, "tier": 1},
    {"name": "Luzon", "lng": 121.0, "lat": 16.5, "tier": 1},
    {"name": "Mindanao", "lng": 125.0, "lat": 7.9, "tier": 1},

    # ======================= NORTH INDIAN ===============================
    {"name": "India", "lng": 79.0, "lat": 22.5, "tier": 0},
    {"name": "Bangladesh", "lng": 90.3, "lat": 23.7, "tier": 0},
    {"name": "Myanmar", "lng": 96.0, "lat": 21.0, "tier": 0},
    {"name": "Sri Lanka", "lng": 80.7, "lat": 7.9, "tier": 0},
    {"name": "Pakistan", "lng": 69.3, "lat": 29.5, "tier": 0},
    {"name": "Oman", "lng": 56.0, "lat": 21.0, "tier": 0},
    {"name": "Yemen", "lng": 47.5, "lat": 15.5, "tier": 0},
    {"name": "U.A.E.", "lng": 54.3, "lat": 23.9, "tier": 0},
    {"name": "Odisha", "lng": 85.0, "lat": 20.5, "tier": 1},
    {"name": "Andhra Pradesh", "lng": 80.0, "lat": 15.9, "tier": 1},
    {"name": "Tamil Nadu", "lng": 78.5, "lat": 11.1, "tier": 1},
    {"name": "West Bengal", "lng": 87.9, "lat": 23.0, "tier": 1},
    {"name": "Gujarat", "lng": 71.6, "lat": 22.6, "tier": 1},

    # ====================== SOUTHWEST INDIAN ============================
    {"name": "Madagascar", "lng": 46.9, "lat": -19.4, "tier": 0},
    {"name": "Mozambique", "lng": 35.5, "lat": -18.3, "tier": 0},
    {"name": "Tanzania", "lng": 34.9, "lat": -6.4, "tier": 0},
    {"name": "Kenya", "lng": 37.9, "lat": -0.5, "tier": 0},
    {"name": "Malawi", "lng": 34.3, "lat": -13.3, "tier": 0},
    {"name": "Zimbabwe", "lng": 29.9, "lat": -19.0, "tier": 0},
    {"name": "Comoros", "lng": 43.9, "lat": -11.9, "tier": 0},
    {"name": "Mauritius", "lng": 57.6, "lat": -20.3, "tier": 0},
    {"name": "Reunion", "lng": 55.5, "lat": -21.1, "tier": 0},
    {"name": "Seychelles", "lng": 55.5, "lat": -4.7, "tier": 0},

    # ====================== AUSTRALIAN REGION ===========================
    {"name": "Australia", "lng": 134.0, "lat": -25.0, "tier": 0},
    {"name": "Indonesia", "lng": 113.0, "lat": -2.5, "tier": 0},
    {"name": "Papua New Guinea", "lng": 144.3, "lat": -6.5, "tier": 0},
    {"name": "Timor-Leste", "lng": 125.8, "lat": -8.8, "tier": 0},
    {"name": "Malaysia", "lng": 109.5, "lat": 3.8, "tier": 0},
    {"name": "Queensland", "lng": 144.0, "lat": -22.5, "tier": 1},
    {"name": "New South Wales", "lng": 146.9, "lat": -32.0, "tier": 1},
    {"name": "Northern Territory", "lng": 133.4, "lat": -19.5, "tier": 1},
    {"name": "Western Australia", "lng": 122.3, "lat": -25.3, "tier": 1},

    # =================== MICRONESIA / CENTRAL PACIFIC ====================
    {"name": "Palau", "lng": 134.5, "lat": 7.5, "tier": 0},
    {"name": "N. Marianas", "lng": 145.7, "lat": 15.2, "tier": 0},
    {"name": "Micronesia", "lng": 158.2, "lat": 6.9, "tier": 0},
    {"name": "Marshall Is.", "lng": 171.0, "lat": 7.1, "tier": 0},
    {"name": "Kiribati", "lng": 173.0, "lat": 1.4, "tier": 0},
    {"name": "Nauru", "lng": 166.9, "lat": -0.5, "tier": 0},
    {"name": "Tuvalu", "lng": 178.0, "lat": -7.5, "tier": 0},

    # ======================== SOUTH PACIFIC =============================
    {"name": "Fiji", "lng": 178.0, "lat": -17.8, "tier": 0},
    {"name": "Vanuatu", "lng": 167.5, "lat": -16.3, "tier": 0},
    {"name": "New Caledonia", "lng": 165.5, "lat": -21.3, "tier": 0},
    {"name": "Solomon Islands", "lng": 160.2, "lat": -9.6, "tier": 0},
    {"name": "New Zealand", "lng": 172.5, "lat": -41.5, "tier": 0},
    {"name": "Tonga", "lng": -175.2, "lat": -21.2, "tier": 0},
    {"name": "Samoa", "lng": -172.1, "lat": -13.8, "tier": 0},
]
