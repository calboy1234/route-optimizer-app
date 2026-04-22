const addModeBtn = document.getElementById('btnAddMode');
const zoneModeBtn = document.getElementById('btnZoneMode');
const clearZoneBtn = document.getElementById('btnClearZone');
const exportProjectBtn = document.getElementById('btnExportProject');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const sidebarToggleIcon = document.getElementById('sidebarToggleIcon');
const pointContainer = document.getElementById('pointContainer');
const optimizeBtn = document.getElementById('btnOptimize');
const optimizeTimeBtn = document.getElementById('optimizeTimeBtn');
const optimizeDistanceBtn = document.getElementById('optimizeDistanceBtn');
const toggleMustEndLast = document.getElementById('toggleMustEndLast');
const toggleDrivingPath = document.getElementById('toggleDrivingPath');
const toggleRouteLine = document.getElementById('toggleRouteLine');
const toggleSnapGuides = document.getElementById('toggleSnapGuides');
const toggleWaypointNumbers = document.getElementById('toggleWaypointNumbers');
const placementHint = document.getElementById('placementHint');
const resultPanel = document.getElementById('resultPanel');
const panelToggle = document.getElementById('panelToggle');
const cursorVertical = document.getElementById('cursorVertical');
const cursorHorizontal = document.getElementById('cursorHorizontal');
const placementHintText = placementHint.querySelector('div');
const zoneStatus = document.getElementById('zoneStatus');
const zoneActionRow = document.getElementById('zoneActionRow');

function getSnapWarnings() {
    return points
        .filter((point) => isPointIncluded(point))
        .filter((point) => !isRoutingOnlyPoint(point))
        .filter((point) => point.snapped && Number.isFinite(point.snapped.lat) && Number.isFinite(point.snapped.lng))
        .map((point) => ({
            routeKey: point.routeKey,
            id: point.id,
            distanceMeters: getDistanceMeters(point.lat, point.lng, Number(point.snapped.lat), Number(point.snapped.lng))
        }))
        .filter((point) => point.distanceMeters > 30);
}

function updatePlacementHint() {
    if (isZonePlacementMode) {
        placementHint.classList.remove('hidden');
        placementHintText.textContent = 'Click to add zone corners. Drag green handles to edit, click white midpoint dots to add more, then click Finish Inclusion Zone.';
        return;
    }

    placementHint.classList.toggle('hidden', !isPlacementMode);
    placementHintText.textContent = 'Click anywhere on the map to place the next waypoint.';
}

function getProjectPayload() {
    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        optimizeFor,
        mustEndAtLast,
        points: points.map((point) => ({
            id: point.id,
            routeKey: point.routeKey,
            lat: point.lat,
            lng: point.lng,
            lockGroup: point.lockGroup || null
        })),
        inclusionZone: hasInclusionZone()
            ? inclusionZoneVertices.map((vertex) => ({ lat: vertex.lat, lng: vertex.lng }))
            : []
    };
}

function loadProjectPayload(projectData) {
    if (!projectData || !Array.isArray(projectData.points)) {
        throw new Error('That project file is missing waypoint data.');
    }

    const importedPoints = projectData.points
        .map((point, index) => {
            const lat = Number(point.lat);
            const lng = Number(point.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
            }

            const routeKey = typeof point.routeKey === 'string' && point.routeKey.trim()
                ? point.routeKey.trim()
                : `point-${index + 1}`;

            return {
                id: String(point.id || `Waypoint ${index + 1}`).trim() || `Waypoint ${index + 1}`,
                routeKey,
                lat: roundCoord(lat),
                lng: roundCoord(lng),
                rank: null,
                lockGroup: String(point.lockGroup || point.lock_group || '').trim() || null
            };
        })
        .filter(Boolean);

    if (!importedPoints.length) {
        throw new Error('That project file did not contain any valid waypoints.');
    }

    const importedZone = Array.isArray(projectData.inclusionZone)
        ? projectData.inclusionZone
            .map((vertex) => ({
                lat: roundCoord(Number(vertex.lat)),
                lng: roundCoord(Number(vertex.lng))
            }))
            .filter((vertex) => Number.isFinite(vertex.lat) && Number.isFinite(vertex.lng))
        : [];

    points = importedPoints;
    inclusionZoneVertices = importedZone.length >= 3 ? importedZone : [];
    includedRouteKeys = new Set();
    optimizeFor = projectData.optimizeFor === 'distance' ? 'distance' : 'time';
    mustEndAtLast = Boolean(projectData.mustEndAtLast);
    toggleMustEndLast.checked = mustEndAtLast;

    const maxRouteKeyNumber = points.reduce((maxValue, point) => {
        const match = String(point.routeKey).match(/^point-(\d+)$/);
        const numericValue = match ? Number(match[1]) : 0;
        return Math.max(maxValue, numericValue);
    }, 0);
    nextPointKey = maxRouteKeyNumber + 1;

    setPlacementMode(false);
    setZonePlacementMode(false);
    clearOptimizationState();
    redrawInclusionZone();
    updateOptimizationModeButtons();
    renderUI();
    focusMapOnPoints(points);
}

function updateOptimizationModeButtons() {
    const isTime = optimizeFor === 'time';
    optimizeTimeBtn.classList.toggle('bg-blue-600', isTime);
    optimizeTimeBtn.classList.toggle('text-white', isTime);
    optimizeTimeBtn.classList.toggle('text-slate-300', !isTime);
    optimizeDistanceBtn.classList.toggle('bg-blue-600', !isTime);
    optimizeDistanceBtn.classList.toggle('text-white', !isTime);
    optimizeDistanceBtn.classList.toggle('text-slate-300', isTime);
}

function syncZoneStatus() {
    const includedCount = getIncludedPoints().length;
    if (isZonePlacementMode) {
        zoneActionRow.classList.add('hidden');
        zoneStatus.classList.remove('hidden');
        if (!inclusionZoneVertices.length) {
            zoneStatus.innerText = 'Click on the map to place the first inclusion-zone corner.';
        } else if (!hasInclusionZone()) {
            const remainingCorners = 3 - inclusionZoneVertices.length;
            zoneStatus.innerText = `${inclusionZoneVertices.length} corner${inclusionZoneVertices.length === 1 ? '' : 's'} placed. Add ${remainingCorners} more to finish the zone.`;
        } else {
            zoneStatus.innerText = `${includedCount} of ${points.length} waypoint${points.length === 1 ? '' : 's'} inside the zone. Drag green handles to refine it or click white midpoint dots to add corners.`;
        }
        clearZoneBtn.classList.add('hidden');
        return;
    }

    if (hasInclusionZone()) {
        zoneActionRow.classList.remove('hidden');
        zoneStatus.classList.remove('hidden');
        zoneStatus.innerText = `${includedCount} of ${points.length} waypoint${points.length === 1 ? '' : 's'} inside the inclusion zone. Drag green handles to refine it or click white midpoint dots to add corners.`;
        clearZoneBtn.classList.remove('hidden');
        return;
    }

    zoneActionRow.classList.add('hidden');
    zoneStatus.classList.add('hidden');
    zoneStatus.innerText = '';
    clearZoneBtn.classList.add('hidden');
}

function refreshOptimizationAvailability() {
    const includedCount = getIncludedPoints().length;
    optimizeBtn.disabled = includedCount < 2;
    optimizeBtn.innerText = includedCount < 2 && hasInclusionZone()
        ? 'Need 2 Included Waypoints'
        : 'Run Optimization';
}

function updateZoneModeButton() {
    if (isZonePlacementMode) {
        zoneModeBtn.textContent = hasInclusionZone() ? 'Finish Inclusion Zone' : 'Cancel Inclusion Zone';
        zoneModeBtn.classList.add('bg-emerald-700');
        zoneModeBtn.classList.remove('bg-emerald-600');
        return;
    }

    zoneModeBtn.textContent = hasInclusionZone() ? 'Clear Inclusion Zone' : 'Draw Inclusion Zone';
    zoneModeBtn.classList.remove('bg-emerald-700');
    zoneModeBtn.classList.add('bg-emerald-600');
}

function finalizeInclusionZone() {
    if (!hasInclusionZone()) {
        clearInclusionZone();
        return;
    }

    isZonePlacementMode = false;
    inclusionZoneCursorLatLng = null;
    map.getContainer().style.cursor = isPlacementMode ? 'crosshair' : '';
    cursorVertical.classList.toggle('hidden', !isPlacementMode);
    cursorHorizontal.classList.toggle('hidden', !isPlacementMode);
    updateIncludedRouteKeys();
    clearOptimizationState();
    redrawInclusionZone();
    syncZoneStatus();
    updateZoneModeButton();
    updatePlacementHint();
    refreshOptimizationAvailability();
    renderUI();
}

function clearInclusionZone() {
    isZonePlacementMode = false;
    inclusionZoneVertices = [];
    includedRouteKeys = new Set();
    inclusionZoneCursorLatLng = null;
    map.getContainer().style.cursor = isPlacementMode ? 'crosshair' : '';
    cursorVertical.classList.toggle('hidden', !isPlacementMode);
    cursorHorizontal.classList.toggle('hidden', !isPlacementMode);
    clearOptimizationState();
    clearInclusionZoneLayers();
    syncZoneStatus();
    updateZoneModeButton();
    updatePlacementHint();
    refreshOptimizationAvailability();
    renderUI();
}

function setResultPanelVisible(visible) {
    resultPanel.classList.toggle('hidden', !visible);
    panelToggle.classList.toggle('hidden', visible || !hasSummary);
}

function setSidebarCollapsed(collapsed) {
    isSidebarCollapsed = collapsed;
    sidebar.classList.toggle('sidebar-collapsed', collapsed);
    sidebarToggleIcon.innerHTML = collapsed ? '&#9654;' : '&#9664;';
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
    setTimeout(() => map.invalidateSize(), SIDEBAR_RESIZE_DELAY_MS);
}

function reorderPointsByRouteKey(movedRouteKey, targetRouteKey) {
    if (!movedRouteKey || !targetRouteKey || movedRouteKey === targetRouteKey) {
        return;
    }

    const fromIndex = points.findIndex((point) => point.routeKey === movedRouteKey);
    const toIndex = points.findIndex((point) => point.routeKey === targetRouteKey);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return;
    }

    clearOptimizationState();
    const [movedPoint] = points.splice(fromIndex, 1);
    const insertionIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    points.splice(insertionIndex, 0, movedPoint);
    renderUI();
}

function setPlacementMode(active) {
    isPlacementMode = active;
    addModeBtn.textContent = active ? 'Cancel Waypoint' : 'Add Waypoint';
    addModeBtn.classList.toggle('bg-blue-600', !active);
    addModeBtn.classList.toggle('hover:bg-blue-500', !active);
    addModeBtn.classList.toggle('bg-emerald-600', active);
    addModeBtn.classList.toggle('hover:bg-emerald-500', active);
    map.getContainer().style.cursor = active ? 'crosshair' : '';
    if (active) {
        cursorVertical.style.left = '50%';
        cursorHorizontal.style.top = '50%';
    }
    cursorVertical.classList.toggle('hidden', !active);
    cursorHorizontal.classList.toggle('hidden', !active);
    updatePlacementHint();
}

function setZonePlacementMode(active) {
    isZonePlacementMode = active;
    if (active) {
        setPlacementMode(false);
    } else {
        inclusionZoneCursorLatLng = null;
    }
    map.getContainer().style.cursor = active ? 'crosshair' : (isPlacementMode ? 'crosshair' : '');
    cursorVertical.classList.toggle('hidden', !(active || isPlacementMode));
    cursorHorizontal.classList.toggle('hidden', !(active || isPlacementMode));
    updateZoneModeButton();
    updatePlacementHint();
    redrawInclusionZone();
}

function updateResultPanel(metrics, routePoints) {
    const visibleRoutePoints = getVisibleRoutePoints(routePoints);
    document.getElementById('resDist').innerText = metrics.distance_km + ' km';
    document.getElementById('resTime').innerText = formatDuration(metrics.duration_minutes);
    document.getElementById('resCount').innerText = visibleRoutePoints.length + ' included waypoints';
    const snapWarnings = getSnapWarnings();
    const snapWarningBox = document.getElementById('snapWarning');
    const snapWarningText = document.getElementById('snapWarningText');

    if (snapWarnings.length) {
        const maxWarningDistance = Math.max(...snapWarnings.map((point) => point.distanceMeters));
        snapWarningText.innerText = `${snapWarnings.length} waypoint${snapWarnings.length === 1 ? '' : 's'} snapped more than 30 m from the road point used for routing. Max offset: ${Math.round(maxWarningDistance)} m.`;
        document.getElementById('snapWarningList').innerHTML = snapWarnings
            .sort((a, b) => b.distanceMeters - a.distanceMeters)
            .map((point) => `
                <div class="rounded-lg border border-amber-200 bg-white/70 px-2 py-1.5">
                    <div class="text-[11px] font-semibold text-amber-900 break-words">${escapeHtml(point.id)}</div>
                    <div class="text-[11px] text-amber-800">${Math.round(point.distanceMeters)} m from snapped road point</div>
                </div>
            `)
            .join('');
        snapWarningBox.classList.remove('hidden');
    } else {
        snapWarningBox.classList.add('hidden');
        snapWarningText.innerText = '';
        document.getElementById('snapWarningList').innerHTML = '';
        document.getElementById('snapWarningDetails').open = false;
    }

    document.getElementById('resultStops').innerHTML = visibleRoutePoints.map((point, index) => `
        <div class="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <div class="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">${index + 1}</div>
            <div class="min-w-0">
                <p class="text-sm font-semibold text-slate-800 break-words">${escapeHtml(point.id)}</p>
                <p class="text-[11px] text-slate-500 font-mono">${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</p>
                ${point.lockGroup ? `<p class="text-[11px] text-emerald-700 mt-1">Locked group: ${escapeHtml(point.lockGroup)}</p>` : ''}
            </div>
        </div>
    `).join('');

    hasSummary = true;
    setResultPanelVisible(true);
}

function createPoint(lat, lng, name = null, fallbackIndex = points.length + 1) {
    const label = name && String(name).trim() ? String(name).trim() : `Waypoint ${fallbackIndex}`;
    return {
        id: label,
        routeKey: `point-${nextPointKey++}`,
        lat: roundCoord(lat),
        lng: roundCoord(lng),
        rank: null,
        lockGroup: null
    };
}

function addPoint(lat, lng, name = null, options = {}) {
    const latNumber = Number(lat);
    const lngNumber = Number(lng);
    if (!Number.isFinite(latNumber) || !Number.isFinite(lngNumber)) {
        return false;
    }

    if (!options.preserveOptimization) {
        clearOptimizationState();
    }

    points.push(createPoint(latNumber, lngNumber, name));
    renderUI();

    if (options.focus) {
        focusMapOnPoints([points[points.length - 1]]);
    }

    return true;
}

function renderEmptyState() {
    pointContainer.innerHTML = `
        <div class="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-8 text-center shadow-sm">
            <p class="text-sm font-semibold text-slate-700">No waypoints yet</p>
            <p class="text-xs text-slate-500 mt-2">Import a CSV or click <span class="font-semibold text-slate-700">Add Waypoint</span> and place points directly on the map.</p>
        </div>
    `;
}

function renderUI() {
    updateIncludedRouteKeys();
    syncZoneStatus();
    refreshOptimizationAvailability();
    pointContainer.innerHTML = '';
    markerLookup.clear();

    markers.forEach((marker) => map.removeLayer(marker));
    markers = [];

    if (!points.length) {
        renderEmptyState();
        return;
    }

    points.forEach((point, index) => {
        const included = isPointIncluded(point);
        const isRoutingOnly = isRoutingOnlyPoint(point);
        const isStart = point.rank === 1 || (!optimizedRoute.length && index === 0 && !isRoutingOnly);
        const row = document.createElement('div');
        row.className = `bg-white border rounded-md px-1.5 py-0.5 shadow-sm transition-colors ${included ? 'border-slate-200 hover:border-blue-200 hover:bg-blue-50/40' : 'border-slate-200/70 opacity-60 bg-slate-100'}`;
        row.dataset.routeKey = point.routeKey;
        row.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (draggedRouteKey && draggedRouteKey !== point.routeKey) {
                row.classList.add('sidebar-drop-target');
            }
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('sidebar-drop-target');
        });
        row.addEventListener('drop', (event) => {
            event.preventDefault();
            row.classList.remove('sidebar-drop-target');
            reorderPointsByRouteKey(draggedRouteKey, point.routeKey);
        });

        row.innerHTML = `
            <div class="flex items-center gap-1.5">
                <div class="drag-handle flex flex-col items-center gap-0.5 text-slate-400 cursor-grab select-none" title="Drag to reorder" draggable="true">
                    <span class="text-[8px] leading-none">::</span>
                    <span class="text-[8px] leading-none">::</span>
                </div>
                <div class="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
                    <input type="text" value="${escapeHtml(point.id)}" onchange="updatePoint(${index}, 'id', this.value)" class="compact-input flex-[1_1_74px] min-w-[68px] font-semibold" placeholder="Waypoint name">
                    <input type="text" value="${point.lat}" onchange="updatePoint(${index}, 'lat', this.value)" class="compact-input w-[92px] font-mono" aria-label="Latitude">
                    <input type="text" value="${point.lng}" onchange="updatePoint(${index}, 'lng', this.value)" class="compact-input w-[92px] font-mono" aria-label="Longitude">
                    <input type="text" value="${escapeHtml(point.lockGroup || '')}" onchange="updatePoint(${index}, 'lockGroup', this.value)" class="compact-input w-[108px]" aria-label="Lock group" placeholder="Lock group">
                </div>
                <div class="shrink-0">
                    ${included ? '' : '<span class="text-[10px] uppercase tracking-wide text-amber-700 mr-2">Excluded</span>'}
                    <button onclick="deletePoint(${index})" class="text-[10px] text-slate-400 hover:text-red-600">Remove</button>
                </div>
            </div>
        `;
        pointContainer.appendChild(row);

        const dragHandle = row.querySelector('.drag-handle');
        if (dragHandle) {
            dragHandle.addEventListener('dragstart', () => {
                draggedRouteKey = point.routeKey;
                row.classList.add('opacity-60');
            });
            dragHandle.addEventListener('dragend', () => {
                draggedRouteKey = null;
                row.classList.remove('opacity-60');
                row.classList.remove('sidebar-drop-target');
            });
        }

        if (isExportMode) {
            return;
        }

        const marker = L.marker([point.lat, point.lng], {
            draggable: true,
            opacity: included ? 1 : 0.45,
            icon: createWaypointMarkerIcon({ isStart, isIncluded: included, rank: point.rank, isRoutingOnly })
        }).addTo(map);
        marker.bindPopup(`
            <div class="min-w-[150px]">
                <div class="font-semibold">${escapeHtml(point.id)}</div>
                <div class="text-[11px] text-slate-500">${point.lat.toFixed(6)}, ${point.lng.toFixed(6)}</div>
                <div class="mt-2 text-[11px] ${isRoutingOnly ? 'text-slate-500' : (isStart ? 'text-green-700' : 'text-slate-500')}">${isRoutingOnly ? 'Routing-only waypoint' : (isStart ? 'Starting point' : 'Waypoint stop')}</div>
                ${point.lockGroup ? `<div class="mt-2 text-[11px] text-emerald-700">Locked with group "${escapeHtml(point.lockGroup)}"</div>` : ''}
                <div class="mt-2 text-[11px] ${included ? 'text-emerald-700' : 'text-amber-700'}">${included ? 'Included in optimization' : 'Outside inclusion zone'}</div>
            </div>
        `, { autoPan: false });
        marker.on('dragend', (event) => {
            clearOptimizationState();
            const position = event.target.getLatLng();
            points[index].lat = roundCoord(position.lat);
            points[index].lng = roundCoord(position.lng);
            renderUI();
        });
        markers.push(marker);
        markerLookup.set(point.routeKey, marker);
    });
}

panelToggle.addEventListener('click', () => {
    if (!hasSummary) {
        return;
    }
    setResultPanelVisible(true);
});

document.getElementById('btnHidePanel').addEventListener('click', () => {
    setResultPanelVisible(false);
});

addModeBtn.addEventListener('click', () => {
    setPlacementMode(!isPlacementMode);
    if (isPlacementMode) {
        setZonePlacementMode(false);
    }
});

zoneModeBtn.addEventListener('click', () => {
    if (isZonePlacementMode) {
        if (hasInclusionZone()) {
            finalizeInclusionZone();
        } else {
            clearInclusionZone();
        }
        return;
    }

    if (hasInclusionZone()) {
        clearInclusionZone();
        return;
    }

    setZonePlacementMode(true);
});

clearZoneBtn.addEventListener('click', () => {
    clearInclusionZone();
});

exportProjectBtn.addEventListener('click', () => {
    if (!points.length) {
        alert('Add at least one waypoint before exporting a project.');
        return;
    }

    const projectBlob = new Blob([JSON.stringify(getProjectPayload(), null, 2)], { type: 'application/json' });
    const projectUrl = URL.createObjectURL(projectBlob);
    const downloadLink = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadLink.href = projectUrl;
    downloadLink.download = `route-project-${timestamp}.json`;
    downloadLink.click();
    URL.revokeObjectURL(projectUrl);
});

sidebarToggle.addEventListener('click', () => {
    setSidebarCollapsed(!isSidebarCollapsed);
});

toggleRouteLine.addEventListener('change', () => {
    showRouteLine = toggleRouteLine.checked;
    drawOptimizedRoute(optimizedRoute);
});

toggleDrivingPath.addEventListener('change', () => {
    showDrivingPath = toggleDrivingPath.checked;
    drawDrivingPath();
});

toggleSnapGuides.addEventListener('change', () => {
    showSnapGuides = toggleSnapGuides.checked;
    drawSnapLines();
});

toggleWaypointNumbers.addEventListener('change', () => {
    showWaypointNumbers = toggleWaypointNumbers.checked;
    renderUI();
});

optimizeTimeBtn.addEventListener('click', () => {
    if (optimizeFor === 'time') {
        return;
    }
    optimizeFor = 'time';
    clearOptimizationState();
    updateOptimizationModeButtons();
    renderUI();
});

optimizeDistanceBtn.addEventListener('click', () => {
    if (optimizeFor === 'distance') {
        return;
    }
    optimizeFor = 'distance';
    clearOptimizationState();
    updateOptimizationModeButtons();
    renderUI();
});

toggleMustEndLast.addEventListener('change', () => {
    mustEndAtLast = toggleMustEndLast.checked;
    clearOptimizationState();
    renderUI();
});

map.on('mousemove', (event) => {
    if (isZonePlacementMode) {
        inclusionZoneCursorLatLng = {
            lat: roundCoord(event.latlng.lat),
            lng: roundCoord(event.latlng.lng)
        };
        cursorVertical.style.left = `${event.containerPoint.x}px`;
        cursorHorizontal.style.top = `${event.containerPoint.y}px`;
        redrawInclusionZone({ preserveEditor: true });
        return;
    }

    if (!isPlacementMode) {
        return;
    }
    cursorVertical.style.left = `${event.containerPoint.x}px`;
    cursorHorizontal.style.top = `${event.containerPoint.y}px`;
});

map.on('mouseout', () => {
    if (!isZonePlacementMode) {
        return;
    }
    inclusionZoneCursorLatLng = null;
    redrawInclusionZone({ preserveEditor: true });
});

map.on('zoomend', () => {
    if (showDrivingPath && drivingPathGeometry.length >= 2) {
        drawDrivingPath();
    }
});

map.on('click', (event) => {
    if (isExportMode) {
        return;
    }

    if (isZonePlacementMode) {
        inclusionZoneVertices.push({
            lat: roundCoord(event.latlng.lat),
            lng: roundCoord(event.latlng.lng)
        });
        inclusionZoneCursorLatLng = {
            lat: roundCoord(event.latlng.lat),
            lng: roundCoord(event.latlng.lng)
        };
        redrawInclusionZone();
        updateZoneModeButton();
        return;
    }

    if (!isPlacementMode) {
        return;
    }

    addPoint(event.latlng.lat, event.latlng.lng);
    setPlacementMode(false);
});

window.updatePoint = (index, field, value) => {
    if (!points[index]) {
        return;
    }

    clearOptimizationState();

    if (field === 'id') {
        points[index].id = String(value).trim() || `Waypoint ${index + 1}`;
        renderUI();
        return;
    }

    if (field === 'lockGroup') {
        points[index].lockGroup = String(value).trim() || null;
        renderUI();
        return;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        renderUI();
        return;
    }

    if (!isCoordinateInRange(field, parsed)) {
        alert(field === 'lat'
            ? 'Latitude must be between -90 and 90.'
            : 'Longitude must be between -180 and 180.');
        renderUI();
        return;
    }

    points[index][field] = roundCoord(parsed);
    renderUI();
};

window.deletePoint = (index) => {
    points.splice(index, 1);
    clearOptimizationState();
    renderUI();
};

window.movePoint = (index, direction) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= points.length) {
        return;
    }

    clearOptimizationState();
    [points[index], points[nextIndex]] = [points[nextIndex], points[index]];
    renderUI();
};

optimizeBtn.addEventListener('click', async function() {
    const includedPoints = getIncludedPoints();
    if (includedPoints.length < 2) {
        return;
    }

    this.disabled = true;
    this.innerText = 'Processing...';

    try {
        const data = await fetchOptimization({
            optimize_for: optimizeFor,
            must_end_at_last: mustEndAtLast,
            locations: includedPoints.map((point) => ({
                id: point.id,
                route_key: point.routeKey,
                lat: point.lat,
                lng: point.lng,
                lock_group: point.lockGroup || null
            }))
        });

        if (data && data.status === 'success') {
            optimizedRoute = data.optimized_route.map((routePoint) => {
                const routeKey = routePoint.route_key || routePoint.id;
                const localPoint = points.find((point) => point.routeKey === routeKey);
                return {
                    id: routePoint.id || (localPoint ? localPoint.id : routeKey),
                    routeKey,
                    lat: routePoint.lat,
                    lng: routePoint.lng,
                    snapped: routePoint.snapped || null,
                    lockGroup: localPoint ? localPoint.lockGroup : (routePoint.lock_group || null)
                };
            });
            drivingPathGeometry = Array.isArray(data.road_geometry) ? data.road_geometry : [];
            drivingPathLegGeometry = Array.isArray(data.road_legs) ? data.road_legs : [];
            const optimizedPointLookup = new Map(
                optimizedRoute.map((routePoint) => [routePoint.routeKey, routePoint])
            );
            const visibleRouteRankLookup = buildVisibleRouteRankLookup(optimizedRoute);
            points.forEach((point) => {
                const optimizedPoint = optimizedPointLookup.get(point.routeKey);
                point.rank = visibleRouteRankLookup.get(point.routeKey) || null;
                point.snapped = optimizedPoint ? optimizedPoint.snapped : null;
            });

            drawDrivingPath(optimizedRoute);
            drawOptimizedRoute(optimizedRoute);
            drawSnapLines();
            updateResultPanel(data.metrics, optimizedRoute);
            renderUI();
        }
    } catch (error) {
        alert(error.message || 'Optimization failed.');
    } finally {
        refreshOptimizationAvailability();
    }
});

document.getElementById('fileInput').addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    if (!file) {
        return;
    }

    const fileName = String(file.name || '').toLowerCase();
    if (fileName.endsWith('.json') || file.type === 'application/json') {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const projectData = JSON.parse(String(reader.result || '{}'));
                loadProjectPayload(projectData);
            } catch (error) {
                alert(error.message || 'That project file could not be imported.');
            } finally {
                event.target.value = '';
            }
        };
        reader.onerror = () => {
            alert('That project file could not be read.');
            event.target.value = '';
        };
        reader.readAsText(file);
        return;
    }

    Papa.parse(file, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: 'greedy',
        transformHeader: (header) => sanitizeHeader(header),
        complete: (results) => {
            const importedRows = results.data
                .map(normalizeRow)
                .filter(Boolean);

            if (!importedRows.length) {
                alert('No valid latitude/longitude rows were found in that file.');
                event.target.value = '';
                return;
            }

            clearOptimizationState();
            const importedPoints = [];
            importedRows.forEach((row) => {
                const point = createPoint(row.lat, row.lng, row.name, points.length + 1);
                points.push(point);
                importedPoints.push(point);
            });
            renderUI();
            focusMapOnPoints(importedPoints);
            event.target.value = '';
        },
        error: () => {
            alert('The file could not be read.');
            event.target.value = '';
        }
    });
});

updateOptimizationModeButtons();
renderUI();