require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3003;

app.use(cors());
// Statische Dateien aus dem Unterordner "public" servieren
app.use(express.static(path.join(__dirname, 'public')));

// --- CACHE & DB ---
let cachedRadiationData = null;
let lastCacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 Minuten
let PLZ_DATABASE = new Map();

// --- PLZ DATENBANK LADEN ---
function initPlzDb() {
    const plzPath = path.join(__dirname, 'plz_geocoord.csv');
    if (fs.existsSync(plzPath)) {
        const content = fs.readFileSync(plzPath, 'utf8');
        content.split(/\r?\n/).forEach((line, i) => {
            if (i === 0 || !line.trim()) return;
            const p = line.split(',');
            const plz = p[0].replace(/"/g, '').trim();
            const lat = parseFloat(p[1].replace(/"/g, ''));
            const lon = parseFloat(p[2].replace(/"/g, ''));
            if (plz && !isNaN(lat)) PLZ_DATABASE.set(plz, { lat, lon });
        });
        console.log(`✅ PLZ-DB geladen: ${PLZ_DATABASE.size} Einträge.`);
    } else {
        console.error("❌ Kritisch: plz_geocoord.csv fehlt im Hauptverzeichnis!");
    }
}
initPlzDb();

// --- API ENDPUNKT ---
app.get('/api/radiation', async (req, res) => {
    const now = Date.now();
    if (cachedRadiationData && (now - lastCacheTime < CACHE_DURATION)) {
        return res.json(cachedRadiationData);
    }

    console.log(`☢️ Abfrage BfS OpenData...`);
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

        if (response.data && response.data.features) {
            const mappedStations = response.data.features.map(f => {
                const p = f.properties;
                const stationPlz = p.plz ? p.plz.trim() : null;
                const coords = PLZ_DATABASE.get(stationPlz);

                if (coords) {
                    return {
                        n: p.name,
                        plz: stationPlz,
                        v: p.value || 0,
                        v_ter: p.value_terrestrial || 0,
                        v_cos: p.value_cosmic || 0,
                        h: p.height_above_sea || 0,
                        st: p.site_status_text || "unbekannt",
                        ts: p.end_measure,
                        lt: coords.lat,
                        ln: coords.lon
                    };
                }
                return null;
            }).filter(s => s !== null);

            cachedRadiationData = mappedStations;
            lastCacheTime = now;
            console.log(`✅ ${mappedStations.length} Stationen georeferenziert.`);
            res.json(mappedStations);
        }
    } catch (e) {
        console.error(`❌ Fehler: ${e.message}`);
        res.status(500).json({ error: "BfS-Schnittstelle hakt" });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Lagezentrum-Server bereit auf http://192.168.188.44:${PORT}`);
});
