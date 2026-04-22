async function fetchOptimization(payload) {
    const response = await fetch('/api/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
        throw new Error((data && data.detail) || 'Optimization failed.');
    }
    return data;
}

async function fetchMapExport(payload, signal) {
    const response = await fetch('/api/export-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || 'Export failed.');
    }

    return await response.blob();
}