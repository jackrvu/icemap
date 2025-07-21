import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import * as d3Scale from 'd3-scale';
import * as d3Interpolate from 'd3-scale-chromatic';
import { interpolateRgb } from 'd3-interpolate';
import './CountyCaseHeatMap.css';

// County Case Heat Map component
function CountyCaseHeatMap({ enabled = true }) {
    const map = useMap();
    const [countyData, setCountyData] = useState(null);
    const [caseData, setCaseData] = useState({});
    const geojsonLayerRef = useRef(null);

    // Track if the map is currently moving
    const [isMapMoving, setIsMapMoving] = useState(false);

    useEffect(() => {
        if (!map) return;
        const handleMoveStart = () => setIsMapMoving(true);
        const handleMoveEnd = () => setIsMapMoving(false);
        map.on('movestart', handleMoveStart);
        map.on('moveend', handleMoveEnd);
        // Removed zoomstart/zoomend handlers to fix zooming
        return () => {
            map.off('movestart', handleMoveStart);
            map.off('moveend', handleMoveEnd);
        };
    }, [map]);

    // Helper to close all tooltips for all county layers
    const closeAllTooltips = useCallback(() => {
        if (geojsonLayerRef.current) {
            geojsonLayerRef.current.eachLayer(layer => {
                if (layer.closeTooltip) {
                    layer.closeTooltip();
                }
            });
        }
    }, []);

    // Memoize the color scale to prevent recreation on every render
    const colorScale = useMemo(() => {
        if (!Object.keys(caseData).length) return null;

        const caseCounts = Object.values(caseData).map(data => data.totalCases).filter(count => count > 0);
        const minCount = Math.min(...caseCounts) || 0;
        const maxCount = Math.max(...caseCounts) || 1;

        // Create a custom color scale that is overall redder and starts at a darker baseline
        const customInterpolator = t => {
            // t is normalized [0,1] value
            // For the lowest 40%, blend from #fc9272 (light red) to #de2d26 (dark red)
            if (t < 0.4) {
                return interpolateRgb("#fc9272", "#de2d26")(t / 0.4);
            }
            // For the rest, blend from #de2d26 (dark red) to #800026 (very dark red)
            return interpolateRgb("#de2d26", "#800026")((t - 0.4) / 0.6);
        };

        return d3Scale.scaleSequential()
            .domain([minCount, maxCount])
            .interpolator(customInterpolator);
    }, [caseData]);

    // Memoize the opacity scale
    const opacityScale = useMemo(() => {
        if (!Object.keys(caseData).length) return null;

        const caseCounts = Object.values(caseData).map(data => data.totalCases).filter(count => count > 0);
        const minCount = Math.min(...caseCounts) || 0;
        const maxCount = Math.max(...caseCounts) || 1;

        return d3Scale.scaleLinear()
            .domain([minCount, maxCount])
            .range([0.5, 0.95]);
    }, [caseData]);

    // Memoize the style function to prevent recreation on every render
    const styleFunction = useCallback((feature) => {
        if (!colorScale || !opacityScale) {
            return {
                fillColor: '#ffffff',
                weight: 0.8,
                opacity: 1,
                color: '#e34a33',
                fillOpacity: 0.2,
                className: 'county-polygon',
                zIndex: 100
            };
        }

        const countyId = feature.id;
        const countyData = caseData[countyId] || { totalCases: 0, cases90Days: 0 };
        const caseCount = countyData.totalCases;
        let fillColor = '#ffffff';
        let fillOpacity = 0.2;
        let borderColor = '#e34a33';
        let borderWeight = 0.8;
        let zIndex = 100;

        if (caseCount > 0) {
            fillColor = colorScale(caseCount);
            fillOpacity = opacityScale(caseCount);
        }

        return {
            fillColor: fillColor,
            weight: borderWeight,
            opacity: 1,
            color: borderColor,
            fillOpacity: fillOpacity,
            className: 'county-polygon',
            zIndex: zIndex
        };
    }, [colorScale, opacityScale, caseData]);

    // Memoize the onEachFeature function
    const onEachFeatureFunction = useCallback((feature, layer) => {
        // Extract county name from properties
        const countyName = feature.properties.NAME;
        const countyId = feature.id;
        const countyData = caseData[countyId] || { totalCases: 0, cases90Days: 0 };
        const caseCount = countyData.totalCases;
        const caseCount90Days = countyData.cases90Days;

        // Format case counts with commas
        const formattedCount = caseCount.toLocaleString();
        const formattedCount90Days = caseCount90Days.toLocaleString();

        // Create tooltip with county info, total open cases, and cases in past 90 days
        layer.bindTooltip(`
            <div style="font-weight:600; margin-bottom:4px;">${countyName}</div>
            <div style="display:flex; align-items:center; margin-bottom:3px;">
                <span style="color:#3182bd; font-weight:bold; margin-right:5px;">${formattedCount}</span>
                <span style="color:#800000;">open cases</span>
            </div>
            <div style="display:flex; align-items:center;">
                <span style="color:#3182bd; font-weight:bold; margin-right:5px;">${formattedCount90Days}</span>
                <span style="color:#800000;">cases opened in past 90 days</span>
            </div>
        `, {
            sticky: true,
            offset: [0, -5],
            direction: 'top',
            className: 'county-tooltip'
        });

        // Add event listeners for hover highlighting only (no click functionality)
        layer.on({
            mouseover: function (e) {
                const l = e.target;
                l.setStyle({
                    weight: 2.5,
                    color: '#1a4a8a',
                    fillOpacity: 0.95,
                    dashArray: ''
                });

                if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                    l.bringToFront();
                }

                // Only show the tooltip if the map is not moving
                if (!isMapMoving) {
                    layer.openTooltip();
                }
            },
            mouseout: function (e) {
                geojsonLayerRef.current.resetStyle(e.target);
                // Close all tooltips on mouseout
                closeAllTooltips();
            },
            click: function (e) {
                // Completely prevent any click functionality
                if (e.originalEvent) {
                    e.originalEvent.preventDefault();
                    e.originalEvent.stopPropagation();
                }
                return false; // Prevent further event propagation
            },
            mousedown: function (e) {
                // Prevent default Leaflet highlighting
                if (e.originalEvent) {
                    e.originalEvent.preventDefault();
                    e.originalEvent.stopPropagation();
                }
                return false; // Prevent further event propagation
            }
        });
    }, [caseData, closeAllTooltips, isMapMoving]);

    // Memoize the style function and onEachFeatureFunction refs to avoid unnecessary re-creation
    const styleFunctionRef = useRef();
    const onEachFeatureFunctionRef = useRef();
    styleFunctionRef.current = styleFunction;
    onEachFeatureFunctionRef.current = onEachFeatureFunction;

    useEffect(() => {
        // Load the US counties GeoJSON
        const loadCountyData = async () => {
            try {
                // Using a public counties GeoJSON source
                const response = await fetch('https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json');
                const data = await response.json();
                setCountyData(data);
            } catch (error) {
                console.error('Error loading county data:', error);
            }
        };

        // Load case count data from casesbycounty.csv
        const loadCaseData = async () => {
            try {
                const response = await fetch('/casesbycounty.csv');
                const csvText = await response.text();

                const parsedData = {};

                // Parse the CSV
                const lines = csvText.split('\n');
                const headers = lines[0].split(',');

                // Process each line of the CSV
                lines.slice(1).forEach(line => {
                    if (!line.trim()) return;

                    // Handle quoted values that may contain commas
                    let values = [];
                    let inQuotes = false;
                    let currentValue = '';

                    for (let i = 0; i < line.length; i++) {
                        if (line[i] === '"') {
                            inQuotes = !inQuotes;
                        } else if (line[i] === ',' && !inQuotes) {
                            values.push(currentValue);
                            currentValue = '';
                        } else {
                            currentValue += line[i];
                        }
                    }

                    // Add the last value
                    values.push(currentValue);

                    // Extract the county ID and case counts
                    const countyId = values[0]?.trim();
                    let caseCount = values[1]?.trim();
                    let caseCount90Days = values[3]?.trim(); // cocount90 is the 4th column (index 3)

                    // Remove commas and convert to number
                    if (caseCount) {
                        caseCount = parseInt(caseCount.replace(/,/g, ''), 10);
                    }

                    if (caseCount90Days) {
                        caseCount90Days = parseInt(caseCount90Days.replace(/,/g, ''), 10);
                    }

                    if (countyId && !isNaN(caseCount)) {
                        parsedData[countyId] = {
                            totalCases: caseCount,
                            cases90Days: caseCount90Days || 0
                        };
                    }
                });

                setCaseData(parsedData);
            } catch (error) {
                console.error('Error loading case count data:', error);
            }
        };

        loadCountyData();
        loadCaseData();

        return () => {
            if (geojsonLayerRef.current) {
                map.removeLayer(geojsonLayerRef.current);
            }
        };
    }, []); // Remove map dependency to prevent recreation on zoom

    useEffect(() => {
        if (!countyData || !Object.keys(caseData).length || !enabled) {
            return;
        }

        // Remove existing layer
        if (geojsonLayerRef.current) {
            map.removeLayer(geojsonLayerRef.current);
        }

        // Create GeoJSON layer
        geojsonLayerRef.current = L.geoJSON(countyData, {
            style: styleFunctionRef.current,
            interactive: true, // Re-enable interactions for hover events
            onEachFeature: onEachFeatureFunctionRef.current
        });

        // Add the layer to the map
        if (enabled) {
            // Create a custom pane for the choropleth layer to control z-index
            if (!map.getPane('countyPane')) {
                map.createPane('countyPane');
                map.getPane('countyPane').style.zIndex = 200; // Lower value to ensure it's below the heat map layer
            }

            geojsonLayerRef.current.options.pane = 'countyPane';
            geojsonLayerRef.current.addTo(map);
        } else {
            // Remove the layer if not enabled
            if (geojsonLayerRef.current) {
                map.removeLayer(geojsonLayerRef.current);
            }
        }

        return () => {
            if (geojsonLayerRef.current) {
                map.removeLayer(geojsonLayerRef.current);
            }
        };

    }, [countyData, caseData, enabled]); // Only depend on data and enabled

    // Add this effect to close all tooltips on drag or mousedown
    useEffect(() => {
        if (!geojsonLayerRef.current || !map) return;

        map.on('mousedown', closeAllTooltips);
        map.on('dragstart', closeAllTooltips);

        // Also close all tooltips when mouse leaves the map container
        const container = map.getContainer();
        container.addEventListener('mouseleave', closeAllTooltips);

        return () => {
            map.off('mousedown', closeAllTooltips);
            map.off('dragstart', closeAllTooltips);
            container.removeEventListener('mouseleave', closeAllTooltips);
        };
    }, [map, geojsonLayerRef.current, closeAllTooltips]);

    return null;
}

export default CountyCaseHeatMap;
