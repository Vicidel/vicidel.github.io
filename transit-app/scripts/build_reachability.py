#!/usr/bin/env python3
"""Precompute public-transport reachability from fixed origins using Swiss GTFS.

Stdlib only. For each date, origin and departure slot (every --step min inside
--window) it runs a Connection Scan Algorithm (CSA) with a bounded number of
changes and stores, per station, the travel time (incl. waiting) with 0..K changes.

Usage:
  python3 build_reachability.py --gtfs /path/to/gtfs.zip            # next 2 weekends
  python3 build_reachability.py --gtfs gtfs.zip --dates 2026-11-21,2026-11-22

Output (in ../data):
  manifest.json                       dates, slots, origins, ...
  stations.json                       [[id, name, lat, lon, mode_bits], ...]
  reach_<origin>_<YYYYMMDD>.bin.gz    uint8 minutes (255 = unreachable),
                                      layout [slot][changes 0..K][station]
"""
import argparse
import bisect
import csv
import glob
import gzip
import io
import json
import math
import multiprocessing as mp
import os
import sys
import time
import zipfile
from datetime import date as Date, timedelta

# ---------------------------------------------------------------- config --- #

# origin key -> list of (exact GTFS stop name, walking minutes from the "door")
ORIGINS = {
    'gare': {'label': 'Lausanne gare', 'stops': [('Lausanne', 0)]},
    'home': {'label': 'Home (Montétan)',
             'stops': [('Lausanne, Montétan', 0), ('Lausanne, Chauderon', 9)]},
}

MAX_CHANGES = 4            # K: results for 0..K changes
TRANSFER_BUFFER_S = 120    # min time to change vehicle at the same station
MAX_WALK_M = 400           # footpaths between stations closer than this
WALK_SPEED_MS = 1.1        # ~4 km/h (straight line, so a bit conservative)
NONE = 255                 # "unreachable" in the binary output


def mode_of(rt):
    """route_type (basic + extended GTFS) -> mode group."""
    rt = int(rt)
    if rt == 2 or 100 <= rt < 200:
        return 'rail'
    if rt == 3 or 200 <= rt < 300 or 700 <= rt < 800:
        return 'bus'
    if rt == 1 or 400 <= rt < 500:
        return 'metro'
    if rt == 0 or 900 <= rt < 1000:
        return 'tram'
    if rt == 4 or 1000 <= rt < 1100 or rt == 1200:
        return 'boat'
    return 'cable'  # funicular, gondola, cable car, ...


MODE_BITS = {'rail': 1, 'bus': 2, 'metro': 4, 'tram': 8, 'boat': 16, 'cable': 32}

# ----------------------------------------------------------------- utils --- #

class Gtfs:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path) if path.endswith('.zip') else None
        self.path = path

    def rows(self, name):
        if self.zip:
            if name not in self.zip.namelist():
                return iter(())
            f = io.TextIOWrapper(self.zip.open(name), encoding='utf-8-sig')
        else:
            p = os.path.join(self.path, name)
            if not os.path.exists(p):
                return iter(())
            f = open(p, encoding='utf-8-sig', newline='')
        return csv.DictReader(f)


def hms(s):
    h, m, sec = s.split(':')
    return int(h) * 3600 + int(m) * 60 + int(sec)


def hhmm(s):
    return f'{s // 3600:02d}:{(s % 3600) // 60:02d}'


def log(*a):
    print(f'[{time.strftime("%H:%M:%S")}]', *a, file=sys.stderr, flush=True)


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


def next_weekends(today, n=2):
    """Sat/Sun of the next n weekends (the current one included if today is Sat/Sun)."""
    sat = today + timedelta(days=(5 - today.weekday()) % 7)
    if today.weekday() == 6:
        sat = today - timedelta(days=1)
    out = []
    for w in range(n):
        for d in (0, 1):
            day = sat + timedelta(days=7 * w + d)
            if day >= today:
                out.append(day)
    return out

# --------------------------------------------------------------- loading --- #

def services_on(g, days):
    """service_id -> set of day indexes (into days) it runs on."""
    wds = [d.weekday() for d in days]
    ymds = [d.strftime('%Y%m%d') for d in days]
    names = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    act = {}
    for r in g.rows('calendar.txt'):
        for i, (wd, ymd) in enumerate(zip(wds, ymds)):
            if r['start_date'] <= ymd <= r['end_date'] and r[names[wd]] == '1':
                act.setdefault(r['service_id'], set()).add(i)
    for r in g.rows('calendar_dates.txt'):
        if r['date'] in ymds:
            i = ymds.index(r['date'])
            if r['exception_type'] == '1':
                act.setdefault(r['service_id'], set()).add(i)
            else:
                act.get(r['service_id'], set()).discard(i)
    return act


def load(g, days, t_min, t_max, modes):
    log('calendar...')
    services = services_on(g, days)
    for i, d in enumerate(days):
        n = sum(1 for s in services.values() if i in s)
        log(f'  {d}: {n} active services' + ('  <-- WARNING: date outside feed?' if n == 0 else ''))

    route_mode = {r['route_id']: mode_of(r['route_type']) for r in g.rows('routes.txt')}

    trips = {}       # trip_id -> (idx, mode)
    trip_days = []   # idx -> set of day indexes
    for r in g.rows('trips.txt'):
        s = services.get(r['service_id'])
        if s:
            m = route_mode.get(r['route_id'], 'bus')
            if m in modes:
                trips[r['trip_id']] = (len(trips), m)
                trip_days.append(frozenset(s))
    log(f'  {len(trips)} trips on selected dates')

    log('stops...')
    raw = {r['stop_id']: r for r in g.rows('stops.txt')}
    station_idx, stations, stop_to_station = {}, [], {}
    for sid, r in raw.items():
        parent = r.get('parent_station') or ''
        root = parent if parent in raw else sid
        if root not in station_idx:
            pr = raw[root]
            station_idx[root] = len(stations)
            stations.append({'id': root, 'name': pr['stop_name'],
                             'lat': float(pr['stop_lat'] or 0),
                             'lon': float(pr['stop_lon'] or 0), 'modes': 0})
        stop_to_station[sid] = station_idx[root]
    log(f'  {len(stations)} stations')

    log('stop_times (slow, streams the big file)...')
    deps, arrs, frm, to, trp = [], [], [], [], []

    def flush(tid, seq):
        ti, m = trips[tid]
        bit = MODE_BITS[m]
        seq.sort()
        for (_, _, d, s1), (_, a, _, s2) in zip(seq, seq[1:]):
            if t_min <= d <= t_max and s1 != s2:
                deps.append(d); arrs.append(a); frm.append(s1); to.append(s2); trp.append(ti)
                stations[s1]['modes'] |= bit
                stations[s2]['modes'] |= bit

    cur, seq, n = None, [], 0
    for r in g.rows('stop_times.txt'):
        n += 1
        if n % 2_000_000 == 0:
            log(f'  {n // 1_000_000}M rows, {len(deps)} connections')
        tid = r['trip_id']
        if tid != cur:
            if seq:
                flush(cur, seq)
            cur, seq = tid, []
        if tid not in trips:
            continue
        seq.append((int(r['stop_sequence']), hms(r['arrival_time']),
                    hms(r['departure_time']), stop_to_station[r['stop_id']]))
    if seq:
        flush(cur, seq)
    log(f'  {len(deps)} connections in time window (all dates)')

    order = sorted(range(len(deps)), key=deps.__getitem__)
    conns = ([deps[i] for i in order], [arrs[i] for i in order],
             [frm[i] for i in order], [to[i] for i in order], [trp[i] for i in order])
    return stations, conns, trip_days


def footpaths(stations):
    """Walking links between served stations within MAX_WALK_M (grid bucketed)."""
    cell = 0.01
    grid = {}
    for i, s in enumerate(stations):
        if s['modes']:
            grid.setdefault((int(s['lat'] / cell), int(s['lon'] / cell)), []).append(i)
    fp = [[] for _ in stations]
    for (gx, gy), members in grid.items():
        near = [j for dx in (-1, 0, 1) for dy in (-1, 0, 1) for j in grid.get((gx + dx, gy + dy), ())]
        for i in members:
            a = stations[i]
            for j in near:
                if j != i:
                    b = stations[j]
                    d = haversine_m(a['lat'], a['lon'], b['lat'], b['lon'])
                    if d <= MAX_WALK_M:
                        fp[i].append((j, int(d / WALK_SPEED_MS) + 60))
    log(f'  {sum(map(len, fp))} footpaths')
    return fp

# ------------------------------------------------------------------- CSA --- #

def csa(conns, n_st, fp, sources, t0, max_dur):
    """sources: [(station, time)]. Returns arr[r][s], r = number of rides used."""
    INF = 1 << 30
    deps, arrs, frm, to, trp = conns
    R = MAX_CHANGES + 1
    arr = [[INF] * n_st for _ in range(R + 1)]
    trip_r = {}

    def improve(s, r, t):
        for rr in range(r, R + 1):
            if arr[rr][s] > t:
                arr[rr][s] = t
            else:
                break

    for s, t in sources:
        improve(s, 0, t)
        for w, ws in fp[s]:
            improve(w, 0, t + ws)

    t_end = t0 + max_dur
    i, n = bisect.bisect_left(deps, t0), len(deps)
    while i < n:
        d = deps[i]
        if d > t_end:
            break
        t, u = trp[i], frm[i]
        best = trip_r.get(t, INF)
        for r in range(0, min(best - 1, R)):
            if arr[r][u] + (TRANSFER_BUFFER_S if r else 0) <= d:
                best = r + 1
                trip_r[t] = best
                break
        if best <= R:
            a2 = arrs[i]
            if a2 <= t_end:
                v = to[i]
                if arr[best][v] > a2:
                    improve(v, best, a2)
                    for w, ws in fp[v]:
                        improve(w, best, a2 + ws)
        i += 1
    return arr

# ------------------------------------------------------------------ main --- #

G = {}  # shared with forked workers


def run_day(di):
    """Compute all origins x slots for one date; write one .bin.gz per origin."""
    days, conns, trip_days = G['days'], G['conns'], G['trip_days']
    day = days[di]
    keep = [i for i, t in enumerate(conns[4]) if di in trip_days[t]]
    dconns = tuple([col[i] for i in keep] for col in conns)
    n_st, served, K = len(G['stations']), G['served'], MAX_CHANGES
    for key, origin_st in G['origin_st'].items():
        buf = bytearray()
        for t0 in G['slots']:
            arr = csa(dconns, n_st, G['fp'], [(s, t0 + w) for s, w in origin_st], t0, G['max_dur'])
            for k in range(K + 1):
                row = arr[k + 1]
                for s in served:
                    m = (row[s] - t0 + 30) // 60
                    buf.append(m if m <= G['max_min'] else NONE)
        path = os.path.join(G['out'], f'reach_{key}_{day.strftime("%Y%m%d")}.bin.gz')
        with gzip.open(path, 'wb', compresslevel=9) as f:
            f.write(bytes(buf))
        log(f'  wrote {os.path.basename(path)} ({os.path.getsize(path) // 1024} KB)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--gtfs', required=True, help='GTFS dir or .zip')
    ap.add_argument('--dates', help='YYYY-MM-DD,... (default: next 2 weekends)')
    ap.add_argument('--window', default='06:00-12:00', help='departure slots range, HH:MM-HH:MM')
    ap.add_argument('--step', type=int, default=10, help='minutes between departure slots')
    ap.add_argument('--max-hours', type=float, default=4)
    ap.add_argument('--modes', default='rail,bus,metro,tram,boat,cable')
    ap.add_argument('--jobs', type=int, default=min(4, os.cpu_count() or 1))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data'))
    a = ap.parse_args()

    days = ([Date.fromisoformat(x) for x in a.dates.split(',')] if a.dates
            else next_weekends(Date.today()))
    w0, w1 = [hms(x + ':00') for x in a.window.split('-')]
    max_dur = int(a.max_hours * 3600)
    assert max_dur // 60 < NONE, 'max-hours too large for uint8 output'
    log('dates:', ', '.join(map(str, days)))

    g = Gtfs(a.gtfs)
    stations, conns, trip_days = load(g, days, w0, w1 + max_dur, set(a.modes.split(',')))
    fp = footpaths(stations)
    served = [i for i, s in enumerate(stations) if s['modes']]

    by_name = {}
    for i in served:
        by_name.setdefault(stations[i]['name'], []).append(i)
    origin_st = {}
    for key, cfg in ORIGINS.items():
        lst = []
        for name, walk in cfg['stops']:
            hits = by_name.get(name, [])
            if not hits:
                log(f'  WARNING: stop "{name}" not found/served (check exact name in stops.txt)')
            lst += [(i, walk * 60) for i in hits]
        if not lst:
            sys.exit(f'no served origin stop for {key}')
        origin_st[key] = lst

    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    for f in glob.glob(os.path.join(out, 'reach_*')):  # drop previous outputs
        os.remove(f)

    G.update(days=days, conns=conns, trip_days=trip_days, stations=stations, fp=fp,
             served=served, origin_st=origin_st, slots=list(range(w0, w1 + 1, a.step * 60)),
             max_dur=max_dur, max_min=max_dur // 60, out=out)
    log(f'computing {len(days)} dates x {len(ORIGINS)} origins x {len(G["slots"])} slots '
        f'with {a.jobs} jobs...')
    if a.jobs > 1 and len(days) > 1:
        with mp.get_context('fork').Pool(min(a.jobs, len(days))) as pool:
            pool.map(run_day, range(len(days)))
    else:
        for di in range(len(days)):
            run_day(di)

    with open(os.path.join(out, 'stations.json'), 'w', encoding='utf-8') as f:
        json.dump([[stations[i]['id'], stations[i]['name'], round(stations[i]['lat'], 5),
                    round(stations[i]['lon'], 5), stations[i]['modes']] for i in served],
                  f, ensure_ascii=False, separators=(',', ':'))
    manifest = {
        'generated': time.strftime('%Y-%m-%d %H:%M'),
        'gtfs': os.path.basename(a.gtfs.rstrip('/')),
        'dates': [d.isoformat() for d in days],
        'slots': [hhmm(t) for t in G['slots']],
        'max_changes': MAX_CHANGES, 'max_minutes': max_dur // 60, 'none': NONE,
        'mode_bits': MODE_BITS, 'n_stations': len(served),
        'origins': {k: {'label': v['label'], 'stops': [n for n, _ in v['stops']]}
                    for k, v in ORIGINS.items()},
    }
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    log(f'done: {len(served)} stations, manifest + stations.json written to {out}')


if __name__ == '__main__':
    main()
