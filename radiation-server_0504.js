require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const app = express();
const PORT = process.env.PORT || 3002;

// MQTT / MeshCom
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://127.0.0.1';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'meshcom/tx';
const CALL_DST = process.env.CALL_DST || '9';

// Schwelle für "rot"
const RED_THRESHOLD = parseFloat(process.env.RED_THRESHOLD || '0.18');

// Abrufintervall für BfS in ms
const UPDATE_INTERVAL_MS = (parseInt(process.env.UPDATE_INTERVAL_MINUTES, 10) || 10) * 60 * 1000;

// Cache
let cachedRadiationData = [];
let lastCacheTime = 0;

// PLZ-Datenbank
let PLZ_DATABASE = new Map();

// MQTT Status
let mqttConnected = false;
const mqttClient = mqtt.connect(MQTT_BROKER);

// Schutz gegen parallele Läufe
let updateRunning = false;

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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
        console.error('❌ Fehler beim Laden der PLZ-DB:', err.message);
    }
}

function getStationCoordinates(feature) {
    const p = feature?.properties || {};
    const stationPlz = p.plz != null ? String(p.plz).trim() : null;

    // 1) echte BfS-Koordinaten bevorzugen
    const geometryCoords = feature?.geometry?.coordinates;
    if (Array.isArray(geometryCoords) && geometryCoords.length >= 2) {
        const lon = Number(geometryCoords[0]);
        const lat = Number(geometryCoords[1]);

        if (isPlausibleGermanyCoordinate(lat, lon)) {
            return {
                lat,
                lon,
                source: 'bfs'
            };
        }
    }

    // 2) Fallback über PLZ
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

    return null;
}

function publishRedStation(station) {
    if (!mqttConnected) {
        console.warn(`⚠️ MQTT nicht verbunden, überspringe: ${station.n || 'unbekannt'}`);
        return;
    }

    const valueText = Number.isFinite(station.v) ? station.v.toFixed(2) : '0.00';
    const placeRaw = station.n || 'unbekannt';

    // Nur ASCII, damit nachgelagerte Systeme nicht an Sonderzeichen scheitern
    const place = String(placeRaw).replace(/[^a-zA-Z0-9 .,_\-()/]/g, '');
    
    //const msg = `RAD ${valueText} uSv/h ${place}`.substring(0, 80);
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

function buildMappedStations(features) {
    return features.map((f) => {
        const p = f.properties || {};
        const stationPlz = p.plz != null ? String(p.plz).trim() : null;
        const coords = getStationCoordinates(f);

        if (!coords) {
            return null;
        }

        return {
            n: p.name || 'unbekannt',
            plz: stationPlz || null,
            v: Number(p.value || 0),
            v_ter: Number(p.value_terrestrial || 0),
            v_cos: Number(p.value_cosmic || 0),
            h: Number(p.height_above_sea || 0),
            st: p.site_status_text || 'unbekannt',
            ts: p.end_measure || null,
            lt: coords.lat,
            ln: coords.lon,
            coord_source: coords.source
        };
    }).filter(Boolean);
}

function getRedStations(stations) {
    return stations.filter((s) => Number.isFinite(s.v) && s.v >= RED_THRESHOLD);
}

function logRedStations(prefix, stations) {
    const redStations = getRedStations(stations);
    console.log(`🔴 ${prefix}: rote Stationen = ${redStations.length}, Threshold = ${RED_THRESHOLD}`);

    if (redStations.length > 0) {
        redStations.forEach((s) => {
            console.log(`   • ${s.n} | ${s.v} uSv/h | ${s.plz || 'ohne PLZ'} | ${s.coord_source}`);
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

        if (!response.data || !Array.isArray(response.data.features)) {
            console.error('❌ Unerwartete Antwort vom BfS');
            return;
        }

        const mappedStations = buildMappedStations(response.data.features);

        console.log(`✅ ${mappedStations.length} Stationen verarbeitet`);

        const bfsCount = mappedStations.filter((s) => s.coord_source === 'bfs').length;
        const plzCount = mappedStations.filter((s) => s.coord_source === 'plz').length;
        const noPlzButBfsCount = mappedStations.filter((s) => !s.plz && s.coord_source === 'bfs').length;

        console.log(`📍 Koordinatenquelle: BfS=${bfsCount}, PLZ-Fallback=${plzCount}`);
        console.log(`📭 Ohne PLZ, aber mit echten BfS-Koordinaten: ${noPlzButBfsCount}`);

        const maxValue = mappedStations.length
            ? Math.max(...mappedStations.map((s) => Number(s.v) || 0))
            : 0;
        console.log(`📈 Maximalwert: ${maxValue} uSv/h`);

        cachedRadiationData = mappedStations;
        lastCacheTime = Date.now();

        const redStations = logRedStations('Hintergrund', mappedStations);
        sendRedStationsAsync(redStations);

    } catch (err) {
        console.error(`❌ Fehler bei BfS-Abfrage: ${err.message}`);
    } finally {
        updateRunning = false;
    }
}

app.get('/api/radiation', (req, res) => {
    console.log('➡️ /api/radiation aufgerufen');
    res.json(cachedRadiationData || []);
});

app.get('/healthz', (req, res) => {
    res.json({
        ok: true,
        mqttConnected,
        updateRunning,
        cacheAgeSeconds: lastCacheTime ? Math.round((Date.now() - lastCacheTime) / 1000) : null,
        cachedEntries: Array.isArray(cachedRadiationData) ? cachedRadiationData.length : 0,
        redThreshold: RED_THRESHOLD,
        mqttTopic: MQTT_TOPIC,
        callDst: CALL_DST,
        updateIntervalMinutes: Math.round(UPDATE_INTERVAL_MS / 60000)
    });
});

initPlzDb();

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Radiation-Server bereit auf Port ${PORT}`);
    console.log(`📡 MQTT_TOPIC=${MQTT_TOPIC}, CALL_DST=${CALL_DST}, RED_THRESHOLD=${RED_THRESHOLD}`);
    console.log(`⏱️ Update-Intervall: ${Math.round(UPDATE_INTERVAL_MS / 60000)} Minuten`);

    await updateRadiationData();
    setInterval(updateRadiationData, UPDATE_INTERVAL_MS);
});
