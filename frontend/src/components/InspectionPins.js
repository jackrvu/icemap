import React, { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import './InspectionPins.css';

// Objective pin styling: the number shown is the count of deficiencies
// cited in the facility's most recent substantive ODO inspection (taken
// directly from the published report). Facilities without published ODO
// findings get a neutral mid-scale orange pin with no number.
export const getDeficiencyColor = (deficiencies) => {
    if (deficiencies === null || deficiencies === undefined) return '#fb8c00';
    if (deficiencies === 0) return '#4caf50';   // green: none cited
    if (deficiencies <= 3) return '#ffc107';    // amber
    if (deficiencies <= 7) return '#ff9800';    // orange
    if (deficiencies <= 12) return '#f4511e';   // deep orange
    if (deficiencies <= 20) return '#d32f2f';   // red
    return '#8b0000';                           // dark red: 21+
};

const createInspectionIcon = (deficiencies) => {
    const size = 32; // Fixed size for all pins
    const hasData = deficiencies !== null && deficiencies !== undefined;
    const color = getDeficiencyColor(deficiencies);
    const label = hasData ? deficiencies : '';

    // Dark text on the lighter (amber/orange) backgrounds
    const brightness = (hasData && deficiencies > 0 && deficiencies <= 7) ? '#333333' : '#ffffff';

    return L.divIcon({
        className: 'inspection-pin',
        html: `
            <div style="
                position: relative;
                width: ${size}px;
                height: ${size * 1.4}px;
                cursor: pointer;
            ">
                <!-- Pin body -->
                <div style="
                    position: absolute;
                    top: 0;
                    left: 50%;
                    transform: translateX(-50%);
                    width: ${size}px;
                    height: ${size}px;
                    background-color: ${color};
                    border: 2px solid ${color};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    color: ${brightness};
                    font-weight: bold;
                    font-size: 12px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                    z-index: 2;
                ">
                    ${label}
                </div>
                <!-- Pin shadow -->
                <div style="
                    position: absolute;
                    bottom: 0;
                    left: 50%;
                    transform: translateX(-50%);
                    width: ${size * 0.6}px;
                    height: ${size * 0.4}px;
                    background-color: rgba(0,0,0,0.2);
                    border-radius: 50%;
                    z-index: 1;
                "></div>
            </div>
        `,
        iconSize: [size, size * 1.4],
        iconAnchor: [size / 2, size]
    });
};

function InspectionPins({ inspectionData, onPinClick, enabled = true }) {
    const map = useMap();
    const markersRef = useRef([]);

    useEffect(() => {
        // Create a pane for inspection pins if it doesn't exist yet
        if (!map.getPane('detentionCenterPane')) {
            map.createPane('detentionCenterPane');
            map.getPane('detentionCenterPane').style.zIndex = 650; // Higher than city markers (450) but lower than popups (1000)
        }

        if (!enabled || !inspectionData || inspectionData.length === 0) {
            // Clear existing markers
            markersRef.current.forEach(marker => {
                if (map.hasLayer(marker)) {
                    map.removeLayer(marker);
                }
            });
            markersRef.current = [];
            return;
        }

        // Clear existing markers
        markersRef.current.forEach(marker => {
            if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        });
        markersRef.current = [];

        // Add new markers (bad-match exclusions are no longer needed: the
        // pipeline only geolocates facilities with state-verified matches)
        inspectionData
            .forEach(facility => {
                const lat = parseFloat(facility.latitude);
                const lng = parseFloat(facility.longitude);

                if (isNaN(lat) || isNaN(lng)) return;

                const latestSubstantive = facility.odo && facility.odo.latest_substantive;
                const deficiencies = latestSubstantive && typeof latestSubstantive.total_deficiencies === 'number'
                    ? latestSubstantive.total_deficiencies
                    : null;
                const icon = createInspectionIcon(deficiencies);

                const marker = L.marker([lat, lng], {
                    icon,
                    pane: 'detentionCenterPane'
                });

                // Create tooltip for hover
                const tooltip = L.tooltip({
                    permanent: false,
                    direction: 'top',
                    offset: [0, -10],
                    className: 'inspection-tooltip',
                    opacity: 0.9
                });

                const place = [facility.city, facility.state].filter(Boolean).join(', ');
                const inspectionYear = latestSubstantive && latestSubstantive.date_iso
                    ? latestSubstantive.date_iso.slice(0, 4)
                    : null;
                const findingsLine = deficiencies !== null
                    ? `${deficiencies} deficienc${deficiencies === 1 ? 'y' : 'ies'} in latest ODO inspection${inspectionYear ? ` (${inspectionYear})` : ''}`
                    : 'No published ODO inspection findings';

                // Set tooltip content
                tooltip.setContent(`
                    <div style="
                        text-align: center;
                        min-width: 200px;
                        max-width: 300px;
                        font-size: 12px;
                        line-height: 1.3;
                        word-wrap: break-word;
                        background-color: white;
                        color: #666666;
                        padding: 8px;
                        border-radius: 4px;
                        border: 1px solid #ccc;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    ">
                        <strong>${facility.name}</strong>
                        ${place ? `<br/>${place}` : ''}
                        <br/><span style="color:#999;">${findingsLine}</span>
                    </div>
                `);

                marker.bindTooltip(tooltip);

                // Add click handler
                marker.on('click', () => {
                    if (onPinClick) {
                        onPinClick(facility);
                    }
                });

                marker.addTo(map);
                markersRef.current.push(marker);
            });

        return () => {
            // Cleanup markers on unmount
            markersRef.current.forEach(marker => {
                if (map.hasLayer(marker)) {
                    map.removeLayer(marker);
                }
            });
            markersRef.current = [];
        };
    }, [inspectionData, map, enabled, onPinClick]);

    return null;
}

export default InspectionPins;