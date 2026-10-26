/**
 * Hurricane Tracker: Automated Scheduled Fetcher (Node.js)
 * Sourced strictly from US National Hurricane Center (NOAA) public feeds.
 * Implements the Oct 24, 2026 decision: NO cache layer, NO paid plan.
 *
 * Baseline: 2 fetches per day at 06:00 and 18:00 America/Toronto time.
 * Escalation: 4 fetches per day (00:00, 06:00, 12:00, 18:00 America/Toronto)
 * while any active storm or its forecast is within 500 km of Puerto Vallarta
 * (20.65 N, 105.23 W) or Cabo San Lucas (22.89 N, 109.91 W).
 *
 * Saves to:
 *   data/current-storms.json
 *   data/hurricane-tracker.txt
 *   install/upload/hurricane-tracker.txt
 *   install/upload/hurricane-tracker.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_JSON_PATH = path.join(ROOT, 'data', 'current-storms.json');
const DATA_TXT_PATH = path.join(ROOT, 'data', 'hurricane-tracker.txt');
const UPLOAD_TXT_PATH = path.join(ROOT, 'install', 'upload', 'hurricane-tracker.txt');
const UPLOAD_JSON_PATH = path.join(ROOT, 'install', 'upload', 'hurricane-tracker.json');

const NHC_CURRENT_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

const LOCATIONS = {
  pv: { name: 'Puerto Vallarta', lat: 20.65, lon: -105.23 },
  cabo: { name: 'Cabo San Lucas', lat: 22.89, lon: -109.91 }
};

const ESCALATION_KM = 500;

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 12742 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingCompass8(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLon = (lon2 - lon1) * r;
  const y = Math.sin(dLon) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos(dLon);
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((Math.atan2(y, x) * 180) / Math.PI % 360) + 360) % 360 / 45) % 8];
}

function saffirSimpsonCategory(cls, intensityKt) {
  if (String(cls || '').toUpperCase() !== 'HU') return null;
  const kt = Number(intensityKt) || 0;
  if (kt >= 137) return 5;
  if (kt >= 113) return 4;
  if (kt >= 96) return 3;
  if (kt >= 83) return 2;
  if (kt >= 64) return 1;
  return null;
}

function isEasternPacific(storm) {
  if (!storm || typeof storm !== 'object') return false;
  const id = String(storm.id || '').toLowerCase();
  const bin = String(storm.binNumber || '').toUpperCase();
  return id.startsWith('ep') || /^EP[1-5]$/.test(bin);
}

function normalizeStorm(raw) {
  const lat = Number(raw.latitudeNumeric);
  const lon = Number(raw.longitudeNumeric);
  const intensityKt = Number(raw.intensity) || 0;
  const cls = String(raw.classification || 'TC').toUpperCase();

  const distKm = {
    pv: Math.round(haversineKm(LOCATIONS.pv.lat, LOCATIONS.pv.lon, lat, lon)),
    cabo: Math.round(haversineKm(LOCATIONS.cabo.lat, LOCATIONS.cabo.lon, lat, lon))
  };

  const bearingFrom = {
    pv: bearingCompass8(LOCATIONS.pv.lat, LOCATIONS.pv.lon, lat, lon),
    cabo: bearingCompass8(LOCATIONS.cabo.lat, LOCATIONS.cabo.lon, lat, lon)
  };

  let advUrl = (raw.publicAdvisory && raw.publicAdvisory.url) || 'https://www.nhc.noaa.gov/?epac';
  if (!advUrl.startsWith('https://www.nhc.noaa.gov/')) {
    advUrl = 'https://www.nhc.noaa.gov/?epac';
  }

  const idUp = String(raw.id || '').toUpperCase();
  const coneUrl = /^[A-Z]{2}\d{6}$/.test(idUp)
    ? `https://www.nhc.noaa.gov/storm_graphics/${idUp.slice(0, 4)}/${idUp}_5day_cone.png`
    : '';

  return {
    id: String(raw.id || ''),
    bin_number: String(raw.binNumber || ''),
    name: String(raw.name || ''),
    classification: cls,
    category: saffirSimpsonCategory(cls, intensityKt),
    intensity_kt: intensityKt,
    pressure_mb: raw.pressure ? Number(raw.pressure) : null,
    lat: lat,
    lon: lon,
    movement_dir_deg: Number(raw.movementDir) || 0,
    movement_speed_kt: Number(raw.movementSpeed) || 0,
    last_update: raw.lastUpdate || new Date().toISOString(),
    advisory_url: advUrl,
    cone_url: coneUrl,
    distance_km: distKm,
    bearing_from: bearingFrom
  };
}

async function parseForecastTrackMinDistance(storm) {
  const result = {
    min_forecast_distance_km: {
      pv: Math.round(haversineKm(LOCATIONS.pv.lat, LOCATIONS.pv.lon, Number(storm.latitudeNumeric), Number(storm.longitudeNumeric))),
      cabo: Math.round(haversineKm(LOCATIONS.cabo.lat, LOCATIONS.cabo.lon, Number(storm.latitudeNumeric), Number(storm.longitudeNumeric)))
    }
  };

  if (
    !storm.forecastAdvisory ||
    typeof storm.forecastAdvisory.url !== 'string' ||
    !storm.forecastAdvisory.url.startsWith('https://www.nhc.noaa.gov/')
  ) {
    return result;
  }

  try {
    const fRes = await fetch(storm.forecastAdvisory.url, {
      headers: { 'User-Agent': 'HurricaneTrackerStaticFetcher/1.0' }
    });
    if (!fRes.ok) return result;
    const text = await fRes.text();

    const trackPointRegex = /(\d{1,2}\.\d)N\s+(\d{2,3}\.\d)W/g;
    let match;
    while ((match = trackPointRegex.exec(text)) !== null) {
      const fLat = parseFloat(match[1]);
      const fLon = -parseFloat(match[2]);
      const distPv = Math.round(haversineKm(LOCATIONS.pv.lat, LOCATIONS.pv.lon, fLat, fLon));
      const distCabo = Math.round(haversineKm(LOCATIONS.cabo.lat, LOCATIONS.cabo.lon, fLat, fLon));

      if (distPv < result.min_forecast_distance_km.pv) {
        result.min_forecast_distance_km.pv = distPv;
      }
      if (distCabo < result.min_forecast_distance_km.cabo) {
        result.min_forecast_distance_km.cabo = distCabo;
      }
    }
  } catch (e) {
    // Forecast advisory fetch optional; fallback to current coordinates
  }
  return result;
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = filePath + '.tmp.' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

async function main() {
  const checkedAt = new Date().toISOString();
  const checkedDate = checkedAt.slice(0, 10);

  const res = await fetch(NHC_CURRENT_STORMS_URL, {
    headers: { 'User-Agent': 'HurricaneTrackerStaticFetcher/1.0' }
  });
  if (!res.ok) {
    throw new Error(`NHC fetch failed with HTTP ${res.status}`);
  }

  const rawJson = await res.json();
  const activeStorms = Array.isArray(rawJson.activeStorms) ? rawJson.activeStorms : [];
  const epRawStorms = activeStorms.filter(isEasternPacific);
  const normalizedStorms = epRawStorms.map(normalizeStorm);

  let minTrackPv = Infinity;
  let minTrackCabo = Infinity;

  for (let i = 0; i < epRawStorms.length; i++) {
    const trackCheck = await parseForecastTrackMinDistance(epRawStorms[i]);
    normalizedStorms[i].min_forecast_distance_km = trackCheck.min_forecast_distance_km;
    if (trackCheck.min_forecast_distance_km.pv < minTrackPv) {
      minTrackPv = trackCheck.min_forecast_distance_km.pv;
    }
    if (trackCheck.min_forecast_distance_km.cabo < minTrackCabo) {
      minTrackCabo = trackCheck.min_forecast_distance_km.cabo;
    }
  }

  const isEscalated = minTrackPv <= ESCALATION_KM || minTrackCabo <= ESCALATION_KM;

  const output = {
    checked_at: checkedAt,
    source_url: NHC_CURRENT_STORMS_URL,
    activeStorms: activeStorms,
    storms: normalizedStorms,
    meta: {
      schema_version: '1.0.0',
      source_name: 'US National Hurricane Center (NOAA)',
      source_url: NHC_CURRENT_STORMS_URL,
      smn_source_url: 'https://smn.conagua.gob.mx/es/ciclones-tropicales/temporada-ciclones-tropicales-2026',
      sshws_source_url: 'https://www.nhc.noaa.gov/aboutsshws.php',
      season_source_url: 'https://www.nhc.noaa.gov/climo/',
      source_checked_date: checkedDate,
      checked_at: checkedAt,
      schedule: {
        mode: isEscalated ? 'escalated' : 'baseline',
        fetches_per_day: isEscalated ? 4 : 2,
        times_toronto: isEscalated
          ? ['00:00', '06:00', '12:00', '18:00']
          : ['06:00', '18:00'],
        escalation_threshold_km: ESCALATION_KM,
        closest_approach_km: {
          pv: Number.isFinite(minTrackPv) ? minTrackPv : null,
          cabo: Number.isFinite(minTrackCabo) ? minTrackCabo : null
        }
      }
    }
  };

  const serialized = JSON.stringify(output, null, 2) + '\n';
  writeAtomic(DATA_JSON_PATH, serialized);
  writeAtomic(DATA_TXT_PATH, serialized);
  writeAtomic(UPLOAD_JSON_PATH, serialized);
  writeAtomic(UPLOAD_TXT_PATH, serialized);

  console.log(`Saved ${DATA_JSON_PATH}, ${DATA_TXT_PATH}, and upload mirrors.`);
  console.log(`Active Eastern Pacific storms: ${normalizedStorms.length}`);
  console.log(`Schedule mode: ${output.meta.schedule.mode} (${output.meta.schedule.fetches_per_day}x/day)`);
}

main().catch(err => {
  console.error('Error fetching NHC data:', err.message);
  process.exit(1);
});
