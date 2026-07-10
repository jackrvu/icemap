import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import './Branding.css';
import CountyCaseHeatMap from './components/CountyCaseHeatMap';
import InspectionPins from './components/InspectionPins';
import CityMarkers from './components/CityMarkers';
import MapLegend from './components/MapLegend';
import './components/HeatMapLayer.css';

// Fix for default markers in react-leaflet
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Import leaflet.heat dynamically
let HeatLayer;
try {
    require('leaflet.heat');
    // Ensure we have access to the original heatLayer implementation
    const originalHeatLayer = L.heatLayer;

    // Create a wrapper that sets the correct pane
    HeatLayer = function (data, options) {
        // Create a heatmap layer with the specified options
        const heatLayer = originalHeatLayer(data, options);

        // Override the onAdd method to ensure it's added to a specific pane
        const originalOnAdd = heatLayer.onAdd;
        heatLayer.onAdd = function (map) {
            // Create a special pane for heat if it doesn't exist
            if (!map.getPane('heatPane')) {
                map.createPane('heatPane');
                map.getPane('heatPane').style.zIndex = 400; // Lower than city markers (450) and detention centers (650)
            }

            // Save the original container and pane
            const result = originalOnAdd.call(this, map);

            // Move the heat canvas to our special pane
            if (this._heat && this._heat._container) {
                map.getPane('heatPane').appendChild(this._heat._container);
            }

            return result;
        };

        return heatLayer;
    };
} catch (error) {
    console.warn('leaflet.heat not available, falling back to basic implementation');
    // Fallback implementation
    HeatLayer = function (data, options) {
        // Create a layerGroup that will be added to the special pane
        const layer = L.layerGroup();
        data.forEach(point => {
            const circle = L.circle([point[0], point[1]], {
                radius: options.radius || 20,
                fillColor: '#8B0000', // Dark maroon
                color: '#8B0000',
                weight: 1,
                opacity: 0.8,
                fillOpacity: Math.min(point[2] / 5, 0.9), // More sensitive to fewer arrests
                interactive: false, // Ensure circles don't block clicks
                pane: 'heatPane' // Use the heat pane for better z-index control
            });
            layer.addLayer(circle);
        });
        return layer;
    };
}

// Aggregate raw points into grid cells and weight each cell by log2(1 + count),
// so dense metros don't saturate the whole gradient and single articles stay visible.
function binHeatPoints(points, binSizeDeg) {
    if (!binSizeDeg) {
        return { points: points.map(p => [p.lat, p.lng, 1]), maxWeight: 1 };
    }
    const bins = new Map();
    for (const p of points) {
        const key = `${Math.round(p.lat / binSizeDeg)},${Math.round(p.lng / binSizeDeg)}`;
        const bin = bins.get(key);
        if (bin) {
            bin.latSum += p.lat;
            bin.lngSum += p.lng;
            bin.count += 1;
        } else {
            bins.set(key, { latSum: p.lat, lngSum: p.lng, count: 1 });
        }
    }
    let maxWeight = 1;
    const out = [];
    for (const b of bins.values()) {
        const w = Math.log2(1 + b.count);
        if (w > maxWeight) maxWeight = w;
        out.push([b.latSum / b.count, b.lngSum / b.count, w]);
    }
    return { points: out, maxWeight };
}

// Bin coarser when zoomed out, finer when zoomed in, raw points past zoom 8
function binSizeForZoom(zoom) {
    if (zoom <= 5) return 0.4;
    if (zoom <= 6) return 0.2;
    if (zoom <= 8) return 0.08;
    return 0;
}

// Heat map layer component
// heatmapPoints: [[lat, lng], ...] pre-fetched from API — uses arrestData as fallback
function HeatMapLayer({ arrestData, heatmapPoints, enabled = true }) {
    const map = useMap();
    const heatLayerRef = useRef(null);

    useEffect(() => {
        const hasHeatmap = heatmapPoints && heatmapPoints.length > 0;
        const hasArrests = arrestData && arrestData.length > 0;
        if ((!hasHeatmap && !hasArrests) || !enabled) {
            return;
        }

        // Prefer dedicated heatmap points (full history, just lat/lng)
        // Fall back to arrestData if heatmap not loaded yet
        const rawPoints = hasHeatmap
            ? heatmapPoints
                .map(([lat, lng]) => ({ lat, lng }))
                .filter(p => !isNaN(p.lat) && !isNaN(p.lng))
            : arrestData
                .map(a => ({ lat: parseFloat(a.latitude), lng: parseFloat(a.longitude) }))
                .filter(p => !isNaN(p.lat) && !isNaN(p.lng));

        const render = () => {
            if (heatLayerRef.current) {
                map.removeLayer(heatLayerRef.current);
            }

            const { points, maxWeight } = binHeatPoints(rawPoints, binSizeForZoom(map.getZoom()));

            heatLayerRef.current = HeatLayer(points, {
                radius: 18,
                blur: 14,
                maxZoom: 10,
                // Slightly below the true max so the busiest metros reach the
                // deep-red end of the gradient instead of everything sitting yellow
                max: maxWeight * 0.75,
                gradient: {
                    0.0: '#FFFF00',   // Yellow for low intensity
                    0.2: '#FFD700',   // Gold
                    0.4: '#FF8C00',   // Dark orange
                    0.6: '#DC143C',   // Crimson
                    0.8: '#B22222',   // Fire brick
                    1.0: '#8B0000'    // Dark maroon for high intensity
                }
            });

            map.addLayer(heatLayerRef.current);
        };

        render();
        map.on('zoomend', render);

        return () => {
            map.off('zoomend', render);
            if (heatLayerRef.current) {
                map.removeLayer(heatLayerRef.current);
            }
        };
    }, [arrestData, heatmapPoints, enabled]);

    return null;
}

// Cursor tracking component
function CursorTracker({ onCursorMove, onMapClick }) {
    const map = useMap();

    // Memoize event handlers to prevent recreation
    const handleMouseMove = useCallback((e) => {
        // Convert screen coordinates to lat/lng
        const latlng = map.containerPointToLatLng([e.originalEvent.clientX, e.originalEvent.clientY]);
        onCursorMove({
            lat: latlng.lat,
            lng: latlng.lng,
            zoom: map.getZoom()
        });
    }, [map, onCursorMove]);

    const handleMouseLeave = useCallback(() => {
        // Clear cursor position when mouse leaves map
        onCursorMove(null);
    }, [onCursorMove]);

    const handleMapClick = useCallback(() => {
        if (onMapClick) {
            onMapClick();
        }
    }, [onMapClick]);

    useEffect(() => {
        map.on('mousemove', handleMouseMove);
        map.on('mouseout', handleMouseLeave);

        // Priority: always fire onMapClick on map click
        if (onMapClick) {
            map.on('click', handleMapClick);
        }

        return () => {
            map.off('mousemove', handleMouseMove);
            map.off('mouseout', handleMouseLeave);
            if (onMapClick) {
                map.off('click', handleMapClick);
            }
        };
    }, [map, handleMouseMove, handleMouseLeave, handleMapClick, onMapClick]);

    return null;
}

// Zoom-based inspection pins component
function ZoomBasedInspectionPins({ inspectionData, onPinClick, enabled }) {
    const map = useMap();
    const [showPins, setShowPins] = useState(false);

    // Memoize the zoom handler to prevent recreation
    const handleZoomEnd = useCallback(() => {
        const zoom = map.getZoom();
        setShowPins(zoom >= 4);
    }, [map]);

    useEffect(() => {
        // Set initial state
        handleZoomEnd();

        map.on('zoomend', handleZoomEnd);

        return () => {
            map.off('zoomend', handleZoomEnd);
        };
    }, [handleZoomEnd]); // Remove map dependency

    return (
        <InspectionPins
            inspectionData={inspectionData}
            onPinClick={onPinClick}
            enabled={showPins && enabled}
        />
    );
}

function useIsDesktop(threshold = 900) {
    const [isDesktop, setIsDesktop] = useState(() => window.innerWidth > threshold);
    useEffect(() => {
        const handleResize = () => setIsDesktop(window.innerWidth > threshold);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [threshold]);
    return isDesktop;
}

const TIME_RANGES = [
    { value: '7', label: '7d' },
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
    { value: 'all', label: 'All' },
];

function MapComponent({ arrestData, heatmapPoints, inspectionData, onCursorMove, onMapClick, onInspectionPinClick, showDetentionPins, onToggleDetentionPins, timeRange, onTimeRangeChange }) {
    const isDesktop = useIsDesktop();


    // Calculate center of the map based on data
    const center = arrestData.length > 0
        ? [
            arrestData.reduce((sum, arrest) => sum + parseFloat(arrest.latitude), 0) / arrestData.length,
            arrestData.reduce((sum, arrest) => sum + parseFloat(arrest.longitude), 0) / arrestData.length
        ]
        : [39.8283, -98.5795]; // Default to center of US

    return (
        <div className="map-container">
            <div className="branding-overlay">
                icemap.dev
            </div>
            {/* Desktop controls - only show on web/desktop */}
            {isDesktop && (
                <div className="map-controls">
                    <div className={`checkbox-container ${showDetentionPins ? 'checked' : ''}`}>
                        <div
                            className={`checkbox ${showDetentionPins ? 'checked' : ''}`}
                            onClick={onToggleDetentionPins}
                        >
                            {showDetentionPins && <div className="checkmark">✓</div>}
                        </div>
                        <span className="checkbox-label">Detention Center Pins</span>
                    </div>
                </div>
            )}
            {onTimeRangeChange && (
                <div className={`time-range-control ${isDesktop ? 'desktop' : 'mobile'}`}>
                    {TIME_RANGES.map(r => (
                        <button
                            key={r.value}
                            className={`time-range-button ${timeRange === r.value ? 'active' : ''}`}
                            onClick={() => onTimeRangeChange(r.value)}
                        >
                            {r.label}
                        </button>
                    ))}
                </div>
            )}
            <MapLegend isMobile={!isDesktop} />
            <MapContainer
                center={center}
                zoom={4}
                zoomControl={false}
                style={{ height: 'calc(100vh - 100px)', width: '100%' }}
            >
                <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                />
                {/* Change the rendering order - first county layer, then heat map layer, then city markers on top */}
                <CountyCaseHeatMap enabled={true} />
                <HeatMapLayer arrestData={arrestData} heatmapPoints={heatmapPoints} enabled={true} />
                <ZoomBasedInspectionPins
                    inspectionData={inspectionData}
                    onPinClick={onInspectionPinClick}
                    enabled={showDetentionPins}
                />
                {/* <CityMarkers enabled={true} /> */}
                {(onCursorMove || onMapClick) && <CursorTracker onCursorMove={onCursorMove} onMapClick={onMapClick} />}
            </MapContainer>
        </div>
    );
}

export default MapComponent;