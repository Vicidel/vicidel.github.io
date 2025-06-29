# Playbook

### Strava activities

Go to [Strava API](https://www.strava.com/settings/api), then setup a token. Then run the `get_activities.sh` script and input them. This should create a file with the client ID in data.

### Roads
If you want roads: go to [Overpass](https://overpass-turbo.eu/#), then add this input (for all drivable roads in Lausanne)
```
[out:json][timeout:25];
area["name"="Lausanne"]->.searchArea;
(  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"](area.searchArea);
);
out geom;
```

Then export as GeoJSON, save in `data/lausanne_roads.geojson`