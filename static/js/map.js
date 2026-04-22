const map = L.map('map', { maxZoom: 22 }).setView([49.8951, -97.1384], 12);

let points = [];
let markers = [];
let optimizedRoute = [];
let routeLine = null;
let drivingPathSegments = [];
let drivingPathCasingLine = null;
let drivingPathLine = null;
let drivingPathArrows = [];
let drivingPathGeometry = [];
let drivingPathLegGeometry = [];
let snapLines = [];
let snapDots = [];
let isPlacementMode = false;
let nextPointKey = 1;
let hasSummary = false;
let lastFocusedBounds = null;
let draggedRouteKey = null;
let isSidebarCollapsed = false;
let showRouteLine = true;
let showDrivingPath = true;
let showSnapGuides = true;
let showWaypointNumbers = true;
let optimizeFor = 'time';
let mustEndAtLast = false;
let isZonePlacementMode = false;
let inclusionZoneVertices = [];
let inclusionZonePolygon = null;
let inclusionZoneDraft = null;
let inclusionZoneEditorLayer = null;
let inclusionZoneCursorLatLng = null;
let includedRouteKeys = new Set();

const markerLookup = new Map();
const SIDEBAR_RESIZE_DELAY_MS = 220;
const MAP_FOCUS_DURATION_SECONDS = 0.6;

const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 19,
    maxZoom: 22,
    attribution: '&copy; OpenStreetMap contributors'
});
const lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxNativeZoom: 20,
    maxZoom: 22,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
});
const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxNativeZoom: 20,
    maxZoom: 22,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
});
const voyagerLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd',
    maxNativeZoom: 20,
    maxZoom: 22,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
});
const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 19,
    maxZoom: 22,
    attribution: 'Tiles &copy; Esri'
});

satelliteLayer.addTo(map);
map.createPane('exportPreviewPane');
map.getPane('exportPreviewPane').style.zIndex = 350;
map.getPane('exportPreviewPane').style.pointerEvents = 'none';
L.control.layers(
    {
        Streets: streetLayer,
        Light: lightLayer,
        Dark: darkLayer,
        Voyager: voyagerLayer,
        Satellite: satelliteLayer
    },
    {},
    { position: 'bottomright', collapsed: true }
).addTo(map);

const HomeControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
        const container = L.DomUtil.create('div', 'leaflet-bar');
        const button = L.DomUtil.create('button', 'map-home-btn', container);
        button.type = 'button';
        button.title = 'Reset map view';
        button.innerHTML = 'H';
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.on(button, 'click', (event) => {
            L.DomEvent.stop(event);
            resetMapView();
        });
        return container;
    }
});
map.addControl(new HomeControl());

function isCoordinateInRange(field, value) {
    if (field === 'lat') {
        return value >= -90 && value <= 90;
    }
    if (field === 'lng') {
        return value >= -180 && value <= 180;
    }
    return true;
}

function getPointLatLng(point, options = {}) {
    const { preferSnapped = false } = options;
    if (preferSnapped && point && point.snapped) {
        const snappedLat = Number(point.snapped.lat);
        const snappedLng = Number(point.snapped.lng);
        if (Number.isFinite(snappedLat) && Number.isFinite(snappedLng)) {
            return [snappedLat, snappedLng];
        }
    }

    return [point.lat, point.lng];
}

function createZoneHandleIcon(handleClassName, size) {
    return L.divIcon({
        className: '',
        html: `<span class="zone-handle ${handleClassName}"></span>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

function isRoutingOnlyPointName(name) {
    const normalizedName = String(name || '').trim().toLowerCase();
    return normalizedName === 'hidden' || normalizedName === 'invisible' || normalizedName === 'invisable';
}

function isRoutingOnlyPoint(point) {
    return Boolean(point) && isRoutingOnlyPointName(point.id);
}

function getVisibleRoutePoints(routePoints = optimizedRoute) {
    return routePoints.filter((point) => !isRoutingOnlyPoint(point));
}

function buildVisibleRouteRankLookup(routePoints = optimizedRoute) {
    const rankLookup = new Map();
    getVisibleRoutePoints(routePoints).forEach((point, index) => {
        rankLookup.set(point.routeKey, index + 1);
    });
    return rankLookup;
}

function createWaypointMarkerIcon(options = {}) {
    const { isStart = false, isIncluded = true, rank = null, isRoutingOnly = false } = options;
    const fillColor = isRoutingOnly
        ? '#ffffff'
        : !isIncluded
            ? '#94a3b8'
            : isStart
                ? '#16a34a'
                : '#2563eb';
    const strokeColor = isRoutingOnly
        ? 'rgba(148,163,184,0.96)'
        : 'rgba(255,255,255,0.96)';

    return L.divIcon({
        className: '',
        html: `
            <div style="position: relative; width: 24px; height: 36px;">
                ${showWaypointNumbers && Number.isFinite(rank) ? `<span class="waypoint-rank-badge">${rank}</span>` : ''}
                <svg width="24" height="36" viewBox="0 0 24 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 8.2 10.5 22.5 10.5 22.5S22.5 20.2 22.5 12C22.5 6.2 17.8 1.5 12 1.5Z" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2"/>
                    <circle cx="12" cy="12" r="4.2" fill="${isRoutingOnly ? 'rgba(226,232,240,0.96)' : 'rgba(255,255,255,0.96)'}"/>
                </svg>
            </div>
        `,
        iconSize: [24, 36],
        iconAnchor: [12, 35],
        popupAnchor: [0, -28]
    });
}

function hasInclusionZone() {
    return inclusionZoneVertices.length >= 3;
}

function isPointIncluded(point) {
    if (hasInclusionZone()) {
        return includedRouteKeys.has(point.routeKey);
    }
    return true;
}

function getIncludedPoints() {
    return points.filter((point) => isPointIncluded(point));
}

function updateIncludedRouteKeys() {
    includedRouteKeys = new Set(
        points
            .filter((point) => pointInPolygon(point.lat, point.lng, inclusionZoneVertices))
            .map((point) => point.routeKey)
    );
}

function clearInclusionZoneLayers(options = {}) {
    const { preserveEditor = false } = options;
    if (inclusionZonePolygon) {
        map.removeLayer(inclusionZonePolygon);
        inclusionZonePolygon = null;
    }
    if (inclusionZoneDraft) {
        map.removeLayer(inclusionZoneDraft);
        inclusionZoneDraft = null;
    }
    if (!preserveEditor && inclusionZoneEditorLayer) {
        map.removeLayer(inclusionZoneEditorLayer);
        inclusionZoneEditorLayer = null;
    }
}

function addZoneVertexHandle(vertex, index) {
    if (!inclusionZoneEditorLayer) {
        return;
    }

    const handle = L.marker([vertex.lat, vertex.lng], {
        draggable: true,
        icon: createZoneHandleIcon('zone-vertex-handle', 14),
        keyboard: false,
        zIndexOffset: 2000
    });

    handle.on('dragstart', () => {
        clearOptimizationState();
    });
    handle.on('drag', (event) => {
        const latLng = event.target.getLatLng();
        inclusionZoneVertices[index] = {
            lat: roundCoord(latLng.lat),
            lng: roundCoord(latLng.lng)
        };
        updateIncludedRouteKeys();
        syncZoneStatus();
        refreshOptimizationAvailability();
        redrawInclusionZone({ preserveEditor: true });
    });
    handle.on('dragend', () => {
        inclusionZoneCursorLatLng = null;
        redrawInclusionZone();
        renderUI();
    });
    handle.on('click', (event) => {
        if (event.originalEvent) {
            L.DomEvent.stop(event.originalEvent);
        }
    });

    inclusionZoneEditorLayer.addLayer(handle);
}

function addZoneMidpointHandle(startVertex, endVertex, insertAfterIndex) {
    if (!inclusionZoneEditorLayer) {
        return;
    }

    const midpoint = {
        lat: roundCoord((startVertex.lat + endVertex.lat) / 2),
        lng: roundCoord((startVertex.lng + endVertex.lng) / 2)
    };

    const handle = L.marker([midpoint.lat, midpoint.lng], {
        icon: createZoneHandleIcon('zone-midpoint-handle', 10),
        keyboard: false,
        zIndexOffset: 1900
    });

    handle.on('click', (event) => {
        if (event.originalEvent) {
            L.DomEvent.stop(event.originalEvent);
        }

        clearOptimizationState();
        inclusionZoneVertices.splice(insertAfterIndex + 1, 0, midpoint);
        updateIncludedRouteKeys();
        syncZoneStatus();
        refreshOptimizationAvailability();
        redrawInclusionZone();
        renderUI();
    });

    inclusionZoneEditorLayer.addLayer(handle);
}

function redrawInclusionZone(options = {}) {
    const { preserveEditor = false } = options;
    clearInclusionZoneLayers({ preserveEditor });
    if (!inclusionZoneVertices.length) {
        return;
    }

    const latLngs = inclusionZoneVertices.map((vertex) => [vertex.lat, vertex.lng]);
    const draftLatLngs = isZonePlacementMode && inclusionZoneCursorLatLng
        ? [...latLngs, [inclusionZoneCursorLatLng.lat, inclusionZoneCursorLatLng.lng]]
        : latLngs;

    if (hasInclusionZone()) {
        inclusionZonePolygon = L.polygon(
            latLngs,
            {
                color: '#059669',
                weight: 2,
                fillColor: '#34d399',
                fillOpacity: isZonePlacementMode ? 0.1 : 0.14
            }
        ).addTo(map);
    }

    if (draftLatLngs.length >= 2) {
        inclusionZoneDraft = L.layerGroup().addTo(map);

        if (isZonePlacementMode && draftLatLngs.length >= 3) {
            inclusionZoneDraft.addLayer(L.polygon(draftLatLngs, {
                stroke: false,
                fillColor: '#6ee7b7',
                fillOpacity: 0.08
            }));
        }

        inclusionZoneDraft.addLayer(L.polyline(draftLatLngs, {
            color: '#059669',
            weight: 3,
            dashArray: isZonePlacementMode ? '6 6' : null,
            opacity: 0.95
        }));
    }

    if (!preserveEditor) {
        inclusionZoneEditorLayer = L.layerGroup().addTo(map);
        inclusionZoneVertices.forEach((vertex, index) => {
            addZoneVertexHandle(vertex, index);
        });

        if (inclusionZoneVertices.length >= 2) {
            for (let index = 0; index < inclusionZoneVertices.length - 1; index += 1) {
                addZoneMidpointHandle(inclusionZoneVertices[index], inclusionZoneVertices[index + 1], index);
            }

            if (hasInclusionZone()) {
                addZoneMidpointHandle(
                    inclusionZoneVertices[inclusionZoneVertices.length - 1],
                    inclusionZoneVertices[0],
                    inclusionZoneVertices.length - 1
                );
            }
        }
    }
}

function focusMapOnPoints(targetPoints = points, options = {}) {
    if (!targetPoints.length) {
        return;
    }

    const latLngs = targetPoints.map((point) => getPointLatLng(point, options));
    if (latLngs.length === 1) {
        lastFocusedBounds = L.latLngBounds(latLngs, latLngs);
        map.flyTo(latLngs[0], Math.max(map.getZoom(), 14), { duration: MAP_FOCUS_DURATION_SECONDS });
        return;
    }

    lastFocusedBounds = L.latLngBounds(latLngs);
    map.fitBounds(latLngs, { padding: [48, 48] });
}

function focusMapOnDrivingPath() {
    if (drivingPathGeometry.length < 2) {
        return false;
    }

    const latLngs = drivingPathGeometry.map((point) => [point.lat, point.lng]);
    lastFocusedBounds = L.latLngBounds(latLngs);
    map.fitBounds(latLngs, { padding: [48, 48] });
    return true;
}

function resetMapView() {
    if (focusMapOnDrivingPath()) {
        return;
    }

    if (optimizedRoute.length) {
        focusMapOnPoints(optimizedRoute, { preferSnapped: true });
        return;
    }

    if (lastFocusedBounds && lastFocusedBounds.isValid()) {
        map.fitBounds(lastFocusedBounds, { padding: [48, 48] });
        return;
    }

    if (points.length) {
        focusMapOnPoints(points);
        return;
    }

    map.setView([49.8951, -97.1384], 12);
}

function clearRouteLine() {
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
}

function clearDrivingPath() {
    drivingPathSegments.forEach((segment) => map.removeLayer(segment));
    drivingPathSegments = [];
    if (drivingPathCasingLine) {
        map.removeLayer(drivingPathCasingLine);
        drivingPathCasingLine = null;
    }
    if (drivingPathLine) {
        map.removeLayer(drivingPathLine);
        drivingPathLine = null;
    }
    drivingPathArrows.forEach((arrow) => map.removeLayer(arrow));
    drivingPathArrows = [];
    drivingPathGeometry = [];
    drivingPathLegGeometry = [];
}

function clearSnapLines() {
    snapLines.forEach((line) => map.removeLayer(line));
    snapLines = [];
    snapDots.forEach((dot) => map.removeLayer(dot));
    snapDots = [];
}

function clearOptimizationState() {
    optimizedRoute = [];
    hasSummary = false;
    drivingPathGeometry = [];
    drivingPathLegGeometry = [];
    points.forEach((point) => {
        point.rank = null;
        delete point.snapped;
    });
    clearRouteLine();
    clearDrivingPath();
    clearSnapLines();
    resultPanel.classList.add('hidden');
    panelToggle.classList.add('hidden');
    document.getElementById('resDist').innerText = '-';
    document.getElementById('resTime').innerText = '-';
    document.getElementById('resCount').innerText = '0 waypoints';
    document.getElementById('resultStops').innerHTML = '';
    document.getElementById('snapWarning').classList.add('hidden');
    document.getElementById('snapWarningText').innerText = '';
    document.getElementById('snapWarningList').innerHTML = '';
    document.getElementById('snapWarningDetails').open = false;
}

function mergeDrivingLegLatLngs(legs) {
    const merged = [];
    legs.forEach((leg) => {
        if (!Array.isArray(leg)) {
            return;
        }

        leg.forEach((point) => {
            const lat = Number(point && point.lat);
            const lng = Number(point && point.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return;
            }

            const lastPoint = merged[merged.length - 1];
            if (lastPoint && Math.abs(lastPoint[0] - lat) < 0.0000001 && Math.abs(lastPoint[1] - lng) < 0.0000001) {
                return;
            }

            merged.push([lat, lng]);
        });
    });

    return merged;
}

function buildRouteLegGroups(routePoints) {
    if (!drivingPathLegGeometry.length || routePoints.length < 2) {
        return [];
    }

    const visibleRoutePoints = getVisibleRoutePoints(routePoints);
    if (visibleRoutePoints.length < 2) {
        const mergedLatLngs = mergeDrivingLegLatLngs(drivingPathLegGeometry);
        return mergedLatLngs.length >= 2 ? [mergedLatLngs] : [];
    }

    const segmentLegGroups = [];
    let currentLegGroup = [];
    let hasVisibleAnchor = !isRoutingOnlyPoint(routePoints[0]);

    for (let index = 0; index < routePoints.length - 1; index += 1) {
        const fromPoint = routePoints[index];
        const toPoint = routePoints[index + 1];
        const leg = Array.isArray(drivingPathLegGeometry[index]) ? drivingPathLegGeometry[index] : [];

        if (!hasVisibleAnchor && !isRoutingOnlyPoint(fromPoint)) {
            hasVisibleAnchor = true;
        }

        if (hasVisibleAnchor) {
            currentLegGroup.push(leg);
        }

        if (hasVisibleAnchor && !isRoutingOnlyPoint(toPoint)) {
            segmentLegGroups.push(currentLegGroup);
            currentLegGroup = [];
        }
    }

    return segmentLegGroups
        .map((legGroup) => mergeDrivingLegLatLngs(legGroup))
        .filter((latLngs) => latLngs.length >= 2);
}

function getDrivingPathSegmentColors(segmentCount, startHex = '#10b981', endHex = '#2563eb', alpha = 0.78) {
    const gradientStart = hexToRgb(startHex);
    const gradientEnd = hexToRgb(endHex);
    const safeSegmentCount = Math.max(segmentCount, 1);
    return Array.from({ length: safeSegmentCount }, (_, index) => {
        const progress = safeSegmentCount === 1 ? 0 : index / (safeSegmentCount - 1);
        return interpolateRgbColor(gradientStart, gradientEnd, progress, alpha);
    });
}

function buildDrivingPathColorSegmentsFromLegs(routePoints) {
    const legGroups = buildRouteLegGroups(routePoints);
    if (!legGroups.length) {
        return [];
    }

    const segmentColors = getDrivingPathSegmentColors(Math.max(legGroups.length, 1));
    return legGroups.map((latLngs, index) => ({
        latLngs,
        color: segmentColors[index]
    }));
}

function buildDrivingPathColorSegments(routePoints) {
    if (drivingPathGeometry.length < 2) {
        return [];
    }

    const legBasedSegments = buildDrivingPathColorSegmentsFromLegs(routePoints);
    if (legBasedSegments.length) {
        return legBasedSegments;
    }

    return [{
        latLngs: drivingPathGeometry.map((point) => [point.lat, point.lng]),
        color: getDrivingPathSegmentColors(1)[0]
    }];
}

function drawOptimizedRoute(routePoints) {
    clearRouteLine();
    if (!showRouteLine || routePoints.length < 2) {
        return;
    }

    routeLine = L.polyline(
        routePoints.map((point) => getPointLatLng(point, { preferSnapped: true })),
        {
            color: '#2563eb',
            weight: 4,
            opacity: 0.85,
            dashArray: '10 8'
        }
    ).addTo(map);
}

function drawDrivingPath(routePoints = optimizedRoute) {
    if (drivingPathCasingLine) {
        map.removeLayer(drivingPathCasingLine);
        drivingPathCasingLine = null;
    }
    if (drivingPathLine) {
        map.removeLayer(drivingPathLine);
        drivingPathLine = null;
    }
    drivingPathSegments.forEach((segment) => map.removeLayer(segment));
    drivingPathSegments = [];
    drivingPathArrows.forEach((arrow) => map.removeLayer(arrow));
    drivingPathArrows = [];

    if (!showDrivingPath || drivingPathGeometry.length < 2) {
        return;
    }

    const pathLatLngs = drivingPathGeometry.map((point) => [point.lat, point.lng]);

    drivingPathCasingLine = L.polyline(
        pathLatLngs,
        {
            color: '#f8fafc',
            weight: 9,
            opacity: 0.92,
            lineCap: 'round',
            lineJoin: 'round'
        }
    ).addTo(map);

    const pathSegments = buildDrivingPathColorSegments(routePoints);
    pathSegments.forEach(({ latLngs, color }) => {
        const segment = L.polyline(
            latLngs,
            {
                color,
                weight: 5,
                opacity: 1,
                lineCap: 'round',
                lineJoin: 'round'
            }
        ).addTo(map);
        drivingPathSegments.push(segment);
    });

    const zoom = map.getZoom();
    const arrowSize = Math.max(10, Math.min(16, zoom + 1));
    const minArrowSpacingMeters = zoom <= 8 ? 3200 : zoom <= 10 ? 2200 : zoom <= 12 ? 1400 : 900;
    let distanceSinceLastArrow = 0;

    for (let index = 0; index < drivingPathGeometry.length - 1; index += 1) {
        const start = drivingPathGeometry[index];
        const end = drivingPathGeometry[index + 1];
        const segmentDistance = getDistanceMeters(start.lat, start.lng, end.lat, end.lng);
        distanceSinceLastArrow += segmentDistance;

        if (distanceSinceLastArrow < minArrowSpacingMeters && index < drivingPathGeometry.length - 2) {
            continue;
        }

        const startPoint = map.latLngToLayerPoint([start.lat, start.lng]);
        const endPoint = map.latLngToLayerPoint([end.lat, end.lng]);
        const deltaX = endPoint.x - startPoint.x;
        const deltaY = endPoint.y - startPoint.y;
        if (Math.abs(deltaX) < 0.5 && Math.abs(deltaY) < 0.5) {
            continue;
        }

        const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
        const midpoint = [
            (start.lat + end.lat) / 2,
            (start.lng + end.lng) / 2
        ];

        const arrow = L.marker(midpoint, {
            interactive: false,
            keyboard: false,
            zIndexOffset: 1500,
            icon: L.divIcon({
                className: '',
                html: `
                    <div class="driving-path-arrow-badge" style="width:${arrowSize}px;height:${arrowSize}px;transform: rotate(${angle}deg);">
                        <span class="driving-path-arrow-glyph" style="font-size:${Math.max(8, arrowSize - 7)}px;">&#8250;</span>
                    </div>
                `,
                iconSize: [arrowSize, arrowSize],
                iconAnchor: [arrowSize / 2, arrowSize / 2]
            })
        }).addTo(map);

        drivingPathArrows.push(arrow);
        distanceSinceLastArrow = 0;
    }
}

function drawSnapLines() {
    clearSnapLines();
    if (!showSnapGuides) {
        return;
    }
    points.forEach((point) => {
        if (!point.snapped) {
            return;
        }

        const snappedLat = Number(point.snapped.lat);
        const snappedLng = Number(point.snapped.lng);
        if (!Number.isFinite(snappedLat) || !Number.isFinite(snappedLng)) {
            return;
        }

        if (Math.abs(point.lat - snappedLat) < 0.000001 && Math.abs(point.lng - snappedLng) < 0.000001) {
            return;
        }

        const line = L.polyline(
            [
                [point.lat, point.lng],
                [snappedLat, snappedLng]
            ],
            {
                color: '#dc2626',
                weight: 2,
                opacity: 0.85,
                dashArray: '6 6'
            }
        ).addTo(map);
        snapLines.push(line);

        const dot = L.circleMarker([snappedLat, snappedLng], {
            radius: 4,
            color: '#b91c1c',
            weight: 2,
            fillColor: '#ef4444',
            fillOpacity: 1
        }).addTo(map);
        snapDots.push(dot);
    });
}