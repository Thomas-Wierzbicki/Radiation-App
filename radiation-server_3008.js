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
const RED_THRESHOLD = parseFloat(process.env.RED_THRESHOLD || '0.1');

const FILTER_PLZ_ZONES = process.env.FILTER_PLZ_ZONES 
    ? process.env.FILTER_PLZ_ZONES.split(',').map(s => s.trim()) 
    : [];

const UPDATE_INTERVAL_MS = (parseInt(process.env.UPDATE_INTERVAL_MINUTES, 10) || 10) * 60 * 1000;

let cachedRadiationData = [];
let lastCacheTime = 0;
let PLZ_DATABASE = new Map();
let mqttConnected = false;
let updateRunning = false;

const mqttClient = mqtt.connect(MQTT_BROKER);
mqttClient.on('connect', () => { mqttConnected = true; console.log(`✅ MQTT verbunden`); });
mqttClient.on('error', (err) => { mqttConnected = false; console.error('❌ MQTT Fehler:', err.message); });

// --- MIDDLEWARES ---
app.use(cors());
app.use(express.json());

// Request-Logger (zeigt jeden Request in der Konsole an)
app.use((req, res, next) => {
    console.log(`📡 [${req.method}] ${req.url}`);
    next();
});

// --- API ROUTEN (Zuerst definieren!) ---
app.get('/api/test', (req, res) => {
    res.send("TEST ROUTE FUNKTIONIERT!");
});

app.get('/api/config', (req, res) => {
    res.json({ cartoApiKey: CARTO_API_KEY });
});

app.get('/api/radiation', (req, res) => {
    res.json(cachedRadiationData);
});

app.get('/healthz', (req, res) => {
    res.json({ ok: true, entries: cachedRadiationData.length, filter: FILTER_PLZ_ZONES });
});

// Statische Dateien (Frontend)
app.use(express.static(path.join(__dirname, 'public')));

// --- HILFSFUNKTIONEN ---
function isPlausibleGermanyCoordinate(lat, lon) {
    return (Number.isFinite(lat) && Number.isFinite(lon) && lat >= 47.0 && lat <= 55.5 && lon >= 5.0 && lon <= 15.6);
}

function initPlzDb() {
    const plzPath = path.join(__dirname, 'plz_geocoord.csv');
    if (!fs.existsSync(plzPath)) return;
    try {
        const content = fs.readFileSync(plzPath, 'utf8');
        content.split(/\r?\n/).forEach((line, i) => {
            if (i === 0 || !line.trim()) return;
            const p = line.split(',');
            const plz = (p[0] || '').replace(/"/g, '').trim();
            const lat = parseFloat((p[1] || '').replace(/"/g, '').trim());
            const lon = parseFloat((p[2] || '').replace(/"/g, '').trim());
            if (plz && isPlausibleGermanyCoordinate(lat, lon)) PLZ_DATABASE.set(plz, { lat, lon });
        });
        console.log(`✅ PLZ-DB geladen: ${PLZ_DATABASE.size} Einträge`);
    } catch (err) { console.error('❌ PLZ-DB Fehler:', err.message); }
}

function getStationCoordinates(feature) {
    const p = feature?.properties || {};
    const geometryCoords = feature?.geometry?.coordinates;
    if (Array.isArray(geometryCoords) && geometryCoords.length >= 2) {
        const lon = Number(geometryCoords[0]), lat = Number(geometryCoords[1]);
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
            h: p.height ?? p.site_elevation ?? 0,
            st: p.site_status_text || 'unbekannt',
            ts: p.end_measure || null,
            lt: coords.lat,
            ln: coords.lon
        };
    }).filter(Boolean);
}

async function updateRadiationData() {
    if (updateRunning) return;
    updateRunning = true;
    try {
        const response = await axios.get('https://www.imis.bfs.de/ogc/opendata/ows', {
            params: { service: 'WFS', version: '1.1.0', request: 'GetFeature', typeName: 'opendata:odlinfo_odl_1h_latest', outputFormat: 'application/json' },
            timeout: 45000
        });
        if (response.data?.features) {
            cachedRadiationData = buildMappedStations(response.data.features);
            lastCacheTime = Date.now();
            console.log(`☢️ Daten-Update: ${cachedRadiationData.length} Stationen im Cache.`);
        }
    } catch (err) { console.error(`❌ BfS-Fehler: ${err.message}`); }
    updateRunning = false;
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
    await updateRadiationData();
    setInterval(updateRadiationData, UPDATE_INTERVAL_MS);
});
