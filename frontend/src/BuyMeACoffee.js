import React from 'react';
import './BuyMeACoffee.css';

function BuyMeACoffee({ isMobile }) {
    const handleClick = () => {
        // Replace this URL with your actual Buy Me a Coffee link
        window.open('https://www.buymeacoffee.com/icemap', '_blank');
    };

    return (
        <div className={`buy-me-coffee ${isMobile ? 'mobile' : ''}`}>
            <button
                className="coffee-button"
                style={{ minWidth: 200 }}
                onClick={handleClick}
                title="Support this project with a coffee!"
            >
                <span className="coffee-icon">☕</span>
                <span className="coffee-text">support icemap</span>
            </button>
        </div>
    );
}

export default BuyMeACoffee; 