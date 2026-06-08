#!/usr/bin/env python3
"""Generate static public transport travel-time dataset from Lausanne."""

from __future__ import annotations

import json
import math
import sys
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "https://transport.opendata.ch/v1"
USER_AGENT = "vicidel-topo-transit-builder/1.0"
LAUSANNE_ID = "8501120"  # main station
OUTPUT_PATH = "lausanne_transit_times.geojson"

# Bounding box covering Switzerland and nearby cross-border hubs
LAT_MIN, LAT_MAX, LAT_STEP = 45.0, 48.4, 0.45
LON_MIN, LON_MAX, LON_STEP = 5.3, 11.2, 0.45

# Extra coordinates to capture key nodes not hit by the coarse grid
EXTRA_COORDS: List[Tuple[float, float]] = [
    (46.2044, 6.1432),   # Genève
    (46.9480, 7.4474),   # Bern
    (47.3769, 8.5417),   # Zürich
    (46.5197, 6.6323),   # Lausanne centre
    (46.0056, 8.9463),   # Lugano
    (45.4642, 9.1900),   # Milano
    (45.7600, 4.8357),   # Lyon
    (47.5596, 7.5886),   # Basel
    (46.8139, 8.2267),   # Andermatt
    (46.0807, 7.0559),   # Martigny
    (46.4984, 9.8415),   # St. Moritz
    (47.0502, 8.3093),   # Luzern
    (47.4239, 9.3748),   # St. Gallen
    (46.2941, 7.8821),   # Zermatt
    (46.1445, 8.7266),   # Locarno
    (46.2350, 7.3606),   # Sion
]

# Named stations to include even if coordinate sampling misses them
SEED_STATIONS = [
    "Genève-Aéroport",
    "Zürich Flughafen",
    "Interlaken Ost",
    "Grindelwald",
    "Visp",
    "Biel/Bienne",
    "Neuchâtel",
    "Fribourg/Freiburg",
    "Vevey",
    "Montreux",
    "Martigny",
    "Sierre/Siders",
    "Brig",
    "Chiasso",
    "Domodossola",
    "La Chaux-de-Fonds",
    "Davos Platz",
    "Chur",
    "Arosa",
    "Schaffhausen",
    "Basel SBB",
    "Zürich HB",
    "Bern",
    "Sion",
    "Lugano",
    "Bellinzona",
    "Aigle",
    "Annecy",
    "Grenoble",
    "Turin Porta Susa",
]


def fetch_json(endpoint: str, params: Dict[str, object], retries: int = 3) -> dict:
    """Call the transport API and return parsed JSON."""
    query = urlencode(params, doseq=True)
    url = f"{BASE_URL}/{endpoint}?{query}"
    last_error: Optional[Exception] = None

    for attempt in range(1, retries + 1):
        try:
            req = Request(url, headers={"User-Agent": USER_AGENT})
            with urlopen(req, timeout=20) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"{endpoint} {resp.status} for {params}")
                return json.load(resp)
        except (HTTPError, URLError, TimeoutError, ValueError) as exc:  # type: ignore[name-defined]
            last_error = exc
            time.sleep(0.6 * attempt)

    raise RuntimeError(f"Failed to fetch {endpoint} with {params}") from last_error


def iter_grid() -> Iterable[Tuple[float, float]]:
    """Yield coordinate pairs over the coarse sampling grid."""
    lat = LAT_MIN
    while lat <= LAT_MAX + 1e-9:
        lon = LON_MIN
        while lon <= LON_MAX + 1e-9:
            yield (round(lat, 4), round(lon, 4))
            lon += LON_STEP
        lat += LAT_STEP


def store_station(registry: Dict[str, dict], station: dict, source: str) -> None:
    """Insert station into registry if valid."""
    sid = station.get("id")
    coords = station.get("coordinate") or {}
    lat = coords.get("x")
    lon = coords.get("y")
    icon = station.get("icon")

    if not sid or lat is None or lon is None:
        return

    registry[sid] = {
        "id": sid,
        "name": station.get("name") or sid,
        "lat": float(lat),
        "lon": float(lon),
        "icon": icon,
        "source": source,
    }


def sample_station_at(registry: Dict[str, dict], lat: float, lon: float) -> None:
    """Fetch nearest station around coordinate."""
    data = fetch_json("locations", {"type": "station", "x": lat, "y": lon})
    for candidate in data.get("stations", []):
        if candidate.get("icon") in {"train", "bus", "tram"}:
            store_station(registry, candidate, f"grid_{lat}_{lon}")
            return
    # fallback: take first valid entry if icon filter found nothing
    for candidate in data.get("stations", []):
        store_station(registry, candidate, f"grid_{lat}_{lon}")
        return


def sample_station_by_name(registry: Dict[str, dict], name: str) -> None:
    """Fetch station using fuzzy name search."""
    data = fetch_json("locations", {"query": name, "type": "station"})
    for candidate in data.get("stations", []):
        # prefer mainline rail entries first
        if candidate.get("icon") == "train":
            store_station(registry, candidate, f"name_{name}")
            return
    for candidate in data.get("stations", []):
        store_station(registry, candidate, f"name_{name}")
        return


def parse_duration(raw: str) -> int:
    """Convert API duration string (e.g. 00d01:05:00) to minutes."""
    days_part, time_part = raw.split("d", 1)
    hours_str, minutes_str, seconds_str = time_part.split(":")
    days = int(days_part)
    hours = int(hours_str)
    minutes = int(minutes_str)
    seconds = int(seconds_str)
    total_minutes = days * 24 * 60 + hours * 60 + minutes
    if seconds >= 30:
        total_minutes += 1
    return total_minutes


def summarize_sections(sections: List[dict]) -> List[str]:
    """Reduce section details to compact text snippets."""
    summaries: List[str] = []
    for section in sections:
        if section.get("journey"):
            journey = section["journey"]
            category = journey.get("category") or ""
            number = journey.get("number") or ""
            label = f"{category} {number}".strip()
            destination = journey.get("to")
            if destination:
                label = f"{label} → {destination}" if label else destination
            summaries.append(label or "Service")
        elif section.get("walk"):
            walk = section["walk"]
            duration = walk.get("duration") or 0
            summaries.append(f"Walk {int(round(duration / 60))} min")
        else:
            summaries.append("Transfer")
    return summaries


def safe_distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate great-circle distance in kilometres."""
    rad = math.radians
    r_earth = 6371.0
    dlat = rad(lat2 - lat1)
    dlon = rad(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(rad(lat1)) * math.cos(rad(lat2)) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(r_earth * c, 2)


def main() -> None:
    stations: Dict[str, dict] = OrderedDict()

    print("Sampling grid...", file=sys.stderr)
    for lat, lon in iter_grid():
        sample_station_at(stations, lat, lon)
        time.sleep(0.1)

    print("Sampling extras...", file=sys.stderr)
    for lat, lon in EXTRA_COORDS:
        sample_station_at(stations, lat, lon)
        time.sleep(0.1)

    for name in SEED_STATIONS:
        sample_station_by_name(stations, name)
        time.sleep(0.1)

    stations.pop(LAUSANNE_ID, None)  # drop origin

    print(f"Collected {len(stations)} stations. Fetching connections...", file=sys.stderr)

    features: List[dict] = []
    for idx, station in enumerate(stations.values(), start=1):
        sid = station["id"]
        try:
            data = fetch_json(
                "connections", {"from": LAUSANNE_ID, "to": sid, "limit": 1}
            )
        except Exception as exc:  # pylint: disable=broad-except
            print(f"skip {station['name']} ({sid}): {exc}", file=sys.stderr)
            continue

        connections = data.get("connections") or []
        if not connections:
            continue

        conn = connections[0]
        duration_raw = conn.get("duration")
        if not duration_raw:
            continue

        minutes = parse_duration(duration_raw)
        if minutes > 5 * 60:
            continue

        departure_iso = (
            (conn.get("from") or {}).get("departure")
            if isinstance(conn.get("from"), dict)
            else None
        )
        arrival_iso = (
            (conn.get("to") or {}).get("arrival")
            if isinstance(conn.get("to"), dict)
            else None
        )
        products = conn.get("products") or []
        sections = conn.get("sections") or []

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [station["lon"], station["lat"]],
            },
            "properties": {
                "station_id": sid,
                "name": station["name"],
                "icon": station.get("icon"),
                "duration_minutes": minutes,
                "duration_text": duration_raw,
                "transfers": conn.get("transfers"),
                "products": products,
                "section_summaries": summarize_sections(sections),
                "departure": departure_iso,
                "arrival": arrival_iso,
                "distance_km": safe_distance_km(
                    station["lat"], station["lon"], 46.516795, 6.629087
                ),
            },
        }
        features.append(feature)
        if idx % 20 == 0:
            print(f"  processed {idx} stations...", file=sys.stderr)

        time.sleep(0.1)

    features.sort(key=lambda f: f["properties"]["duration_minutes"])

    dataset = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "source": "transport.opendata.ch",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "origin_station": "Lausanne",
            "max_travel_minutes": 5 * 60,
            "sampled_station_count": len(stations),
            "retained_feature_count": len(features),
        },
    }

    with open(OUTPUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(dataset, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"Wrote {OUTPUT_PATH} with {len(features)} features.", file=sys.stderr)


if __name__ == "__main__":
    main()
