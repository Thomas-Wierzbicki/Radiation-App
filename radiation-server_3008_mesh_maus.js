require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3003;

// CARTO API-Key
const CARTO_API_KEY = process.env.CARTO_API_KEY ? process.env.CARTO_API_KEY.trim() : '';

// MQTT / MeshCom
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://127.0.0.1';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'meshcom/tx';
const CALL_DST = process.env.CALL_DST || '9';
const RED_THRESHOLD = parseFloat(process.env.RED_THRESHOLD || '0.20');

// Optionaler Filter nach 1. Ziffer der PLZ (z.B. "4,5")
const FILTER_PLZ_ZONES = process.env.FILTER_PLZ_ZONES 
    ? process.env.FILTER_PLZ_ZONES.split(',').map(s => s.trim()) 
    : [];

const UPDATE_INTERVAL_MS = (parseInt(process.env.UPDATE_INTERVAL_MINUTES, 10) || 10) * 60 * 1000;

let cachedRadiationData = [];
let lastCacheTime = 0;
let PLZ_DATABASE = new Map();
let mqttConnected = false;
let updateRunning = false;

// --- MQTT CLIENT ---
const mqttClient = mqtt.connect(MQTT_BROKER);

mqttClient.on('connect', () => { 
    mqttConnected = true; 
    console.log(`✅ MQTT verbunden: ${MQTT_BROKER}`); 
});

mqttClient.on('reconnect', () => {
    mqttConnected = false;
    console.log('↻ MQTT reconnect...');
});

mqttClient.on('close', () => {
    mqttConnected = false;
    console.log('⚠️ MQTT Verbindung geschlossen');
});

mqttClient.on('offline', () => {
    mqttConnected = false;
    console.log('⚠️ MQTT offline');
});

mqttClient.on('error', (err) => { 
    mqttConnected = false; 
    console.error('❌ MQTT Fehler:', err.message); 
});

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// Request-Logger
app.use((req, res, next) => {
    console.log(`📡 [${req.method}] ${req.url}`);
    next();
});

// --- API ROUTEN ---
app.get('/api/test', (req, res) => {
    res.send("TEST ROUTE FUNKTIONIERT!");
});

app.get('/api/config', (req, res) => {
    res.json({ cartoApiKey: CARTO_API_KEY });
});

app.get('/api/radiation', (req, res) => {
    res.json(cachedRadiationData || []);
});


// --- API ROUTE: Manuelles Senden per Mausklick ---
app.post('/api/publish-station', (req, res) => {
    const station = req.body;

    if (!station || typeof station.v === 'undefined') {
        return res.status(400).json({ ok: false, error: 'Ungültige Stationsdaten' });
    }

    if (!mqttConnected) {
        return res.status(503).json({ ok: false, error: 'MQTT Broker nicht verbunden' });
    }

    try {
        publishRedStation(station);
        res.json({ ok: true, message: `Station ${station.n || 'unbekannt'} erfolgreich ausgesendet` });
    } catch (err) {
        console.error('❌ Fehler beim manuellen MQTT-Senden:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});




app.get('/healthz', (req, res) => {
    res.json({ 
        ok: true, 
        mqttConnected,
        updateRunning,
        entries: Array.isArray(cachedRadiationData) ? cachedRadiationData.length : 0, 
        cacheAgeSeconds: lastCacheTime ? Math.round((Date.now() - lastCacheTime) / 1000) : null,
        redThreshold: RED_THRESHOLD,
        filterPlzZones: FILTER_PLZ_ZONES,
        mqttTopic: MQTT_TOPIC,
        callDst: CALL_DST,
        updateIntervalMinutes: Math.round(UPDATE_INTERVAL_MS / 60000)
    });
});

// Statische Dateien (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// --- HILFSFUNKTIONEN ---
function isPlausibleGermanyCoordinate(lat, lon) {
    return (
        Number.isFinite(lat) && 
        Number.isFinite(lon) && 
        lat >= 47.0 && 
        lat <= 55.5 && 
        lon >= 5.0 && 
        lon <= 15.6
    );
}

function initPlzDb() {
    const plzPath = path.join(__dirname, 'plz_geocoord.csv');
    if (!fs.existsSync(plzPath)) {
        console.error('❌ plz_geocoord.csv fehlt');
        return;
    }

    try {
        const content = fs.readFileSync(plzPath, 'utf8');
        content.split(/\r?\n/).forEach((line, i) => {
            if (i === 0 || !line.trim()) return;
            const p = line.split(',');
            const plz = (p[0] || '').replace(/"/g, '').trim();
            const lat = parseFloat((p[1] || '').replace(/"/g, '').trim());
            const lon = parseFloat((p[2] || '').replace(/"/g, '').trim());
            if (plz && isPlausibleGermanyCoordinate(lat, lon)) {
                PLZ_DATABASE.set(plz, { lat, lon });
            }
        });
        console.log(`✅ PLZ-DB geladen: ${PLZ_DATABASE.size} Einträge`);
    } catch (err) { 
        console.error('❌ PLZ-DB Fehler:', err.message); 
    }
}

function getStationCoordinates(feature) {
    const p = feature?.properties || {};
    const geometryCoords = feature?.geometry?.coordinates;
    if (Array.isArray(geometryCoords) && geometryCoords.length >= 2) {
        const lon = Number(geometryCoords[0]);
        const lat = Number(geometryCoords[1]);
        if (isPlausibleGermanyCoordinate(lat, lon)) return { lat, lon, source: 'bfs' };
    }
    const plz = p.plz != null ? String(p.plz).trim() : null;
    if (plz && PLZ_DATABASE.has(plz)) {
        const coords = PLZ_DATABASE.get(plz);
        return { lat: coords.lat, lon: coords.lon, source: 'plz' };
    }
    return null;
}

function buildMappedStations(features) {
    return features.map((f) => {
        const p = f.properties || {};
        const stationPlz = p.plz != null ? String(p.plz).trim() : null;

        // PLZ-Zonenfilterung
        if (FILTER_PLZ_ZONES.length > 0) {
            const firstDigit = stationPlz ? stationPlz[0] : null;
            if (!FILTER_PLZ_ZONES.includes(firstDigit)) return null;
        }

        const coords = getStationCoordinates(f);
        if (!coords) return null;

        return {
            n: p.name || 'unbekannt',
            plz: stationPlz,
            v: Number(p.value || 0),
            v_ter: Number(p.value_terrestrial || 0),
            v_cos: Number(p.value_cosmic || 0),
            h: Number(p.height ?? p.site_elevation ?? p.height_above_sea ?? 0),
            st: p.site_status_text || 'unbekannt',
            ts: p.end_measure || null,
            lt: coords.lat,
            ln: coords.lon,
            coord_source: coords.source
        };
    }).filter(Boolean);
}

// --- MESHCOM / MQTT ALERTING ---
function publishRedStation(station) {
    if (!mqttConnected) {
        console.warn(`⚠️ MQTT nicht verbunden, überspringe: ${station.n || 'unbekannt'}`);
        return;
    }

    const valueText = Number.isFinite(station.v) ? station.v.toFixed(2) : '0.00';
    const placeRaw = station.n || 'unbekannt';

    // ASCII-Bereinigung für Mesh-Clients
    const place = String(placeRaw).replace(/[^a-zA-Z0-9 .,_\-()/]/g, '');
    const msg = `☢️ RAD ${valueText} µSv/h ${place}`.substring(0, 140);
    
    const payload = {
        type: 'msg',
        dst: String(CALL_DST),
        msg
    };

    const payloadStr = JSON.stringify(payload);
    console.log(`📡 MQTT SEND (${MQTT_TOPIC}): ${payloadStr}`);

    mqttClient.publish(MQTT_TOPIC, payloadStr, (err) => {
        if (err) {
            console.error(`❌ MQTT publish Fehler für ${place}:`, err.message);
        } else {
            console.log(`✅ MQTT OK: ${place}`);
        }
    });
}

function getRedStations(stations) {
    return stations.filter((s) => Number.isFinite(s.v) && s.v >= RED_THRESHOLD);
}

function logRedStations(prefix, stations) {
    const redStations = getRedStations(stations);
    console.log(`🔴 ${prefix}: rote Stationen = ${redStations.length}, Threshold = ${RED_THRESHOLD}`);

    if (redStations.length > 0) {
        redStations.forEach((s) => {
            console.log(`   • ${s.n} | ${s.v} µSv/h | ${s.plz || 'ohne PLZ'} | ${s.coord_source || 'unbekannt'}`);
        });
    }

    return redStations;
}

function sendRedStationsAsync(redStations) {
    setImmediate(() => {
        try {
            for (const station of redStations) {
                publishRedStation(station);
            }
        } catch (err) {
            console.error('❌ Fehler beim MQTT-Senden:', err.message);
        }
    });
}

// --- DATEN-UPDATE ---
async function updateRadiationData() {
    if (updateRunning) {
        console.log('⏭️ Update übersprungen, vorheriger Lauf noch aktiv');
        return;
    }

    updateRunning = true;
    console.log('☢️ Hintergrundabruf gestartet');

    try {
        const response = await axios.get('https://www.imis.bfs.de/ogc/opendata/ows', {
            params: { 
                service: 'WFS', 
                version: '1.1.0', 
                request: 'GetFeature', 
                typeName: 'opendata:odlinfo_odl_1h_latest', 
                outputFormat: 'application/json' 
            },
            timeout: 45000
        });

        if (response.data?.features && Array.isArray(response.data.features)) {
            const mappedStations = buildMappedStations(response.data.features);
            
            cachedRadiationData = mappedStations;
            lastCacheTime = Date.now();
            console.log(`☢️ Daten-Update: ${cachedRadiationData.length} Stationen im Cache.`);

            // Schwellenwert-Prüfung & MQTT-Aussendung
            const redStations = logRedStations('Update', mappedStations);
            sendRedStationsAsync(redStations);
        } else {
            console.error('❌ Unerwartete Antwort vom BfS');
        }
    } catch (err) { 
        console.error(`❌ BfS-Fehler: ${err.message}`); 
    } finally {
        updateRunning = false;
    }
}

// --- START ---
if (!CARTO_API_KEY) {
    console.warn('⚠️ CARTO_API_KEY nicht in .env gefunden!');
} else {
    console.log('[OK] CARTO_API_KEY geladen.');
}

initPlzDb();

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server läuft auf Port ${PORT}`);
    console.log(`📡 MQTT_TOPIC=${MQTT_TOPIC}, CALL_DST=${CALL_DST}, RED_THRESHOLD=${RED_THRESHOLD}`);
    console.log(`⏱️ Update-Intervall: ${Math.round(UPDATE_INTERVAL_MS / 60000)} Minuten`);

    await updateRadiationData();
    setInterval(updateRadiationData, UPDATE_INTERVAL_MS);
});
