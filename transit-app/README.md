# Transit Reach

Swisstopo map (same layers as `topo-app`) showing every stop reachable by public transport
from **Lausanne gare** or **home (Montétan)**, for a chosen date (next 2 weekends) and departure
time (10 min steps), filtered by max travel time and number of changes.

## How it works
- `scripts/build_reachability.py` (stdlib Python, no deps) reads the Swiss GTFS feed and runs a
  Connection Scan Algorithm for each date × start point × departure slot (default 06:00–12:00,
  every 10 min). Per station it stores the next journey's travel time (departure → arrival) and wait, with 0..4 changes.
- Output in `data/`: `manifest.json`, `stations.json`, and `reach_<origin>_<YYYYMMDD>.bin.gz`
  (gzipped uint8 minutes, 255 = unreachable, layout `[travel|wait][slot][changes][station]`).
- `app.js` colours stops green→red by duration and filters by start point, date, departure time,
  max time slider, number of changes (minimum needed within the budget), mode.
- Popup → "Live connections" queries live times (for the selected date/time) from `transport.opendata.ch`.

## 1. Get GTFS
Download the current timetable GTFS zip from
[opentransportdata.swiss](https://opentransportdata.swiss/en/dataset/?q=gtfs) (dataset "Timetable 2026 (GTFS2020)").
No need to unzip.

## 2. Build data
```bash
cd transit-app/scripts
python3 build_reachability.py --gtfs ~/Downloads/gtfs_fp2026.zip    # next 2 weekends
# options: --dates 2026-11-21,2026-11-22 --window 06:00-12:00 --step 10 --max-hours 4
#          --modes rail,bus,metro,tram,boat,cable --jobs 4
```
Rerun weekly (old `reach_*` files are deleted on each run). Use a recent GTFS: it's updated weekly.
Takes a few minutes (stop_times.txt is large). Origin stops and walking minutes are in `ORIGINS`
at the top of the script — names must match `stops.txt` exactly.

## 3. Run
From the repo root: `./serve_app.sh`, then open http://localhost:8000/transit-app/

## Notes / limits
- Travel time = next journey leaving home at or after the selected time (within `--max-wait`, default 60 min), from departure to arrival; waiting at the start is excluded.
- Walking between stations < 400 m is allowed; 2 min min transfer time at the same station.
- Trips starting before midnight of the previous day are ignored.
