import React, { useState, useEffect, useRef } from 'react';
import './UnifiedPanel.css';

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

function UnifiedPanel({ cursorPosition, arrestData, onMapClick, isMobile, onPanelStateChange }) {
    const [activeTab, setActiveTab] = useState('incidents'); // 'incidents' or 'news'
    const [isPanelMinimized, setIsPanelMinimized] = useState(false);
    const [touchStartY, setTouchStartY] = useState(null);
    const [touchStartTime, setTouchStartTime] = useState(null);

    // Incidents state
    const [nearbyIncidents, setNearbyIncidents] = useState([]);
    const [displayedIncidentCount, setDisplayedIncidentCount] = useState(20);
    const [loadingMoreIncidents, setLoadingMoreIncidents] = useState(false);
    const [persistentIncidents, setPersistentIncidents] = useState([]);
    const [isPersistent, setIsPersistent] = useState(false);
    const [lastClickCount, setLastClickCount] = useState(0);

    // News state
    const [articles, setArticles] = useState([]);
    const [loadingNews, setLoadingNews] = useState(true);
    const [allArticles, setAllArticles] = useState([]);
    const [displayedArticleCount, setDisplayedArticleCount] = useState(20);
    const [loadingMoreArticles, setLoadingMoreArticles] = useState(false);
    const [currentTime, setCurrentTime] = useState(new Date());

    const incidentsListRef = useRef(null);
    const articlesListRef = useRef(null);
    const incidentsContentRef = useRef(null);
    const newsContentRef = useRef(null);
    const panelRef = useRef(null);

    // Touch handlers for swipe-to-minimize
    const handleTouchStart = (e) => {
        if (!isMobile) return;
        setTouchStartY(e.touches[0].clientY);
        setTouchStartTime(Date.now());
    };

    const handleTouchMove = (e) => {
        if (!isMobile || !touchStartY) return;

        const currentY = e.touches[0].clientY;
        const deltaY = currentY - touchStartY;

        // If swiping down more than 50px, minimize the panel
        if (deltaY > 50) {
            setIsPanelMinimized(true);
            setTouchStartY(null);
        }
    };

    const handleTouchEnd = () => {
        if (!isMobile) return;

        const touchDuration = Date.now() - touchStartTime;

        // If it was a quick tap (less than 200ms) and minimal movement, don't minimize
        if (touchDuration < 200 && Math.abs(touchStartY - (touchStartY || 0)) < 10) {
            // This was likely a tap, not a swipe
        }

        setTouchStartY(null);
        setTouchStartTime(null);
    };

    const minimizePanel = () => {
        setIsPanelMinimized(true);
    };

    const restorePanel = () => {
        setIsPanelMinimized(false);
    };

    // Effect to restore panel when map is clicked
    useEffect(() => {
        if (isMobile && isPanelMinimized && onMapClick > lastClickCount) {
            restorePanel();
        }
        setLastClickCount(onMapClick);
    }, [onMapClick, isMobile, isPanelMinimized, lastClickCount]);

    // Clock effect for news
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);

        return () => clearInterval(timer);
    }, []);

    // Function to calculate distance between two points
    const calculateDistance = (lat1, lng1, lat2, lng2) => {
        const R = 6371; // Earth's radius in kilometers
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    };

    // Function to get cluster radius based on zoom level
    const getClusterRadius = (zoom) => {
        if (zoom >= 10) return 0.001; // Very close points at high zoom
        if (zoom >= 8) return 0.005;  // Close points at medium-high zoom
        if (zoom >= 6) return 0.02;   // Medium distance at medium zoom
        if (zoom >= 4) return 0.05;   // Further distance at low-medium zoom
        return 0.1;                   // Far distance at low zoom
    };

    // Effect to handle incidents based on cursor position
    useEffect(() => {
        if (!cursorPosition || !arrestData || arrestData.length === 0) {
            if (!isPersistent) {
                setNearbyIncidents([]);
                setDisplayedIncidentCount(20);
            }
            return;
        }

        // If we have persistent incidents, don't update based on cursor movement
        if (isPersistent) {
            return;
        }

        const { lat, lng, zoom } = cursorPosition;

        // Convert arrest data to points with proper filtering
        const points = arrestData
            .map(arrest => ({
                lat: parseFloat(arrest.latitude),
                lng: parseFloat(arrest.longitude),
                data: arrest
            }))
            .filter(point => !isNaN(point.lat) && !isNaN(point.lng));

        // Use zoom-aware search radius that decreases significantly as user zooms in
        // This provides more precise results at higher zoom levels
        let searchRadius;
        if (zoom >= 12) {
            searchRadius = 0.05; // Very precise at highest zoom
        } else if (zoom >= 10) {
            searchRadius = 0.1; // Precise at high zoom
        } else if (zoom >= 8) {
            searchRadius = 0.25; // Medium precision
        } else if (zoom >= 6) {
            searchRadius = 0.5; // Less precise at medium zoom
        } else if (zoom >= 4) {
            searchRadius = 1.0; // Generous at low-medium zoom
        } else {
            searchRadius = 2.0; // Very generous at low zoom
        }

        const nearby = points.filter(point => {
            const distance = Math.sqrt(
                Math.pow(lat - point.lat, 2) +
                Math.pow(lng - point.lng, 2)
            );
            return distance <= searchRadius;
        }).map(point => ({
            ...point.data,
            distance: calculateDistance(lat, lng, point.lat, point.lng)
        }));

        // Remove duplicates based on URL
        const uniqueIncidents = nearby.filter((incident, index, self) =>
            index === self.findIndex(i => i.url === incident.url)
        );

        // Sort by distance and limit to 100 closest incidents
        const sortedIncidents = uniqueIncidents
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 100);

        setNearbyIncidents(sortedIncidents);
        setDisplayedIncidentCount(20);
    }, [cursorPosition, arrestData, isPersistent]);

    // Effect to handle map clicks - toggle persistent mode (only when panel is not minimized)
    useEffect(() => {
        if (onMapClick > lastClickCount && !isPanelMinimized) {
            if (nearbyIncidents.length > 0) {
                if (!isPersistent) {
                    // First click - pause the current incidents and switch to incidents tab
                    setPersistentIncidents([...nearbyIncidents]);
                    setIsPersistent(true);
                    setActiveTab('incidents');
                    // Reset scroll position when switching via map click
                    setTimeout(() => {
                        if (incidentsContentRef.current) {
                            incidentsContentRef.current.scrollTop = 0;
                        }
                    }, 0);
                } else {
                    // Second click - unpause and clear
                    setPersistentIncidents([]);
                    setIsPersistent(false);
                }
            }
        }
        setLastClickCount(onMapClick);
    }, [onMapClick, nearbyIncidents, isPersistent, lastClickCount, isPanelMinimized]);

    // Load news articles
    useEffect(() => {
        const loadArticles = async () => {
            console.log('🔄 Starting to load articles from API...');
            try {
                // Load articles from the API endpoint instead of local CSV files
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

                const articles = lines.slice(1).map((line, index) => {
                    if (!line.trim()) return null; // Skip empty lines
                    const values = parseCSVLine(line);
                    const article = {};
                    headers.forEach((header, index) => {
                        article[header.trim()] = values[index] ? values[index].trim() : '';
                    });

                    // Extract latitude and longitude from coordinates field for articles
                    if (article.coordinates) {
                        try {
                            // Parse coordinates string like "{'lat': Decimal('38.8860434'), 'lon': Decimal('-76.999525')}"
                            const coordMatch = article.coordinates.match(/'lat':\s*Decimal\('([^']+)'\),\s*'lon':\s*Decimal\('([^']+)'\)/);
                            if (coordMatch) {
                                article.latitude = coordMatch[1];
                                article.longitude = coordMatch[2];
                            } else {
                                // Try alternative format
                                const simpleMatch = article.coordinates.match(/lat['"]?\s*:\s*([\d.-]+).*?lon['"]?\s*:\s*([\d.-]+)/);
                                if (simpleMatch) {
                                    article.latitude = simpleMatch[1];
                                    article.longitude = simpleMatch[2];
                                }
                            }
                        } catch (e) {
                            console.log('⚠️ Failed to parse coordinates for article:', article.coordinates);
                        }
                    }

                    return {
                        ...article,
                        source: 'API',
                        url: article.url || article.link,
                        title: article.title,
                        date: article.date
                    };
                }).filter(article => {
                    if (!article) return false;
                    const hasTitle = article.title && article.title.trim();
                    const hasUrl = (article.url || article.link) && (article.url || article.link).trim();
                    return hasTitle && hasUrl;
                });

                // Remove duplicates based on title field
                const uniqueArticles = articles.filter((article, index, self) => {
                    if (!article.title) return true; // Keep articles without titles
                    const firstIndex = self.findIndex(item => item.title === article.title);
                    return index === firstIndex;
                });

                console.log('✅ Successfully parsed articles:', {
                    totalRecords: articles.length,
                    uniqueRecords: uniqueArticles.length,
                    duplicatesRemoved: articles.length - uniqueArticles.length,
                    sampleRecord: uniqueArticles[0] || 'No records found'
                });

                // Debug: Show sample coordinates for articles
                if (uniqueArticles.length > 0) {
                    console.log('📍 Sample article coordinates field:', uniqueArticles[0].coordinates);
                    console.log('📍 Sample article parsed lat/lng:', {
                        latitude: uniqueArticles[0].latitude,
                        longitude: uniqueArticles[0].longitude
                    });
                }

                // Sort by date (newest first)
                const sortedArticles = uniqueArticles.sort((a, b) => {
                    const dateA = new Date(a.date);
                    const dateB = new Date(b.date);
                    return dateB - dateA;
                });

                // Deprioritize ice.gov articles: move them to the bottom, but keep date order within each group
                const nonIceArticles = sortedArticles.filter(article => !(article.url && article.url.includes('ice.gov')));
                const iceArticles = sortedArticles.filter(article => article.url && article.url.includes('ice.gov'));
                const combinedArticles = [...nonIceArticles, ...iceArticles];

                console.log('📊 Final article counts:', {
                    total: combinedArticles.length,
                    nonIce: nonIceArticles.length,
                    ice: iceArticles.length
                });

                setAllArticles(combinedArticles);
                setArticles(combinedArticles.slice(0, 20));
                setLoadingNews(false);
                console.log('💾 Articles loaded and set in state');
            } catch (error) {
                console.error('❌ Error loading articles:', error);
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
                setLoadingNews(false);
            }
        };

        loadArticles();
    }, []);

    // Use persistent incidents if available, otherwise use nearby incidents
    const currentIncidents = isPersistent ? persistentIncidents : nearbyIncidents;
    const displayedIncidents = currentIncidents.slice(0, displayedIncidentCount);

    const clearPersistentIncidents = () => {
        setPersistentIncidents([]);
        setIsPersistent(false);
        setNearbyIncidents([]);
        setDisplayedIncidentCount(20);
    };

    const loadMoreIncidents = async () => {
        if (loadingMoreIncidents || displayedIncidentCount >= currentIncidents.length) return;

        setLoadingMoreIncidents(true);
        await new Promise(resolve => setTimeout(resolve, 300));

        const nextBatch = currentIncidents.slice(displayedIncidentCount, displayedIncidentCount + 20);
        setDisplayedIncidentCount(prev => prev + 20);
        setLoadingMoreIncidents(false);
    };

    const loadMoreArticles = async () => {
        if (loadingMoreArticles || displayedArticleCount >= allArticles.length) return;

        setLoadingMoreArticles(true);
        await new Promise(resolve => setTimeout(resolve, 300));

        // Always apply deprioritization when loading more
        const nonIceArticles = allArticles.filter(article => !(article.url && article.url.includes('ice.gov')));
        const iceArticles = allArticles.filter(article => article.url && article.url.includes('ice.gov'));
        const sortedArticles = [...nonIceArticles, ...iceArticles];
        const nextBatch = sortedArticles.slice(displayedArticleCount, displayedArticleCount + 20);
        setArticles(prev => [...prev, ...nextBatch]);
        setDisplayedArticleCount(prev => prev + 20);
        setLoadingMoreArticles(false);
    };

    const handleIncidentsScroll = (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        const scrollableHeight = scrollHeight - clientHeight;
        const threshold = scrollableHeight * 0.1;

        if (scrollHeight - scrollTop <= clientHeight + threshold) {
            loadMoreIncidents();
        }
    };

    const handleArticlesScroll = (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        const scrollableHeight = scrollHeight - clientHeight;
        const threshold = scrollableHeight * 0.1;

        if (scrollHeight - scrollTop <= clientHeight + threshold) {
            loadMoreArticles();
        }
    };

    const handleTabSwitch = (newTab) => {
        if (newTab === 'news' && isPersistent) {
            // When switching to news tab, automatically unpause
            setPersistentIncidents([]);
            setIsPersistent(false);
        }

        setActiveTab(newTab);
    };

    // Effect to reset scroll position when tab changes
    useEffect(() => {
        // Use setTimeout to ensure DOM has been updated
        const timer = setTimeout(() => {
            if (activeTab === 'incidents' && incidentsContentRef.current) {
                incidentsContentRef.current.scrollTop = 0;
            } else if (activeTab === 'news' && newsContentRef.current) {
                newsContentRef.current.scrollTop = 0;
            }
        }, 0);

        return () => clearTimeout(timer);
    }, [activeTab]);

    const formatCoordinates = (lat, lng) => {
        if (lat === null || lng === null || lat === undefined || lng === undefined || isNaN(lat) || isNaN(lng)) {
            return 'No cursor data';
        }
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    };

    const formatDate = (dateString) => {
        try {
            const date = new Date(dateString);
            if (isNaN(date.getTime())) {
                return null;
            }
            return date.toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric'
            });
        } catch (error) {
            return null;
        }
    };

    const formatMilitaryTime = (date) => {
        return date.toLocaleTimeString('en-US', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    };

    // Notify parent when panel state changes
    useEffect(() => {
        if (onPanelStateChange) {
            onPanelStateChange(isPanelMinimized);
        }
    }, [isPanelMinimized, onPanelStateChange]);

    return (
        <>
            {/* Restore button for mobile when panel is minimized */}
            {isMobile && isPanelMinimized && (
                <button
                    className="mobile-restore-button"
                    onClick={restorePanel}
                    aria-label="Restore panel"
                >
                    <span className="restore-icon">▲</span>
                </button>
            )}

            <div
                className={`unified-panel ${isMobile ? 'mobile' : ''} ${isMobile && isPanelMinimized ? 'minimized' : ''}`}
                ref={panelRef}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                <div className="unified-panel-header">
                    {/* Minimize button for mobile */}
                    {isMobile && !isPanelMinimized && (
                        <button
                            className="mobile-minimize-button"
                            onClick={minimizePanel}
                            aria-label="Minimize panel"
                        >
                            <span className="minimize-icon">▼</span>
                        </button>
                    )}

                    {!isMobile && (
                        <div className="paused-indicator">
                            {activeTab === 'incidents'
                                ? (isPersistent ? 'Click to Unpause' : 'Click to Pause')
                                : 'News Feed'
                            }
                        </div>
                    )}
                    <div className="live-clock-container">
                        <span className="live-clock">{formatMilitaryTime(currentTime)}</span>
                    </div>
                    <div className="header-top">
                        <div className="tab-toggle">
                            <button
                                className={`tab-button ${activeTab === 'incidents' ? 'active' : ''}`}
                                onClick={() => handleTabSwitch('incidents')}
                            >
                                Incidents
                            </button>
                            <button
                                className={`tab-button ${activeTab === 'news' ? 'active' : ''}`}
                                onClick={() => handleTabSwitch('news')}
                            >
                                {isMobile ? 'Feed' : 'Live News Feed'}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="unified-panel-content">
                    {activeTab === 'incidents' ? (
                        <div className="incidents-content" ref={incidentsContentRef} onScroll={handleIncidentsScroll}>
                            {currentIncidents.length === 0 ? (
                                <div className="incidents-placeholder">
                                    <h4>No Nearby Incidents</h4>
                                    <p className="placeholder-text">
                                        {isMobile ? 'Tap to see nearby incidents' : 'Move your cursor over the map to see nearby incidents.'}
                                    </p>
                                </div>
                            ) : (
                                <div className="incidents-list" ref={incidentsListRef}>
                                    <div className="incidents-header">
                                        <h4>
                                            {isPersistent ? 'Incidents ' : 'Incidents in Range '}
                                            ({currentIncidents.length})
                                        </h4>
                                    </div>
                                    {displayedIncidents.map((incident, index) => (
                                        <div key={index} className="incident-item">
                                            <div className="incident-header">
                                                {formatDate(incident.date) && (
                                                    <span className="incident-date">{formatDate(incident.date)}</span>
                                                )}
                                            </div>
                                            <a
                                                href={incident.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="incident-title"
                                            >
                                                {incident.title || 'No title available'}
                                            </a>
                                        </div>
                                    ))}
                                    {loadingMoreIncidents && (
                                        <div className="loading-more">Loading more incidents...</div>
                                    )}
                                    {displayedIncidentCount >= currentIncidents.length && currentIncidents.length > 0 && (
                                        <div className="no-more-incidents">No more incidents to load</div>
                                    )}
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="news-content" ref={newsContentRef} onScroll={handleArticlesScroll}>
                            {loadingNews ? (
                                <div className="loading">Loading news...</div>
                            ) : (
                                <div className="articles-list" ref={articlesListRef}>
                                    {articles.map((article, index) => (
                                        <div key={index} className="article-item">
                                            <div className="article-header">
                                                {formatDate(article.date) && (
                                                    <span className="article-date">{formatDate(article.date)}</span>
                                                )}
                                            </div>
                                            <a
                                                href={article.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="article-title"
                                            >
                                                {article.title}
                                            </a>
                                        </div>
                                    ))}
                                    {loadingMoreArticles && (
                                        <div className="loading-more">Loading more articles...</div>
                                    )}
                                    {displayedArticleCount >= allArticles.length && allArticles.length > 0 && (
                                        <div className="no-more-articles">No more articles to load</div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
    );
}

export default UnifiedPanel; 