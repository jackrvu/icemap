import React, { useState, useEffect, useRef } from 'react';
import './NewsPanel.css';

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

function NewsPanel({ isMobile, onCollapseChange }) {
    const [articles, setArticles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCollapsed, setIsCollapsed] = useState(isMobile);
    const [allArticles, setAllArticles] = useState([]);
    const [displayedCount, setDisplayedCount] = useState(20);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentTime, setCurrentTime] = useState(new Date());
    const articlesListRef = useRef(null);

    // Clock effect
    useEffect(() => {
        const timer = setInterval(() => {
            setCurrentTime(new Date());
        }, 1000);

        return () => clearInterval(timer);
    }, []);

    // Notify parent of collapse state changes
    useEffect(() => {
        if (onCollapseChange) {
            onCollapseChange(isCollapsed);
        }
    }, [isCollapsed, onCollapseChange]);

    useEffect(() => {
        const loadArticles = async () => {
            console.log('🔄 Starting to load articles from API (NewsPanel)...');
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
                            console.log('⚠️ Failed to parse coordinates for article (NewsPanel):', article.coordinates);
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

                console.log('✅ Successfully parsed articles (NewsPanel):', {
                    totalRecords: articles.length,
                    sampleRecord: articles[0] || 'No records found'
                });

                // Debug: Show sample coordinates for articles
                if (articles.length > 0) {
                    console.log('📍 Sample article coordinates field (NewsPanel):', articles[0].coordinates);
                    console.log('📍 Sample article parsed lat/lng (NewsPanel):', {
                        latitude: articles[0].latitude,
                        longitude: articles[0].longitude
                    });
                }

                // Sort by date (newest first)
                const sortedArticles = articles.sort((a, b) => {
                    const dateA = new Date(a.date);
                    const dateB = new Date(b.date);
                    return dateB - dateA;
                });

                console.log('📊 Final article counts (NewsPanel):', {
                    total: sortedArticles.length
                });

                setAllArticles(sortedArticles);
                setArticles(sortedArticles.slice(0, 20));
                setLoading(false);
                console.log('💾 Articles loaded and set in state (NewsPanel)');
            } catch (error) {
                console.error('❌ Error loading articles (NewsPanel):', error);
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
                setLoading(false);
            }
        };

        loadArticles();
    }, []);

    const loadMoreArticles = async () => {
        if (loadingMore || displayedCount >= allArticles.length) return;

        setLoadingMore(true);

        // Simulate a small delay to show loading state
        await new Promise(resolve => setTimeout(resolve, 300));

        const nextBatch = allArticles.slice(displayedCount, displayedCount + 20);
        setArticles(prev => [...prev, ...nextBatch]);
        setDisplayedCount(prev => prev + 20);
        setLoadingMore(false);
    };

    const handleScroll = (e) => {
        const { scrollTop, scrollHeight, clientHeight } = e.target;
        const scrollableHeight = scrollHeight - clientHeight;
        const threshold = scrollableHeight * 0.1; // Load when within 10% of bottom

        // Calculate scroll percentage
        const scrollPercentage = Math.round((scrollTop / scrollableHeight) * 100);

        if (scrollHeight - scrollTop <= clientHeight + threshold) {
            loadMoreArticles();
        }
    };

    const toggleCollapse = () => {
        setIsCollapsed(!isCollapsed);
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

    if (loading) {
        return (
            <div className={`news-panel ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''}`}>
                <div className="news-collapse-handle" onClick={toggleCollapse}>
                    <span className="collapse-icon">{isCollapsed ? '▶' : '◀'}</span>
                </div>
                <div className="news-panel-header">
                    <div className={`header-content ${isMobile ? 'mobile' : ''}`}>
                        <h3>Live News Feed</h3>
                        <span className="live-clock">{formatMilitaryTime(currentTime)}</span>
                    </div>
                </div>
                {!isCollapsed && (
                    <div className="news-panel-content">
                        <div className="loading">Loading news...</div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={`news-panel ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''}`}>
            <div className="news-collapse-handle" onClick={toggleCollapse}>
                <span className="collapse-icon">{isCollapsed ? '◀' : '▶'}</span>
            </div>
            <div className="news-panel-header">
                <h3>Live News Feed</h3>
                <span className="live-clock">{formatMilitaryTime(currentTime)}</span>
            </div>
            {!isCollapsed && (
                <div className="news-panel-content" onScroll={handleScroll}>
                    <div
                        className="articles-list"
                        ref={articlesListRef}
                        onScroll={handleScroll}
                    >
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
                        {loadingMore && (
                            <div className="loading-more">Loading more articles...</div>
                        )}
                        {displayedCount >= allArticles.length && allArticles.length > 0 && (
                            <div className="no-more-articles">No more articles to load</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default NewsPanel; 