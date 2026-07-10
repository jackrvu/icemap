import React, { useState, useEffect, useMemo } from 'react';
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

const GETCSV_URL = 'https://zo8ywjgau3.execute-api.us-east-2.amazonaws.com/default/getCSV';

function App() {
    const [arrestData, setArrestData] = useState([]);
    const [heatmapPoints, setHeatmapPoints] = useState([]);
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
    const [timeRange, setTimeRange] = useState('all'); // '7' | '30' | '90' | 'all' (days)
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

    // Load article data (recent articles for news feed + incidents panel)
    useEffect(() => {
        const parseCSVToArrestData = (csvText) => {
            const lines = csvText.split('\n');
            if (lines.length === 0) throw new Error('No CSV lines found');
            const headers = parseCSVLine(lines[0]);
            const parsedData = lines.slice(1).map((line) => {
                if (!line.trim()) return null;
                const values = parseCSVLine(line);
                const arrest = {};
                headers.forEach((header, i) => {
                    arrest[header.trim()] = values[i] ? values[i].trim() : '';
                });
                if (arrest.coordinates) {
                    try {
                        const coordMatch = arrest.coordinates.match(/'lat':\s*Decimal\('([^']+)'\),\s*'lon':\s*Decimal\('([^']+)'\)/);
                        if (coordMatch) {
                            arrest.latitude = coordMatch[1];
                            arrest.longitude = coordMatch[2];
                        } else {
                            const simpleMatch = arrest.coordinates.match(/lat['"]?\s*:\s*([\d.-]+).*?lon['"]?\s*:\s*([\d.-]+)/);
                            if (simpleMatch) {
                                arrest.latitude = simpleMatch[1];
                                arrest.longitude = simpleMatch[2];
                            }
                        }
                    } catch (e) { /* ignore */ }
                }
                return arrest;
            }).filter(arrest => {
                if (!arrest) return false;
                const pub = arrest.publisher || '';
                if (!pub || pub.toLowerCase() === 'unknown') return false;
                return arrest.latitude && !isNaN(parseFloat(arrest.latitude)) &&
                       arrest.longitude && !isNaN(parseFloat(arrest.longitude));
            });
            const seen = new Set();
            return parsedData.filter(a => {
                const key = a.url || a.title;
                if (!key) return true;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        };

        const decodeApiResponse = async (response) => {
            const rawText = await response.text();
            try {
                const data = JSON.parse(rawText);
                if (data.statusCode === 200 && data.isBase64Encoded && data.body) {
                    return base64ToUtf8(data.body);
                }
            } catch (e) { /* not JSON */ }
            return base64ToUtf8(rawText.trim());
        };

        const loadArrestData = async () => {
            setDataLoadingStatus(prev => ({ ...prev, arrestData: true }));
            let loaded = false;
            try {
                const response = await fetch(GETCSV_URL);
                if (response.ok) {
                    setArrestData(parseCSVToArrestData(await decodeApiResponse(response)));
                    loaded = true;
                }
            } catch (e) { /* fall through */ }

            if (!loaded) {
                try {
                    const res = await fetch('/aggregated_incidents.csv');
                    if (res.ok) setArrestData(parseCSVToArrestData(await res.text()));
                } catch (e) { console.error('Error loading arrest data (fallback):', e.message); }
            }
            setDataLoadingStatus(prev => ({ ...prev, arrestData: false }));
        };

        // Load full historical heatmap points (all articles, just lat/lng)
        const loadHeatmapPoints = async () => {
            try {
                const response = await fetch(`${GETCSV_URL}?type=heatmap`);
                if (response.ok) {
                    const rawText = await response.text();
                    let points;
                    try {
                        const data = JSON.parse(rawText);
                        if (data.statusCode === 200 && data.isBase64Encoded && data.body) {
                            points = JSON.parse(base64ToUtf8(data.body));
                        } else {
                            points = data;
                        }
                    } catch (e) {
                        points = JSON.parse(base64ToUtf8(rawText.trim()));
                    }
                    if (Array.isArray(points)) setHeatmapPoints(points);
                }
            } catch (e) { /* heatmap is non-critical, silently skip */ }
        };

        loadArrestData();
        loadHeatmapPoints();
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

    // Filter incidents to the selected time range (map + panel + feed)
    const filteredArrestData = useMemo(() => {
        if (timeRange === 'all') return arrestData;
        const cutoff = Date.now() - parseInt(timeRange) * 24 * 60 * 60 * 1000;
        return arrestData.filter(a => {
            const t = new Date(a.date).getTime();
            return !isNaN(t) && t >= cutoff;
        });
    }, [arrestData, timeRange]);

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
                arrestData={filteredArrestData}
                loadingData={dataLoadingStatus.arrestData}
                onMapClick={mapClickCount}
                isMobile={isMobile}
                onPanelStateChange={setIsPanelMinimized}
            />
            <MapComponent
                arrestData={filteredArrestData}
                heatmapPoints={timeRange === 'all' ? heatmapPoints : []}
                inspectionData={inspectionData}
                onCursorMove={handleCursorMove}
                onMapClick={handleMapClick}
                onInspectionPinClick={handleInspectionPinClick}
                showDetentionPins={showDetentionPins}
                onToggleDetentionPins={() => setShowDetentionPins(!showDetentionPins)}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
            />
        </div>
    );
}

export default App; 