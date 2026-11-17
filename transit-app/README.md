# Transit Reach

Swisstopo map (same layers as `topo-app`) showing every stop reachable by public transport
from **Lausanne gare** or **home (Montétan)**, filtered by max travel time and number of changes.

## How it works
- `scripts/build_reachability.py` (stdlib Python, no deps) reads the Swiss GTFS feed and runs a
  Connection Scan Algorithm for departures every N min inside a window (default Sat 07:00–10:00).
  For each station it stores the fastest duration with 0..4 changes → `data/reach_<origin>.json`.
- `app.js` loads that JSON, colours stops green→red by duration, and filters by:
  start point, max time slider, number of changes (minimum needed within the budget), mode.
- Popup → "Next connections" queries live times from `transport.opendata.ch`.

## 1. Get GTFS
Download the current timetable GTFS zip from
[opentransportdata.swiss](https://opentransportdata.swiss/en/dataset/?q=gtfs) (dataset "Timetable 2026 (GTFS2020)").
No need to unzip.

## 2. Build data
```bash
cd transit-app/scripts
python3 build_reachability.py --gtfs ~/Downloads/gtfs_fp2026.zip --date 2026-11-21
# options: --window 07:00-10:00 --step 10 --max-hours 4 --modes rail,bus,metro,tram,boat,cable
```
Takes a few minutes (stop_times.txt is large). Origin stops and walking minutes are in `ORIGINS`
at the top of the script — names must match `stops.txt` exactly.

## 3. Run
From the repo root: `./serve_app.sh`, then open http://localhost:8000/transit-app/

## Notes / limits
- Duration = from sampled departure time at the door (up to `--step` min of waiting included).
- Walking between stations < 400 m is allowed; 2 min min transfer time at the same station.
- One timetable day only; trips after midnight are ignored.
