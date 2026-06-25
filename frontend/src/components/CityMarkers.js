import React, { useEffect, useState, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import './CityMarkers.css';

// City Markers component
function CityMarkers({ enabled = true }) {
    const map = useMap();
    const markersLayerRef = useRef(null);
    const [isZoomedIn, setIsZoomedIn] = useState(false);
    const [citySummaries, setCitySummaries] = useState({});
    const [isLoadingSummaries, setIsLoadingSummaries] = useState(true);

    // City data from the provided list
    const cities = [
        { name: "New York", state: "NY", lat: 40.66, lng: -73.94, population: 8478072 },
        { name: "Los Angeles", state: "CA", lat: 34.02, lng: -118.41, population: 3878704 },
        { name: "Chicago", state: "IL", lat: 41.84, lng: -87.68, population: 2721308 },
        { name: "Houston", state: "TX", lat: 29.79, lng: -95.39, population: 2390125 },
        { name: "Phoenix", state: "AZ", lat: 33.57, lng: -112.09, population: 1673164 },
        { name: "Philadelphia", state: "PA", lat: 40.01, lng: -75.13, population: 1573916 },
        { name: "San Antonio", state: "TX", lat: 29.46, lng: -98.52, population: 1526656 },
        { name: "San Diego", state: "CA", lat: 32.81, lng: -117.14, population: 1404452 },
        { name: "Dallas", state: "TX", lat: 32.79, lng: -96.77, population: 1326087 },
        { name: "Jacksonville", state: "FL", lat: 30.34, lng: -81.66, population: 1009833 },
        { name: "Fort Worth", state: "TX", lat: 32.78, lng: -97.35, population: 1008106 },
        { name: "San Jose", state: "CA", lat: 37.30, lng: -121.81, population: 997368 },
        { name: "Austin", state: "TX", lat: 30.30, lng: -97.75, population: 993588 },
        { name: "Charlotte", state: "NC", lat: 35.21, lng: -80.83, population: 943476 },
        { name: "Columbus", state: "OH", lat: 39.99, lng: -82.99, population: 933263 },
        { name: "Indianapolis", state: "IN", lat: 39.78, lng: -86.15, population: 891484 },
        { name: "San Francisco", state: "CA", lat: 37.73, lng: -123.03, population: 827526 },
        { name: "Seattle", state: "WA", lat: 47.62, lng: -122.35, population: 780995 },
        { name: "Denver", state: "CO", lat: 39.76, lng: -104.88, population: 729019 },
        { name: "Oklahoma City", state: "OK", lat: 35.47, lng: -97.51, population: 712919 },
        { name: "Nashville", state: "TN", lat: 36.17, lng: -86.79, population: 704963 },
        { name: "Washington", state: "DC", lat: 38.90, lng: -77.02, population: 702250 },
        { name: "El Paso", state: "TX", lat: 31.85, lng: -106.43, population: 681723 },
        { name: "Las Vegas", state: "NV", lat: 36.23, lng: -115.26, population: 678922 },
        { name: "Boston", state: "MA", lat: 42.36, lng: -71.06, population: 675647 }
    ];

    // Load pre-generated city summaries from JSON file
    useEffect(() => {
        const loadCitySummaries = async () => {
            try {
                setIsLoadingSummaries(true);
                const response = await fetch('/city_summaries.json');
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                const data = await response.json();
                setCitySummaries(data);
            } catch (error) {
                console.error('Error loading city summaries:', error);
            } finally {
                setIsLoadingSummaries(false);
            }
        };

        loadCitySummaries();
    }, []);

    useEffect(() => {
        // Function to check the zoom level and update visibility
        const updateMarkerVisibility = () => {
            const currentZoom = map.getZoom();
            setIsZoomedIn(currentZoom >= 6); // Show markers when zoom level is 6 or higher
        };

        // Add zoom event listener
        map.on('zoomend', updateMarkerVisibility);
        updateMarkerVisibility(); // Initialize visibility based on current zoom
        
        return () => {
            map.off('zoomend', updateMarkerVisibility);
        };
    }, [map]);

    useEffect(() => {
        // Only show markers if component is enabled and zoom level is appropriate
        if (!enabled) {
            if (markersLayerRef.current) {
                map.removeLayer(markersLayerRef.current);
                markersLayerRef.current = null;
            }
            return;
        }

        // Create markers layer if we're zoomed in enough
        if (isZoomedIn) {
            // Remove existing layer if any
            if (markersLayerRef.current) {
                map.removeLayer(markersLayerRef.current);
            }
            
            // Create a new layer group for the markers
            markersLayerRef.current = L.layerGroup();
            
            // Create a pane for the cities if it doesn't exist yet
            if (!map.getPane('cityPane')) {
                map.createPane('cityPane');
                map.getPane('cityPane').style.zIndex = 450; // Lower than popups (700) and detention center markers (650)
            }
            
            // Create markers for each city
            cities.forEach(city => {
                // Create a custom icon sized relative to population
                const markerIcon = L.divIcon({
                    html: `<div class="city-marker">i</div>`,
                    className: 'city-marker-container',
                    iconSize: [14, 14], // Size for info icon
                    iconAnchor: [7, 7]
                });
                
                // Create the marker with tooltip
                const marker = L.marker([city.lat, city.lng], {
                    icon: markerIcon,
                    pane: 'cityPane'
                }).bindTooltip(`${city.name}, ${city.state}`, {
                    direction: 'top',
                    offset: [0, -5],
                    className: 'city-tooltip'
                });
                
                // Create a popup for this marker
                const popup = L.popup({
                    maxWidth: 400,
                    className: 'city-summary-popup-container'
                });
                
                // Set up the click handler to fetch and display the city summary
                marker.on('click', async () => {
                    
                    // Show loading popup immediately
                    popup.setLatLng([city.lat, city.lng])
                         .setContent(`
                            <div class="city-summary-popup">
                                <div class="city-summary-title">${city.name}, ${city.state}</div>
                                <div class="city-summary-content">
                                    <div class="loading-spinner"></div>
                                    <p>Generating immigration activity summary...</p>
                                </div>
                            </div>
                         `)
                         .openOn(map);
                    
                    try {
                        if (isLoadingSummaries) {
                            // We're still loading the summaries file
                            popup.setContent(`
                                <div class="city-summary-popup">
                                    <div class="city-summary-title">${city.name}, ${city.state}</div>
                                    <div class="city-summary-content">
                                        <div class="loading-spinner"></div>
                                        <p>Loading immigration activity summary...</p>
                                    </div>
                                </div>
                            `);
                            return;
                        }
                        
                        // Use the pre-generated summaries we loaded from the JSON file
                        const existingSummary = citySummaries[city.name];
                        if (existingSummary) {
                            // Update popup with the existing pre-generated summary
                            popup.setContent(`
                                <div class="city-summary-popup">
                                    <div class="city-summary-title">${city.name}, ${city.state}</div>
                                    <div class="city-summary-content">${existingSummary.summary}</div>
                                    <div class="city-summary-footer">Generated: ${existingSummary.generated || 'Unknown'}</div>
                                </div>
                            `);
                        } else {
                            // If we don't have a pre-generated summary for this city
                            popup.setContent(`
                                <div class="city-summary-popup">
                                    <div class="city-summary-title">${city.name}, ${city.state}</div>
                                    <div class="city-summary-content">No pre-generated summary available for this city.</div>
                                </div>
                            `);
                        }
                    } catch (error) {
                        console.error('Error updating popup:', error);
                        popup.setContent(`
                            <div class="city-summary-popup">
                                <div class="city-summary-title">${city.name}, ${city.state}</div>
                                <div class="city-summary-content">
                                    <p class="error-message">Failed to load summary. Please try again later.</p>
                                </div>
                            </div>
                        `);
                    }
                });
                
                markersLayerRef.current.addLayer(marker);
            });
            
            map.addLayer(markersLayerRef.current);
        } else if (markersLayerRef.current) {
            // Remove the layer if we're not zoomed in enough
            map.removeLayer(markersLayerRef.current);
            markersLayerRef.current = null;
        }
        
        return () => {
            if (markersLayerRef.current) {
                map.removeLayer(markersLayerRef.current);
            }
        };
    }, [map, enabled, isZoomedIn, cities, citySummaries]);

    // We no longer need to fetch summaries dynamically since we're using pre-generated ones

    // We've replaced the custom popup control approach with standard Leaflet popups
    // This makes the implementation simpler and more reliable

    return null;
}

export default CityMarkers;
