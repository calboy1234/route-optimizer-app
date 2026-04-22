function roundCoord(value) {
    return parseFloat(Number(value).toFixed(6));
}

function formatDuration(minutes) {
    const totalMinutes = Number(minutes);
    if (!Number.isFinite(totalMinutes)) {
        return '-';
    }

    if (totalMinutes < 60) {
        return `${totalMinutes} min`;
    }

    const roundedMinutes = Math.round(totalMinutes);
    const hours = Math.floor(roundedMinutes / 60);
    const mins = roundedMinutes % 60;
    return mins === 0 ? `${hours} hr` : `${hours} hr ${mins} min`;
}

function hexToRgb(hex) {
    const normalized = String(hex || '').trim().replace('#', '');
    const full = normalized.length === 3
        ? normalized.split('').map((ch) => ch + ch).join('')
        : normalized;

    if (!/^[0-9a-fA-F]{6}$/.test(full)) {
        return [37, 99, 235];
    }

    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ];
}

function rgbToHex(rgb) {
    return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`;
}

function interpolateRgbColor(start, end, progress, alpha = 0.78) {
    const red = Math.round(start[0] + ((end[0] - start[0]) * progress));
    const green = Math.round(start[1] + ((end[1] - start[1]) * progress));
    const blue = Math.round(start[2] + ((end[2] - start[2]) * progress));
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function interpolateHexColor(start, end, progress) {
    return rgbToHex([
        start[0] + ((end[0] - start[0]) * progress),
        start[1] + ((end[1] - start[1]) * progress),
        start[2] + ((end[2] - start[2]) * progress),
    ]);
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const earthRadiusMeters = 6371000;
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMeters * c;
}

function pointInPolygon(lat, lng, vertices) {
    if (!Array.isArray(vertices) || vertices.length < 3) {
        return true;
    }

    let inside = false;
    for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
        const xi = vertices[i].lng;
        const yi = vertices[i].lat;
        const xj = vertices[j].lng;
        const yj = vertices[j].lat;
        const intersects = ((yi > lat) !== (yj > lat))
            && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
        if (intersects) {
            inside = !inside;
        }
    }
    return inside;
}

function sanitizeHeader(header) {
    return String(header || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function getRowValue(row, matcher) {
    for (const [key, value] of Object.entries(row)) {
        if (matcher(sanitizeHeader(key), value)) {
            return value;
        }
    }
    return undefined;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function extractCoordinate(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    const text = String(value ?? '').trim();
    if (!text) {
        return null;
    }

    const direct = Number(text);
    if (Number.isFinite(direct)) {
        return direct;
    }

    const cleaned = text
        .replace(/\s+/g, '')
        .replace(/,/g, '')
        .replace(/º/g, '°');

    const match = cleaned.match(/^(-?\d+(?:\.\d+)?)°?([NSEW])?$/i);
    if (!match) {
        return null;
    }

    let numeric = Number(match[1]);
    if (!Number.isFinite(numeric)) {
        return null;
    }

    const direction = (match[2] || '').toUpperCase();
    if (direction === 'S' || direction === 'W') {
        numeric *= -1;
    }

    return numeric;
}

function normalizeRow(row) {
    const lat = getRowValue(row, (key) => key === 'lat' || key === 'latitude' || key === 'y' || key.includes('lat'));
    const lng = getRowValue(row, (key) => key === 'lng' || key === 'lon' || key === 'long' || key === 'longitude' || key === 'x' || key.includes('lon') || key.includes('lng') || key.includes('long'));
    const name = getRowValue(row, (key) => key === 'name' || key === 'id' || key === 'customer' || key === 'label' || key.includes('name'));

    let latNumber = extractCoordinate(lat);
    let lngNumber = extractCoordinate(lng);

    if (!Number.isFinite(latNumber) || !Number.isFinite(lngNumber)) {
        const numericValues = Object.values(row)
            .map(extractCoordinate)
            .filter((value) => Number.isFinite(value));

        for (let index = 0; index < numericValues.length - 1; index += 1) {
            const possibleLat = numericValues[index];
            const possibleLng = numericValues[index + 1];
            if (Math.abs(possibleLat) <= 90 && Math.abs(possibleLng) <= 180) {
                latNumber = possibleLat;
                lngNumber = possibleLng;
                break;
            }
        }
    }

    if (!Number.isFinite(latNumber) || !Number.isFinite(lngNumber)) {
        return null;
    }

    return {
        lat: latNumber,
        lng: lngNumber,
        name
    };
}