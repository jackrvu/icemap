import React, { useState, useEffect } from 'react';
import MapComponent from './MapComponent';
import InfoModal from './InfoModal';
import InspectionModal from './InspectionModal';
import UnifiedPanel from './UnifiedPanel';
import BuyMeACoffee from './BuyMeACoffee';
import ContactInfo from './components/ContactInfo';
import pako from 'pako';
import './App.css';

// Helper function to detect mobile devices
function isMobileDevice() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
        window.innerWidth <= 768;
}

// Helper function to properly parse CSV lines with quoted fields
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];

        if (char === '"') {
            if (inQuotes && line[i + 1] === '"') {
                // Escaped quote
                current += '"';
                i++; // Skip next quote
            } else {
                // Toggle quote state
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // End of field
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    // Add the last field
    result.push(current.trim());

    return result;
}

// Helper function to parse JSONL file
function parseJSONL(text) {
    const lines = text.trim().split('\n');
    return lines
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (error) {
                console.warn('Failed to parse JSONL line:', line);
                return null;
            }
        })
        .filter(item => item !== null);
}

function App() {
    const [arrestData, setArrestData] = useState([]);
    const [inspectionData, setInspectionData] = useState([]);
    const [loading, setLoading] = useState(false); // Changed to false to show map immediately
    const [showModal, setShowModal] = useState(true);
    const [showInspectionModal, setShowInspectionModal] = useState(false);
    const [selectedInspection, setSelectedInspection] = useState(null);
    const [cursorPosition, setCursorPosition] = useState(null);
    const [mapClickCount, setMapClickCount] = useState(0);
    const [isMobile, setIsMobile] = useState(false);
    const [dataLoadingStatus, setDataLoadingStatus] = useState({
        arrestData: false,
        inspectionData: false
    });

    // Detect mobile device on mount and window resize
    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(isMobileDevice());
        };

        // Check on mount
        checkMobile();

        // Listen for window resize
        window.addEventListener('resize', checkMobile);

        return () => {
            window.removeEventListener('resize', checkMobile);
        };
    }, []);

    // Load arrest data asynchronously
    useEffect(() => {
        const loadArrestData = async () => {
            setDataLoadingStatus(prev => ({ ...prev, arrestData: true }));
            try {
                const arrestResponse = await fetch('/arrests_with_titles.csv');
                const arrestCsvText = await arrestResponse.text();

                // Parse CSV with proper handling of quoted fields
                const lines = arrestCsvText.split('\n');
                const headers = parseCSVLine(lines[0]);

                const arrestData = lines.slice(1).map(line => {
                    if (!line.trim()) return null; // Skip empty lines
                    const values = parseCSVLine(line);
                    const arrest = {};
                    headers.forEach((header, index) => {
                        arrest[header.trim()] = values[index] ? values[index].trim() : '';
                    });
                    return arrest;
                }).filter(arrest =>
                    arrest &&
                    arrest.latitude &&
                    arrest.longitude &&
                    !isNaN(parseFloat(arrest.latitude)) &&
                    !isNaN(parseFloat(arrest.longitude))
                );

                setArrestData(arrestData);
            } catch (error) {
                console.error('Error loading arrest data:', error);
            } finally {
                setDataLoadingStatus(prev => ({ ...prev, arrestData: false }));
            }
        };

        loadArrestData();
    }, []);

    // Load inspection data asynchronously
    useEffect(() => {
        const loadInspectionData = async () => {
            setDataLoadingStatus(prev => ({ ...prev, inspectionData: true }));
            try {
                const inspectionResponse = await fetch('/facilities_with_coordinates_results.jsonl.gz');

                if (!inspectionResponse.ok) {
                    throw new Error(`HTTP error! status: ${inspectionResponse.status}`);
                }

                const compressedData = await inspectionResponse.arrayBuffer();
                const decompressedData = pako.inflate(compressedData, { to: 'string' });
                const allInspectionData = parseJSONL(decompressedData);

                // Filter for entries with name_similarity_score > 0.9
                const filteredInspectionData = allInspectionData.filter(facility =>
                    facility.name_similarity_score > 0.9 &&
                    facility.location_latitude &&
                    facility.location_longitude &&
                    !isNaN(parseFloat(facility.location_latitude)) &&
                    !isNaN(parseFloat(facility.location_longitude))
                );

                setInspectionData(filteredInspectionData);
            } catch (error) {
                console.error('Error loading inspection data:', error);
            } finally {
                setDataLoadingStatus(prev => ({ ...prev, inspectionData: false }));
            }
        };

        loadInspectionData();
    }, []);

    const closeModal = () => {
        setShowModal(false);
    };

    const handleCursorMove = (position) => {
        setCursorPosition(position);
    };

    const handleMapClick = () => {
        setMapClickCount(prev => prev + 1);
    };

    const handleInspectionPinClick = (inspection) => {
        setSelectedInspection(inspection);
        setShowInspectionModal(true);
    };

    const closeInspectionModal = () => {
        setShowInspectionModal(false);
        setSelectedInspection(null);
    };

    // Show loading indicator only if both datasets are still loading
    const isLoading = dataLoadingStatus.arrestData && dataLoadingStatus.inspectionData;

    if (isLoading) {
        return (
            <div className="loading">
                <h2>Loading data...</h2>
            </div>
        );
    }

    return (
        <div className="App">
            <InfoModal isOpen={showModal} onClose={closeModal} />
            <InspectionModal
                isOpen={showInspectionModal}
                onClose={closeInspectionModal}
                inspectionData={selectedInspection}
            />
            <ContactInfo />
            <BuyMeACoffee isMobile={isMobile} />
            <UnifiedPanel
                cursorPosition={cursorPosition}
                arrestData={arrestData}
                onMapClick={mapClickCount}
                isMobile={isMobile}
            />
            <MapComponent
                arrestData={arrestData}
                inspectionData={inspectionData}
                onCursorMove={handleCursorMove}
                onMapClick={handleMapClick}
                onInspectionPinClick={handleInspectionPinClick}
            />
        </div>
    );
}

export default App; 