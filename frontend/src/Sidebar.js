import React from 'react';
import './Sidebar.css';

function Sidebar({ isOpen, incidents, onClose }) {
    if (!isOpen || !incidents || incidents.length === 0) {
        return null;
    }

    return (
        <div className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
            <div className="sidebar-header">
                <h2>{incidents.length} Incident{incidents.length !== 1 ? 's' : ''} in this area</h2>
                <button className="close-button" onClick={onClose}>
                    ×
                </button>
            </div>

            <div className="sidebar-content">
                {incidents.map((incident, index) => (
                    <div key={index} className="incident-card">
                        {incident.url ? (
                            <a
                                href={incident.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="location-link"
                            >
                                {incident.location || 'Unknown Location'}
                            </a>
                        ) : (
                            <span className="location-text">
                                {incident.location || 'Unknown Location'}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

export default Sidebar; 