import React, { useState, useEffect } from 'react';
import MapComponent from './MapComponent';
import InfoModal from './InfoModal';
import DonationModal from './DonationModal';
import InspectionModal from './InspectionModal';
import UnifiedPanel from './UnifiedPanel';
import BuyMeACoffee from './BuyMeACoffee';
import ShareButton from './ShareButton';
import ContactInfo from './components/ContactInfo';
import MobileButtonBar from './MobileButtonBar';
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

// Helper function to decode base64 to UTF-8
function base64ToUtf8(base64) {
    const binaryString = atob(base64);
    const bytes = Uint8Array.from(binaryString, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
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
    const [showModal, setShowModal] = useState(false);
    const [showDonationModal, setShowDonationModal] = useState(false);
    const [showInspectionModal, setShowInspectionModal] = useState(false);
    const [selectedInspection, setSelectedInspection] = useState(null);
    const [cursorPosition, setCursorPosition] = useState(null);
    const [mapClickCount, setMapClickCount] = useState(0);
    const [isMobile, setIsMobile] = useState(false);
    const [showDetentionPins, setShowDetentionPins] = useState(() => !isMobileDevice());
    const [isPanelMinimized, setIsPanelMinimized] = useState(false);
    const [dataLoadingStatus, setDataLoadingStatus] = useState({
        arrestData: false,
        inspectionData: false
    });

    // Visit tracking logic
    useEffect(() => {
        const visitCount = localStorage.getItem('icemap_visit_count');
        const currentCount = visitCount ? parseInt(visitCount) : 0;
        const newCount = currentCount + 1;

        localStorage.setItem('icemap_visit_count', newCount.toString());

        // Show info modal on first visit, donation modal on second visit
        if (newCount === 1) {
            setShowModal(true);
        } else if (newCount === 2) {
            setShowDonationModal(true);
        }
    }, []);

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
            console.log('🔄 Starting to load arrest data from API...');
            setDataLoadingStatus(prev => ({ ...prev, arrestData: true }));
            try {
                console.log('📡 Fetching from API endpoint: https://zo8ywjgau3.execute-api.us-east-2.amazonaws.com/default/getCSV');
                const response = await fetch('https://zo8ywjgau3.execute-api.us-east-2.amazonaws.com/default/getCSV');

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                console.log('✅ API response received, status:', response.status);
                const rawText = await response.text();
                console.log('📄 Raw response length:', rawText.length, 'characters');

                let csvText;
                try {
                    console.log('🔍 Attempting to parse as JSON...');
                    // Try to parse as JSON (API returns JSON with base64 body)
                    const data = JSON.parse(rawText);
                    console.log('📊 Parsed JSON data:', {
                        statusCode: data.statusCode,
                        isBase64Encoded: data.isBase64Encoded,
                        bodyLength: data.body ? data.body.length : 0
                    });

                    if (data.statusCode !== 200 || !data.isBase64Encoded || !data.body) {
                        throw new Error('Invalid response format from API');
                    }
                    console.log('🔓 Decoding base64 body...');
                    csvText = base64ToUtf8(data.body);
                    console.log('📋 Decoded CSV length:', csvText.length, 'characters');
                } catch (e) {
                    console.log('⚠️ JSON parsing failed, treating as raw base64:', e.message);
                    // If not JSON, treat as raw base64-encoded CSV
                    csvText = base64ToUtf8(rawText.trim());
                    console.log('📋 Decoded raw CSV length:', csvText.length, 'characters');
                }

                // Parse CSV with proper handling of quoted fields
                console.log('🔍 Parsing CSV lines...');
                const lines = csvText.split('\n');
                console.log('📊 Total CSV lines:', lines.length);

                if (lines.length === 0) {
                    throw new Error('No CSV lines found');
                }

                const headers = parseCSVLine(lines[0]);
                console.log('📋 CSV headers:', headers);

                const arrestData = lines.slice(1).map((line, index) => {
                    if (!line.trim()) return null; // Skip empty lines
                    const values = parseCSVLine(line);
                    const arrest = {};
                    headers.forEach((header, index) => {
                        arrest[header.trim()] = values[index] ? values[index].trim() : '';
                    });

                    // Extract latitude and longitude from coordinates field
                    if (arrest.coordinates) {
                        try {
                            // Parse coordinates string like "{'lat': Decimal('38.8860434'), 'lon': Decimal('-76.999525')}"
                            const coordMatch = arrest.coordinates.match(/'lat':\s*Decimal\('([^']+)'\),\s*'lon':\s*Decimal\('([^']+)'\)/);
                            if (coordMatch) {
                                arrest.latitude = coordMatch[1];
                                arrest.longitude = coordMatch[2];
                            } else {
                                // Try alternative format
                                const simpleMatch = arrest.coordinates.match(/lat['"]?\s*:\s*([\d.-]+).*?lon['"]?\s*:\s*([\d.-]+)/);
                                if (simpleMatch) {
                                    arrest.latitude = simpleMatch[1];
                                    arrest.longitude = simpleMatch[2];
                                }
                            }
                        } catch (e) {
                            console.log('⚠️ Failed to parse coordinates:', arrest.coordinates);
                        }
                    }

                    return arrest;
                }).filter(arrest => {
                    if (!arrest) return false;
                    const hasLat = arrest.latitude && !isNaN(parseFloat(arrest.latitude));
                    const hasLng = arrest.longitude && !isNaN(parseFloat(arrest.longitude));
                    return hasLat && hasLng;
                });

                // Remove duplicates based on title field
                const uniqueArrestData = arrestData.filter((arrest, index, self) => {
                    if (!arrest.title) return true; // Keep records without titles
                    const firstIndex = self.findIndex(item => item.title === arrest.title);
                    return index === firstIndex;
                });

                console.log('✅ Successfully parsed arrest data:', {
                    totalRecords: arrestData.length,
                    uniqueRecords: uniqueArrestData.length,
                    duplicatesRemoved: arrestData.length - uniqueArrestData.length,
                    sampleRecord: uniqueArrestData[0] || 'No records found'
                });

                // Debug: Show sample coordinates
                if (uniqueArrestData.length > 0) {
                    console.log('📍 Sample coordinates field:', uniqueArrestData[0].coordinates);
                    console.log('📍 Sample parsed lat/lng:', {
                        latitude: uniqueArrestData[0].latitude,
                        longitude: uniqueArrestData[0].longitude
                    });
                }

                setArrestData(uniqueArrestData);
                console.log('💾 Arrest data set in state');
            } catch (error) {
                console.error('❌ Error loading arrest data:', error);
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
            } finally {
                console.log('🏁 Finished loading arrest data');
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

    const closeDonationModal = () => {
        setShowDonationModal(false);
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

    // Debug logging for arrest data
    useEffect(() => {
        console.log('📊 Current arrest data state:', {
            arrestDataLength: arrestData.length,
            isLoading: isLoading,
            dataLoadingStatus: dataLoadingStatus
        });

        if (arrestData.length > 0) {
            console.log('📍 Sample arrest record:', arrestData[0]);
        }
    }, [arrestData, isLoading, dataLoadingStatus]);

    if (isLoading) {
        console.log('⏳ Showing loading screen...');
        return (
            <div className="loading">
                <h2>Loading data...</h2>
            </div>
        );
    }

    return (
        <div className="App">
            <InfoModal isOpen={showModal} onClose={closeModal} />
            <DonationModal isOpen={showDonationModal} onClose={closeDonationModal} />
            <InspectionModal
                isOpen={showInspectionModal}
                onClose={closeInspectionModal}
                inspectionData={selectedInspection}
            />
            <ContactInfo isMobile={isMobile} />
            <ShareButton isMobile={isMobile} />
            <BuyMeACoffee isMobile={isMobile} />
            <MobileButtonBar
                isMobile={isMobile}
                showDetentionPins={showDetentionPins}
                onToggleDetentionPins={() => setShowDetentionPins(!showDetentionPins)}
                isPanelMinimized={isPanelMinimized}
            />
            <UnifiedPanel
                cursorPosition={cursorPosition}
                arrestData={arrestData}
                onMapClick={mapClickCount}
                isMobile={isMobile}
                onPanelStateChange={setIsPanelMinimized}
            />
            <MapComponent
                arrestData={arrestData}
                inspectionData={inspectionData}
                onCursorMove={handleCursorMove}
                onMapClick={handleMapClick}
                onInspectionPinClick={handleInspectionPinClick}
                showDetentionPins={showDetentionPins}
                onToggleDetentionPins={() => setShowDetentionPins(!showDetentionPins)}
            />
        </div>
    );
}

export default App; 