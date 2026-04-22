let isExportMode         = false;
let exportBounds         = { north: 0, south: 0, east: 0, west: 0 };
let exportBboxGroup      = null;
let exportMapStyle       = 'light';
let exportMaxDim         = 2048;     // max dimension; other dim computed from bbox ratio
let exportFormat         = 'png';
let exportShowRoute      = true;
let exportRouteStyle     = 'solid';
let exportRouteColor     = '#2563eb';
let exportRouteGradientEnd = '#2563eb';
let exportRouteThickness = 4;
let exportRouteOpacity   = 85;       // 0–100 in UI
let exportRouteDashed    = false;
let exportPointVis       = 'all';
let exportPointColor     = '#2563eb';
let exportPointSize      = 40;
let exportPointShape     = 'pin';   // 'circle' | 'pin' | future shapes
let exportLabelSize      = 14;
let exportShowLabels     = true;
let _tileLayerBeforeExport = null;
let _exportPreviewOverlay = null;
let _exportPreviewUrl    = null;
let _exportPreviewAbort  = null;
let _exportPreviewTimer  = null;
let _exportPreviewSeq    = 0;
let _exportInteractionState = null;
const EXPORT_LAT_LIMIT = 85;
const EXPORT_LNG_LIMIT = 180;
const EXPORT_MIN_SPAN = 0.0005;

// ── Tile math — mirrors Python backend exactly ────────────────────────
function _tileXF(lng, zoom) {
    return (lng + 180.0) / 360.0 * Math.pow(2, zoom);
}
function _tileYF(lat, zoom) {
    const lr = lat * Math.PI / 180;
    return (1.0 - Math.log(Math.tan(lr) + 1.0 / Math.cos(lr)) / Math.PI) / 2.0 * Math.pow(2, zoom);
}
function _bestZoomJS(b) {
    for (let z = 17; z >= 1; z--) {
        const x0 = Math.floor(_tileXF(b.west, z)),  x1 = Math.floor(_tileXF(b.east, z));
        const y0 = Math.floor(_tileYF(b.north, z)), y1 = Math.floor(_tileYF(b.south, z));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 225) return z;
    }
    return 2;
}
// Given bounds + a max-dimension choice, returns the exact pixel size the server will produce
function _computeExportDims(b, maxDim) {
    if (b.north <= b.south || b.east <= b.west) return { width: maxDim, height: maxDim };
    const z  = _bestZoomJS(b);
    const pw = (_tileXF(b.east, z)  - _tileXF(b.west,  z)) * 256;
    const ph = (_tileYF(b.south, z) - _tileYF(b.north, z)) * 256;
    if (pw <= 0 || ph <= 0) return { width: maxDim, height: maxDim };
    const ratio = pw / ph;
    return ratio >= 1
        ? { width: maxDim, height: Math.max(1, Math.round(maxDim / ratio)) }
        : { width: Math.max(1, Math.round(maxDim * ratio)), height: maxDim };
}

function _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function _normalizeExportBounds(bounds) {
    let north = _clamp(Number(bounds.north), -EXPORT_LAT_LIMIT, EXPORT_LAT_LIMIT);
    let south = _clamp(Number(bounds.south), -EXPORT_LAT_LIMIT, EXPORT_LAT_LIMIT);
    let east = _clamp(Number(bounds.east), -EXPORT_LNG_LIMIT, EXPORT_LNG_LIMIT);
    let west = _clamp(Number(bounds.west), -EXPORT_LNG_LIMIT, EXPORT_LNG_LIMIT);

    if (north < south) {
        [north, south] = [south, north];
    }
    if (east < west) {
        [east, west] = [west, east];
    }

    if ((north - south) < EXPORT_MIN_SPAN) {
        const midLat = (north + south) / 2;
        north = _clamp(midLat + (EXPORT_MIN_SPAN / 2), -EXPORT_LAT_LIMIT, EXPORT_LAT_LIMIT);
        south = _clamp(midLat - (EXPORT_MIN_SPAN / 2), -EXPORT_LAT_LIMIT, EXPORT_LAT_LIMIT);
        if ((north - south) < EXPORT_MIN_SPAN) {
            south = Math.max(-EXPORT_LAT_LIMIT, north - EXPORT_MIN_SPAN);
            north = Math.min(EXPORT_LAT_LIMIT, south + EXPORT_MIN_SPAN);
        }
    }

    if ((east - west) < EXPORT_MIN_SPAN) {
        const midLng = (east + west) / 2;
        east = _clamp(midLng + (EXPORT_MIN_SPAN / 2), -EXPORT_LNG_LIMIT, EXPORT_LNG_LIMIT);
        west = _clamp(midLng - (EXPORT_MIN_SPAN / 2), -EXPORT_LNG_LIMIT, EXPORT_LNG_LIMIT);
        if ((east - west) < EXPORT_MIN_SPAN) {
            west = Math.max(-EXPORT_LNG_LIMIT, east - EXPORT_MIN_SPAN);
            east = Math.min(EXPORT_LNG_LIMIT, west + EXPORT_MIN_SPAN);
        }
    }

    return { north, south, east, west };
}

function _translateExportBounds(deltaLat, deltaLng, baseBounds = exportBounds) {
    let north = baseBounds.north + deltaLat;
    let south = baseBounds.south + deltaLat;
    let east = baseBounds.east + deltaLng;
    let west = baseBounds.west + deltaLng;

    if (north > EXPORT_LAT_LIMIT) {
        south -= north - EXPORT_LAT_LIMIT;
        north = EXPORT_LAT_LIMIT;
    }
    if (south < -EXPORT_LAT_LIMIT) {
        north += -EXPORT_LAT_LIMIT - south;
        south = -EXPORT_LAT_LIMIT;
    }
    if (east > EXPORT_LNG_LIMIT) {
        west -= east - EXPORT_LNG_LIMIT;
        east = EXPORT_LNG_LIMIT;
    }
    if (west < -EXPORT_LNG_LIMIT) {
        east += -EXPORT_LNG_LIMIT - west;
        west = -EXPORT_LNG_LIMIT;
    }

    return _normalizeExportBounds({ north, south, east, west });
}

function _suspendEditorModesForExport() {
    _exportInteractionState = {
        placementMode: isPlacementMode,
        zonePlacementMode: isZonePlacementMode,
    };

    if (isZonePlacementMode) {
        setZonePlacementMode(false);
    }
    if (isPlacementMode) {
        setPlacementMode(false);
    }

    clearInclusionZoneLayers();
}

function _restoreEditorModesAfterExport() {
    const previousState = _exportInteractionState;
    _exportInteractionState = null;

    if (hasInclusionZone() || inclusionZoneVertices.length) {
        redrawInclusionZone();
    }

    if (previousState && previousState.zonePlacementMode) {
        setZonePlacementMode(true);
        return;
    }

    if (previousState && previousState.placementMode) {
        setPlacementMode(true);
        return;
    }

    updatePlacementHint();
}

// ── Tile layer management ─────────────────────────────────────────────
function _getActiveTileLayer() {
    for (const l of [streetLayer, lightLayer, darkLayer, voyagerLayer, satelliteLayer]) {
        if (map.hasLayer(l)) return l;
    }
    return satelliteLayer;
}
function _setTileLayer(layer) {
    [streetLayer, lightLayer, darkLayer, voyagerLayer, satelliteLayer].forEach(l => {
        if (map.hasLayer(l)) map.removeLayer(l);
    });
    layer.addTo(map);
}
const _styleToLayer = { light: () => lightLayer, dark: () => darkLayer, voyager: () => voyagerLayer, streets: () => streetLayer };

// ── Live export overlays — drawn on map in export mode ────────────────
function _clearExportOverlays() {
    if (_exportPreviewTimer) {
        clearTimeout(_exportPreviewTimer);
        _exportPreviewTimer = null;
    }
    if (_exportPreviewAbort) {
        _exportPreviewAbort.abort();
        _exportPreviewAbort = null;
    }
    if (_exportPreviewOverlay) {
        map.removeLayer(_exportPreviewOverlay);
        _exportPreviewOverlay = null;
    }
    if (_exportPreviewUrl) {
        URL.revokeObjectURL(_exportPreviewUrl);
        _exportPreviewUrl = null;
    }
}

function _computePreviewDims() {
    return _computeExportDims(exportBounds, exportMaxDim);
}

function getHexGradientColors(segmentCount, startHex, endHex) {
    const gradientStart = hexToRgb(startHex);
    const gradientEnd = hexToRgb(endHex);
    const safeSegmentCount = Math.max(segmentCount, 1);
    return Array.from({ length: safeSegmentCount }, (_, index) => {
        const progress = safeSegmentCount === 1 ? 0 : index / (safeSegmentCount - 1);
        return interpolateHexColor(gradientStart, gradientEnd, progress);
    });
}

function buildExportRouteSegments(routePoints) {
    const legGroups = buildRouteLegGroups(routePoints);
    if (!legGroups.length) {
        return [];
    }

    const segmentColors = getHexGradientColors(
        Math.max(legGroups.length, 1),
        exportRouteColor,
        exportRouteGradientEnd
    );

    return legGroups.map((latLngs, index) => ({
        color: segmentColors[index],
        geometry: latLngs.map(([lat, lng]) => ({ lat, lng }))
    }));
}

function _buildExportPayload(options = {}) {
    const { preview = false } = options;
    const dims = preview ? _computePreviewDims() : _computeExportDims(exportBounds, exportMaxDim);

    const routeGeo = drivingPathGeometry.length >= 2
        ? drivingPathGeometry.map((point) => ({ lat: point.lat, lng: point.lng }))
        : optimizedRoute.length >= 2
            ? optimizedRoute.map((point) => ({ lat: point.lat, lng: point.lng }))
            : [];

    const routeSource = optimizedRoute.length ? optimizedRoute : points;
    let routeSegments = [];
    if (exportRouteStyle === 'gradient' && routeGeo.length >= 2) {
        routeSegments = buildExportRouteSegments(routeSource);
        if (!routeSegments.length) {
            routeSegments = [{ color: exportRouteColor, geometry: routeGeo }];
        }
    }

    const src = optimizedRoute.length ? getVisibleRoutePoints(optimizedRoute) : points;
    let wps = src.map((point, index) => ({
        lat: point.lat,
        lng: point.lng,
        routeKey: point.routeKey || '',
        id: point.id || '',
        rank: index + 1
    }));
    if (exportPointVis === 'start_end' && wps.length > 2) {
        wps = [wps[0], wps[wps.length - 1]];
    }

    return {
        bounds: exportBounds,
        width: dims.width,
        height: dims.height,
        format: preview ? 'png' : exportFormat,
        map_style: exportMapStyle,
        show_route: exportShowRoute,
        route_style: exportRouteStyle,
        route_color: exportRouteColor,
        route_thickness: exportRouteThickness,
        route_opacity: exportRouteOpacity / 100,
        route_dashed: exportRouteStyle === 'solid' ? exportRouteDashed : false,
        route_geometry: routeGeo,
        route_segments: routeSegments,
        show_points: exportPointVis !== 'none',
        show_point_labels: exportShowLabels,
        point_color: exportPointColor,
        point_size: exportPointSize,
        point_shape: exportPointShape,
        point_visibility: exportPointVis,
        label_size: exportLabelSize,
        waypoints: wps,
    };
}

async function _renderExportPreview() {
    if (!isExportMode) {
        return;
    }

    const requestSeq = ++_exportPreviewSeq;
    if (_exportPreviewAbort) {
        _exportPreviewAbort.abort();
    }

    const controller = new AbortController();
    _exportPreviewAbort = controller;

    const processingEl = document.getElementById('exportProcessing');
    if (processingEl) processingEl.classList.remove('hidden');

    try {
        const blob = await fetchMapExport(_buildExportPayload({ preview: true }), controller.signal);

        if (!isExportMode || requestSeq !== _exportPreviewSeq) {
            return;
        }

        const previewUrl = URL.createObjectURL(blob);
        if (_exportPreviewOverlay) {
            map.removeLayer(_exportPreviewOverlay);
        }
        if (_exportPreviewUrl) {
            URL.revokeObjectURL(_exportPreviewUrl);
        }

        _exportPreviewOverlay = L.imageOverlay(
            previewUrl,
            [[exportBounds.south, exportBounds.west], [exportBounds.north, exportBounds.east]],
            { pane: 'exportPreviewPane', interactive: false, opacity: 1 }
        ).addTo(map);
        _exportPreviewUrl = previewUrl;
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error('Export preview failed', error);
        }
    } finally {
        if (_exportPreviewAbort === controller) {
            _exportPreviewAbort = null;
            if (processingEl) processingEl.classList.add('hidden');
        }
    }
}

function _redrawExportOverlays() {
    if (!isExportMode) {
        return;
    }

    if (_exportPreviewTimer) {
        clearTimeout(_exportPreviewTimer);
    }
    _exportPreviewTimer = setTimeout(() => {
        _exportPreviewTimer = null;
        _renderExportPreview();
    }, 120);
}

// ── Bounding box editor ───────────────────────────────────────────────
function resetExportToDefaults() {
    exportMapStyle = 'light';
    exportMaxDim = 2048;
    exportFormat = 'png';
    exportShowRoute = true;
    exportRouteStyle = 'solid';
    exportRouteColor = '#2563eb';
    exportRouteGradientEnd = '#2563eb';
    exportRouteThickness = 4;
    exportRouteOpacity = 85;
    exportRouteDashed = false;
    exportPointVis = 'all';
    exportPointColor = '#2563eb';
    exportPointSize = 12;
    exportPointShape = 'circle';
    exportShowLabels = true;

    // Reset bounds to include everything
    exportBounds = _computeInitialExportBounds();

    // Sync UI elements
    document.getElementById('exportShowRoute').checked = true;
    document.getElementById('exportRouteColor').value = exportRouteColor;
    document.getElementById('exportRouteGradientEnd').value = exportRouteGradientEnd;
    document.getElementById('exportRouteThickness').value = exportRouteThickness;
    document.getElementById('exportRouteThicknessVal').textContent = exportRouteThickness;
    document.getElementById('exportRouteOpacity').value = exportRouteOpacity;
    document.getElementById('exportRouteOpacityVal').textContent = exportRouteOpacity;
    document.getElementById('exportRouteDashed').checked = false;
    document.getElementById('exportPointVisibility').value = 'all';
    document.getElementById('exportPointColor').value = exportPointColor;
    document.getElementById('exportPointSize').value = exportPointSize;
    document.getElementById('exportPointSizeVal').textContent = exportPointSize;
    document.getElementById('exportShowLabels').checked = true;
    document.getElementById('exportFormat').value = 'png';
    document.getElementById('exportMaxDimInput').value = 2048;

    _syncStyleBtns();
    _syncRouteStyleBtns();
    _syncRouteControlState();
    _syncResBtns();
    _syncShapeBtns();
    
    if (isExportMode) {
        _setTileLayer((_styleToLayer[exportMapStyle] || _styleToLayer.voyager)());
        drawExportBoundingBox();
        _updateBoundsDisplay();
    }
}

function _computeInitialExportBounds() {
    const src = drivingPathGeometry.length >= 2 ? drivingPathGeometry
              : optimizedRoute.length           ? optimizedRoute
              : points;
    if (!src.length) {
        const c = map.getCenter();
        return _normalizeExportBounds({ north: c.lat + 0.025, south: c.lat - 0.025, east: c.lng + 0.04, west: c.lng - 0.04 });
    }
    let n = -90, s = 90, e = -180, w = 180;
    src.forEach(p => { n = Math.max(n, p.lat); s = Math.min(s, p.lat); e = Math.max(e, p.lng); w = Math.min(w, p.lng); });
    const lp = Math.max((n - s) * 0.18, 0.006), lnp = Math.max((e - w) * 0.18, 0.006);
    return _normalizeExportBounds({ north: Math.min(85, n + lp), south: Math.max(-85, s - lp), east: Math.min(180, e + lnp), west: Math.max(-180, w - lnp) });
}

function _updateBoundsDisplay() {
    const f = v => v.toFixed(5);
    document.getElementById('exportNorth').textContent = f(exportBounds.north);
    document.getElementById('exportSouth').textContent = f(exportBounds.south);
    document.getElementById('exportEast').textContent  = f(exportBounds.east);
    document.getElementById('exportWest').textContent  = f(exportBounds.west);
    const { width, height } = _computeExportDims(exportBounds, exportMaxDim);
    document.getElementById('exportDimsDisplay').textContent = `${width} × ${height}`;
    if (isExportMode) {
        _redrawExportOverlays();
    }
}

function _makeExportHandle(type, lat, lng) {
    const s = { corner: [12, 12], edge: [10, 10], center: [16, 16] }[type];
    return L.marker([lat, lng], {
        draggable: true,
        icon: L.divIcon({ className: '', html: `<span class="export-handle-${type}"></span>`, iconSize: s, iconAnchor: [s[0] / 2, s[1] / 2] }),
        keyboard: false, zIndexOffset: 4000,
    });
}

function _refreshBboxRect() {
    if (!exportBboxGroup) return;
    const { north, south, east, west } = exportBounds;
    const midLat = (north + south) / 2, midLng = (east + west) / 2;

    exportBboxGroup.eachLayer(l => {
        if (l instanceof L.Rectangle) {
            l.setBounds([[south, west], [north, east]]);
        } else if (l instanceof L.Marker && l.options.type) {
            // Update handle positions based on their custom 'type' and 'pos' metadata
            const type = l.options.type;
            const pos  = l.options.pos;
            
            let newLL;
            if (type === 'center') {
                newLL = [midLat, midLng];
            } else if (type === 'corner') {
                newLL = [pos.includes('n') ? north : south, pos.includes('e') ? east : west];
            } else if (type === 'edge') {
                if (pos === 'n') newLL = [north, midLng];
                else if (pos === 's') newLL = [south, midLng];
                else if (pos === 'e') newLL = [midLat, east];
                else if (pos === 'w') newLL = [midLat, west];
            }
            if (newLL) l.setLatLng(newLL);
        }
    });
}

function drawExportBoundingBox() {
    clearExportBoundingBox();
    exportBboxGroup = L.layerGroup().addTo(map);
    const { north, south, east, west } = exportBounds;
    const midLat = (north + south) / 2, midLng = (east + west) / 2;

    exportBboxGroup.addLayer(L.rectangle([[south, west], [north, east]], {
        color: '#7c3aed', weight: 4, fillColor: '#8b5cf6', fillOpacity: 0.07,
    }));

    // Corners
    [
        { id: 'nw', lat: north, lng: west,  fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, north: ll.lat, west: ll.lng }); } },
        { id: 'ne', lat: north, lng: east,  fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, north: ll.lat, east: ll.lng }); } },
        { id: 'se', lat: south, lng: east,  fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, south: ll.lat, east: ll.lng }); } },
        { id: 'sw', lat: south, lng: west,  fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, south: ll.lat, west: ll.lng }); } }
    ].forEach(({ id, lat, lng, fn }) => {
        const h = _makeExportHandle('corner', lat, lng);
        h.options.type = 'corner'; h.options.pos = id;
        h.on('drag', e => { fn(e.target.getLatLng()); _refreshBboxRect(); _updateBoundsDisplay(); });
        h.on('dragend', () => drawExportBoundingBox());
        h.on('click', e => e.originalEvent && L.DomEvent.stop(e.originalEvent));
        exportBboxGroup.addLayer(h);
    });

    // Edge midpoints
    [
        { id: 'n', lat: north,  lng: midLng, fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, north: ll.lat }); } },
        { id: 's', lat: south,  lng: midLng, fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, south: ll.lat }); } },
        { id: 'e', lat: midLat, lng: east,   fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, east: ll.lng }); } },
        { id: 'w', lat: midLat, lng: west,   fn: ll => { exportBounds = _normalizeExportBounds({ ...exportBounds, west: ll.lng }); } }
    ].forEach(({ id, lat, lng, fn }) => {
        const h = _makeExportHandle('edge', lat, lng);
        h.options.type = 'edge'; h.options.pos = id;
        h.on('drag', e => { fn(e.target.getLatLng()); _refreshBboxRect(); _updateBoundsDisplay(); });
        h.on('dragend', () => drawExportBoundingBox());
        h.on('click', e => e.originalEvent && L.DomEvent.stop(e.originalEvent));
        exportBboxGroup.addLayer(h);
    });

    // Center
    let _sb = null, _sll = null;
    const ch = _makeExportHandle('center', midLat, midLng);
    ch.options.type = 'center';
    ch.on('dragstart', e => { _sb = { ...exportBounds }; _sll = e.target.getLatLng(); });
    ch.on('drag', e => {
        if (!_sb) return;
        const ll = e.target.getLatLng();
        const dLat = ll.lat - _sll.lat, dLng = ll.lng - _sll.lng;
        exportBounds = _translateExportBounds(dLat, dLng, _sb);
        _refreshBboxRect(); _updateBoundsDisplay();
    });
    ch.on('dragend', () => { _sb = null; _sll = null; drawExportBoundingBox(); });
    ch.on('click', e => e.originalEvent && L.DomEvent.stop(e.originalEvent));
    exportBboxGroup.addLayer(ch);
}

function clearExportBoundingBox() {
    if (exportBboxGroup) { map.removeLayer(exportBboxGroup); exportBboxGroup = null; }
}

// ── Sync button active states ─────────────────────────────────────────
function _syncStyleBtns() {
    document.querySelectorAll('.export-style-btn').forEach(b => {
        b.className = `export-style-btn text-xs font-semibold py-1.5 rounded-lg border transition ${b.dataset.style === exportMapStyle ? 'export-active' : 'export-inactive'}`;
    });
}
function _syncRouteStyleBtns() {
    document.querySelectorAll('.export-route-style-btn').forEach((button) => {
        button.className = `export-route-style-btn flex-1 py-1.5 text-[11px] font-semibold rounded-lg border transition ${button.dataset.routeStyle === exportRouteStyle ? 'export-active' : 'export-inactive'}`;
    });
}
function _syncRouteControlState() {
    document.getElementById('exportRoutePrimaryColorLabel').textContent = exportRouteStyle === 'gradient' ? 'Start color' : 'Color';
    document.getElementById('exportRouteGradientEndWrap').classList.toggle('hidden', exportRouteStyle !== 'gradient');
    document.getElementById('exportRouteDashWrap').classList.toggle('hidden', exportRouteStyle !== 'solid');
    document.getElementById('exportRouteGradientHint').classList.toggle('hidden', exportRouteStyle !== 'gradient');
}
function _syncResBtns() {
    document.querySelectorAll('.export-res-btn').forEach(b => {
        b.className = `export-res-btn text-xs font-bold py-1.5 rounded-lg border transition ${parseInt(b.dataset.max) === exportMaxDim ? 'export-active' : 'export-inactive'}`;
    });
    // Keep text input in sync; deselect all presets visually when value is non-standard
    const input = document.getElementById('exportMaxDimInput');
    if (input && parseInt(input.value) !== exportMaxDim) input.value = exportMaxDim;
}
function _syncShapeBtns() {
    document.querySelectorAll('.export-shape-btn').forEach(b => {
        b.className = `export-shape-btn flex-1 py-1.5 text-[11px] font-semibold rounded-lg border transition ${b.dataset.shape === exportPointShape ? 'export-active' : 'export-inactive'}`;
    });
}

// ── Enter / exit export mode ──────────────────────────────────────────
function enterExportMode() {
    if (isExportMode) return;
    isExportMode = true;
    _suspendEditorModesForExport();

    // Collapse sidebar to free map space; hide the sidebar toggle (we control collapse state)
    setSidebarCollapsed(true);
    sidebarToggle.style.visibility = 'hidden';

    // Hide result panels if they are open
    resultPanel.classList.add('hidden');
    panelToggle.classList.add('hidden');

    // Show export panel
    const ep = document.getElementById('exportPanel');
    ep.classList.remove('hidden');
    ep.style.display = 'flex';

    // Switch tile layer to export style, saving the current one
    _tileLayerBeforeExport = _getActiveTileLayer();
    _setTileLayer((_styleToLayer[exportMapStyle] || _styleToLayer.voyager)());

    // Suspend normal overlays (remove from map without clearing data)
    if (routeLine)             { map.removeLayer(routeLine); }
    if (drivingPathCasingLine) { map.removeLayer(drivingPathCasingLine); }
    if (drivingPathLine)       { map.removeLayer(drivingPathLine); }
    drivingPathSegments.forEach(s => map.removeLayer(s));
    drivingPathArrows.forEach(a => map.removeLayer(a));
    snapLines.forEach(l => map.removeLayer(l));
    snapDots.forEach(d => map.removeLayer(d));
    markers.forEach(m => map.removeLayer(m));   // replaced by export-styled markers

    // Set up bbox and draw live overlays
    exportBounds = _computeInitialExportBounds();
    drawExportBoundingBox();
    _updateBoundsDisplay();
    _syncStyleBtns();
    _syncRouteStyleBtns();
    _syncRouteControlState();
    _syncResBtns();
    _syncShapeBtns();
    _redrawExportOverlays();

    // Fit map so bbox is visible with the right-side panel in mind
    setTimeout(() => map.fitBounds(
        [[exportBounds.south, exportBounds.west], [exportBounds.north, exportBounds.east]],
        { paddingTopLeft: [50, 50], paddingBottomRight: [50, 295] }
    ), 20);
}

function exitExportMode() {
    if (!isExportMode) return;
    isExportMode = false;

    // Hide export panel, restore sidebar toggle
    const ep = document.getElementById('exportPanel');
    ep.classList.add('hidden');
    ep.style.display = '';
    setSidebarCollapsed(false);
    sidebarToggle.style.visibility = '';

    // Remove export layers
    _clearExportOverlays();
    clearExportBoundingBox();

    // Restore tile layer
    if (_tileLayerBeforeExport) { _setTileLayer(_tileLayerBeforeExport); _tileLayerBeforeExport = null; }

    // Restore normal overlays
    markers.forEach(m => m.addTo(map));
    if (showDrivingPath && drivingPathGeometry.length >= 2) drawDrivingPath();
    if (showRouteLine   && optimizedRoute.length >= 2)      drawOptimizedRoute(optimizedRoute);
    if (showSnapGuides)                                       drawSnapLines();
    _restoreEditorModesAfterExport();

    resetMapView();

    document.getElementById('exportStatusMsg').classList.add('hidden');
}

// ── Download ──────────────────────────────────────────────────────────
async function _doDownload() {
    const btn     = document.getElementById('btnDownloadExport');
    const btnText = document.getElementById('exportBtnText');
    const statusEl = document.getElementById('exportStatusMsg');
    btn.disabled = true;
    btnText.textContent = 'Generating…';
    statusEl.textContent = '';
    statusEl.classList.add('hidden');

    const payload = _buildExportPayload();
    const { width, height } = payload;

    try {
        const blob = await fetchMapExport(payload);
        const ext  = exportFormat === 'jpeg' ? 'jpg' : 'png';
        const ts   = new Date().toISOString().replace(/[:.]/g, '-');
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `map-export-${ts}.${ext}`; a.click();
        URL.revokeObjectURL(url);
        statusEl.textContent = `Downloaded ${width}×${height} ${exportFormat.toUpperCase()} ✓`;
        statusEl.classList.remove('hidden');
    } catch (err) {
        statusEl.textContent = err.message || 'Export failed.';
        statusEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btnText.textContent = 'Download Image';
    }
}

// ── Event wiring ──────────────────────────────────────────────────────
document.getElementById('btnExportMap').addEventListener('click', enterExportMode);
document.getElementById('btnExitExport').addEventListener('click', exitExportMode);
document.getElementById('btnResetExport').addEventListener('click', resetExportToDefaults);
document.getElementById('btnDownloadExport').addEventListener('click', _doDownload);

document.querySelectorAll('.export-style-btn').forEach(btn => btn.addEventListener('click', () => {
    exportMapStyle = btn.dataset.style;
    _syncStyleBtns();
    if (isExportMode) {
        _setTileLayer((_styleToLayer[exportMapStyle] || _styleToLayer.voyager)());
        _redrawExportOverlays();
    }
}));

document.querySelectorAll('.export-res-btn').forEach(btn => btn.addEventListener('click', () => {
    exportMaxDim = parseInt(btn.dataset.max);
    _syncResBtns();
    _updateBoundsDisplay();
}));

document.getElementById('exportMaxDimInput').addEventListener('input', e => {
    const v = parseInt(e.target.value);
    if (!Number.isFinite(v) || v < 256) return;
    exportMaxDim = Math.min(8192, v);
    // Sync preset buttons (deactivates all if value doesn't match any preset)
    document.querySelectorAll('.export-res-btn').forEach(b => {
        b.className = `export-res-btn text-xs font-bold py-1.5 rounded-lg border transition ${parseInt(b.dataset.max) === exportMaxDim ? 'export-active' : 'export-inactive'}`;
    });
    _updateBoundsDisplay();
});

document.querySelectorAll('.export-shape-btn').forEach(btn => btn.addEventListener('click', () => {
    exportPointShape = btn.dataset.shape;
    _syncShapeBtns();
    if (isExportMode) _redrawExportOverlays();
}));

document.getElementById('exportShowRoute').addEventListener('change', e => {
    exportShowRoute = e.target.checked;
    document.getElementById('exportRouteControls').style.opacity = exportShowRoute ? '1' : '0.4';
    if (isExportMode) _redrawExportOverlays();
});
document.querySelectorAll('.export-route-style-btn').forEach(btn => btn.addEventListener('click', () => {
    exportRouteStyle = btn.dataset.routeStyle || 'solid';
    _syncRouteStyleBtns();
    _syncRouteControlState();
    if (isExportMode) _redrawExportOverlays();
}));
document.getElementById('exportRouteColor').addEventListener('input', e => {
    exportRouteColor = e.target.value;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportRouteGradientEnd').addEventListener('input', e => {
    exportRouteGradientEnd = e.target.value;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportRouteThickness').addEventListener('input', e => {
    exportRouteThickness = parseInt(e.target.value);
    document.getElementById('exportRouteThicknessVal').textContent = exportRouteThickness;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportRouteOpacity').addEventListener('input', e => {
    exportRouteOpacity = parseInt(e.target.value);
    document.getElementById('exportRouteOpacityVal').textContent = exportRouteOpacity;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportRouteDashed').addEventListener('change', e => {
    exportRouteDashed = e.target.checked;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportPointVisibility').addEventListener('change', e => {
    exportPointVis = e.target.value;
    document.getElementById('exportPointControls').style.opacity = exportPointVis === 'none' ? '0.4' : '1';
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportPointColor').addEventListener('input', e => {
    exportPointColor = e.target.value;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportPointSize').addEventListener('input', e => {
    exportPointSize = parseInt(e.target.value);
    document.getElementById('exportPointSizeVal').textContent = exportPointSize;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportLabelSize').addEventListener('input', e => {
    exportLabelSize = parseInt(e.target.value);
    document.getElementById('exportLabelSizeVal').textContent = exportLabelSize;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportShowLabels').addEventListener('change', e => {
    exportShowLabels = e.target.checked;
    if (isExportMode) _redrawExportOverlays();
});
document.getElementById('exportFormat').addEventListener('change', e => { 
    exportFormat = e.target.value;
    if (isExportMode) _redrawExportOverlays();
});

// Init button states
_syncStyleBtns();
_syncRouteStyleBtns();
_syncRouteControlState();
_syncResBtns();
_syncShapeBtns();