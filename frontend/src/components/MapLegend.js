import React, { useState } from 'react';
import './MapLegend.css';

// Collapsible legend explaining the three map layers:
// incident heat, county court-case shading, and detention-center pins.
function MapLegend({ isMobile }) {
    const [isOpen, setIsOpen] = useState(!isMobile);

    if (!isOpen) {
        return (
            <button
                className="map-legend-toggle"
                onClick={() => setIsOpen(true)}
                aria-label="Show map legend"
            >
                Legend
            </button>
        );
    }

    return (
        <div className="map-legend">
            <div className="map-legend-header">
                <span className="map-legend-title">Legend</span>
                <button
                    className="map-legend-close"
                    onClick={() => setIsOpen(false)}
                    aria-label="Hide map legend"
                >
                    ×
                </button>
            </div>

            <div className="map-legend-section">
                <div className="map-legend-gradient heat-gradient" />
                <div className="map-legend-labels">
                    <span>fewer</span>
                    <span className="map-legend-caption">reported ICE incidents</span>
                    <span>more</span>
                </div>
            </div>

            <div className="map-legend-section">
                <div className="map-legend-gradient county-gradient" />
                <div className="map-legend-labels">
                    <span>fewer</span>
                    <span className="map-legend-caption">open immigration court cases (by county)</span>
                    <span>more</span>
                </div>
            </div>

            <div className="map-legend-section map-legend-pin-row">
                <span className="map-legend-pin" style={{ background: '#4caf50', color: '#fff' }}>0</span>
                <span className="map-legend-pin" style={{ background: '#ff9800' }}>5</span>
                <span className="map-legend-pin" style={{ background: '#d32f2f', color: '#fff' }}>15</span>
                <span className="map-legend-pin-text">
                    Detention facility — number of deficiencies cited in its latest ODO inspection
                </span>
            </div>
            <div className="map-legend-section map-legend-pin-row">
                <span className="map-legend-pin" style={{ background: '#fb8c00' }}></span>
                <span className="map-legend-pin-text">
                    No published ODO inspection findings
                </span>
            </div>
        </div>
    );
}

export default MapLegend;
