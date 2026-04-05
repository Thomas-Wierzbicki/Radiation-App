require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3003;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- CACHE & DB ---
let cachedRadiationData = null;
let lastCacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 Minuten
let PLZ_DATABASE = new Map();

// --- PLAUSIBILITÄT DEUTSCHLAND ---
function isPlausibleGermanyCoordinate(lat, lon) {
    // grobe Bounding Box Deutschland
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        lat >= 47.0 &&
        lat <= 55.5 &&
        lon >= 5.0 &&
        lon <= 15.6
    );
}

// --- PLZ DATENBANK LADEN ---
function initPlzDb() {
    const plzPath = path.join(__dirname, 'plz_geocoord.csv');
    if (fs.existsSync(plzPath)) {
        const content = fs.readFileSync(plzPath, 'utf8');
        content.split(/\r?\n/).forEach((line, i) => {
            if (i === 0 || !line.trim()) return;
            const p = line.split(',');
            const plz = (p[0] || '').replace(/"/g, '').trim();
            const lat = parseFloat((p[1] || '').replace(/"/g, ''));
            const lon = parseFloat((p[2] || '').replace(/"/g, ''));
            if (plz && isPlausibleGermanyCoordinate(lat, lon)) {
                PLZ_DATABASE.set(plz, { lat, lon });
            }
        });
        console.log(`✅ PLZ-DB geladen: ${PLZ_DATABASE.size} Einträge.`);
    } else {
        console.error("❌ Kritisch: plz_geocoord.csv fehlt im Hauptverzeichnis!");
    }
}
initPlzDb();

// --- HILFSFUNKTION: KOORDINATEN ERMITTELN ---
function getStationCoordinates(feature) {
    const p = feature?.properties || {};
    const stationPlz = p.plz ? String(p.plz).trim() : null;

    // 1. Bevorzugt echte Koordinaten aus dem BfS-GeoJSON
    // BfS: [lon, lat]
    const geometryCoords = feature?.geometry?.coordinates;
    if (
        Array.isArray(geometryCoords) &&
        geometryCoords.length >= 2
    ) {
        const lon = Number(geometryCoords[0]);
        const lat = Number(geometryCoords[1]);

        if (isPlausibleGermanyCoordinate(lat, lon)) {
            return {
                lat,
                lon,
                source: 'bfs'
            };
        } else {
            console.warn(`⚠️ Unplausible BfS-Koordinate verworfen: lat=${lat}, lon=${lon}, Station=${p.name || 'unbekannt'}`);
        }
    }

    // 2. Fallback: PLZ-Koordinaten aus lokaler CSV
    // auch nur dann, wenn PLZ vorhanden und plausibel
    if (stationPlz && PLZ_DATABASE.has(stationPlz)) {
        const coords = PLZ_DATABASE.get(stationPlz);

        if (isPlausibleGermanyCoordinate(coords.lat, coords.lon)) {
            return {
                lat: coords.lat,
                lon: coords.lon,
                source: 'plz'
            };
        }
    }

    // 3. Nichts gefunden
    return null;
}

// --- API ENDPUNKT ---
app.get('/api/radiation', async (req, res) => {
    const now = Date.now();

    if (cachedRadiationData && (now - lastCacheTime < CACHE_DURATION)) {
        return res.json(cachedRadiationData);
    }

    console.log('☢️ Abfrage BfS OpenData...');

    try {
        const response = await axios.get("https://www.imis.bfs.de/ogc/opendata/ows", {
            params: {
                service: 'WFS',
                version: '1.1.0',
                request: 'GetFeature',
                typeName: 'opendata:odlinfo_odl_1h_latest',
                outputFormat: 'application/json'
            },
            timeout: 45000
        });

        if (response.data && Array.isArray(response.data.features)) {
            const mappedStations = response.data.features.map(f => {
                const p = f.properties || {};
                const stationPlz = p.plz ? String(p.plz).trim() : null;
                const coords = getStationCoordinates(f);

                // Station nur verwerfen, wenn wirklich keinerlei brauchbare Koordinaten da sind
                if (!coords) {
                    return null;
                }

                return {
                    n: p.name || "unbekannt",
                    plz: stationPlz,              // darf auch null sein
                    v: p.value || 0,
                    v_ter: p.value_terrestrial || 0,
                    v_cos: p.value_cosmic || 0,
                    h: p.height_above_sea || 0,
                    st: p.site_status_text || "unbekannt",
                    ts: p.end_measure || null,
                    lt: coords.lat,
                    ln: coords.lon,
                    coord_source: coords.source
                };
            }).filter(Boolean);

            cachedRadiationData = mappedStations;
            lastCacheTime = now;

            const bfsCount = mappedStations.filter(s => s.coord_source === 'bfs').length;
            const plzCount = mappedStations.filter(s => s.coord_source === 'plz').length;
            const noPlzCount = mappedStations.filter(s => !s.plz && s.coord_source === 'bfs').length;

            console.log(`✅ ${mappedStations.length} Stationen verarbeitet.`);
            console.log(`📍 Koordinatenquelle: BfS=${bfsCount}, PLZ-Fallback=${plzCount}`);
            console.log(`📭 Stationen ohne PLZ, aber mit echten BfS-Koordinaten: ${noPlzCount}`);

            return res.json(mappedStations);
        }

        return res.status(502).json({ error: "Unerwartete Antwort vom BfS" });
    } catch (e) {
        console.error(`❌ Fehler: ${e.message}`);
        return res.status(500).json({ error: "BfS-Schnittstelle hakt" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Lagezentrum-Server bereit auf Port ${PORT}`);
});
